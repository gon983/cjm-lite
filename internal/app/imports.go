package app

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/encoding/unicode/utf32"
	"golang.org/x/text/transform"
)

const maxImportBytes = 6 << 20
const maxImportRows = 20000

type ImportSummary struct {
	Read, Imported, Duplicates, Invalid, Headers int
	Errors                                       []string
}
type importColumns struct{ Last, First, DNI, Email int }

// Default layout without a header: A apellido, B nombre, C DNI, H email.
var ImportColumns = importColumns{0, 1, 2, 7}

type importRows struct {
	next  func() ([]string, error)
	close func() error
}

func openImport(path string) (importRows, error) {
	f, e := os.Open(path)
	if e != nil {
		return importRows{}, e
	}
	stat, e := f.Stat()
	if e != nil {
		f.Close()
		return importRows{}, e
	}
	if stat.Size() > maxImportBytes {
		f.Close()
		return importRows{}, errors.New("El archivo supera el límite de 6 MB.")
	}
	if stat.Size() == 0 {
		f.Close()
		return importRows{}, errors.New("El archivo está vacío.")
	}
	prefix := make([]byte, 512)
	n, e := f.Read(prefix)
	if e != nil && e != io.EOF {
		f.Close()
		return importRows{}, e
	}
	prefix = prefix[:n]
	if bytes.HasPrefix(prefix, []byte{'P', 'K'}) {
		f.Close()
		book, e := excelize.OpenFile(path, excelize.Options{UnzipSizeLimit: 32 << 20, UnzipXMLSizeLimit: 8 << 20})
		if e != nil {
			return importRows{}, fmt.Errorf("El XLSX no es válido o está dañado. Exporte nuevamente desde Excel o use CSV: %w", e)
		}
		sheets := book.GetSheetList()
		if len(sheets) == 0 {
			book.Close()
			return importRows{}, errors.New("El archivo no tiene hojas.")
		}
		rows, e := book.Rows(sheets[0])
		if e != nil {
			book.Close()
			return importRows{}, e
		}
		return importRows{next: func() ([]string, error) {
			if !rows.Next() {
				if e := rows.Error(); e != nil {
					return nil, e
				}
				return nil, io.EOF
			}
			return rows.Columns()
		}, close: func() error {
			e := rows.Close()
			other := book.Close()
			if e != nil {
				return e
			}
			return other
		}}, nil
	}
	if bytes.HasPrefix(prefix, []byte{0xd0, 0xcf, 0x11, 0xe0}) {
		f.Close()
		return importRows{}, errors.New("El archivo es XLS antiguo o está cifrado. Guárdelo como CSV o XLSX sin contraseña; cambiar la extensión no lo convierte.")
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		f.Close()
		return importRows{}, e
	}
	// Read bounded CSV data to normalize common spreadsheet encodings.
	data, e := io.ReadAll(io.LimitReader(f, maxImportBytes+1))
	f.Close()
	if e != nil {
		return importRows{}, e
	}
	if len(data) > maxImportBytes {
		return importRows{}, errors.New("El archivo supera el límite de 6 MB.")
	}
	data, e = decodeCSV(data)
	if e != nil {
		return importRows{}, e
	}
	// Excel sometimes prepends a separator directive (sep=;).
	delimiter := rune(0)
	br := bufio.NewReader(bytes.NewReader(data))
	line, _ := br.ReadString('\n')
	directive := strings.TrimSpace(line)
	if len(directive) == 5 && strings.HasPrefix(strings.ToLower(directive), "sep=") {
		delimiter = rune(directive[4])
		data = data[len(line):]
	}
	if delimiter == 0 {
		best := 0
		for _, candidate := range []rune{';', ',', '\t', '|'} {
			r := csv.NewReader(bytes.NewReader(data))
			r.Comma = candidate
			r.FieldsPerRecord = -1
			record, e := r.Read()
			if e == nil && len(record) > best {
				delimiter = candidate
				best = len(record)
			}
		}
		if best < 2 {
			return importRows{}, errors.New("No se reconocen columnas en el CSV. Use coma, punto y coma o tabulación como separador.")
		}
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = delimiter
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true
	return importRows{next: r.Read, close: func() error { return nil }}, nil
}
func headerName(s string) string {
	s = strings.TrimSpace(strings.TrimPrefix(s, "\ufeff"))
	s = strings.ToLower(s)
	s = strings.NewReplacer("á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", ".", "", "_", " ").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}
func columnsFromHeader(row []string) (importColumns, bool, bool) {
	c := importColumns{-1, -1, -1, -1}
	for i, v := range row {
		switch headerName(v) {
		case "apellido", "apellidos":
			c.Last = i
		case "nombre", "nombres":
			c.First = i
		case "dni", "documento", "nro documento", "numero de documento", "numero documento", "matricula":
			c.DNI = i
		case "email", "e-mail", "mail", "correo", "correo electronico":
			c.Email = i
		}
	}
	isHeader := c.Last >= 0 && c.First >= 0
	return c, isHeader, isHeader && c.DNI >= 0 && c.Email >= 0
}
func (a *App) Import(path string) (ImportSummary, error) {
	var s ImportSummary
	rows, e := openImport(path)
	if e != nil {
		return s, e
	}
	defer rows.close()
	tx, e := a.DB.Begin()
	if e != nil {
		return s, e
	}
	defer tx.Rollback()
	c := ImportColumns
	for i := 0; ; i++ {
		row, e := rows.next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return s, fmt.Errorf("No se pudo leer la fila %d: %w", i+1, e)
		}
		if i >= maxImportRows {
			return s, errors.New("El archivo supera el límite de 20.000 filas; divídalo en archivos menores.")
		}
		empty := true
		for _, v := range row {
			if strings.TrimSpace(v) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		if mapped, header, complete := columnsFromHeader(row); header {
			s.Headers++
			if complete {
				c = mapped
			}
			continue
		}
		s.Read++
		maxColumn := max(c.Last, c.First, c.DNI, c.Email)
		if len(row) <= maxColumn {
			s.Invalid++
			s.Errors = append(s.Errors, fmt.Sprintf("Fila %d: faltan columnas (apellido, nombre, DNI y email)", i+1))
			continue
		}
		last := strings.Join(strings.Fields(row[c.Last]), " ")
		first := strings.Join(strings.Fields(row[c.First]), " ")
		dni := normalizeDNI(row[c.DNI])
		email := strings.ToLower(strings.TrimSpace(row[c.Email]))
		if last == "" || first == "" || len(last) > 100 || len(first) > 100 || !validDNI(dni) || !validEmail(email) {
			s.Invalid++
			s.Errors = append(s.Errors, fmt.Sprintf("Fila %d: nombre, DNI numérico o email inválido", i+1))
			continue
		}
		res, e := tx.Exec("INSERT OR IGNORE INTO whitelist(dni,nombre,apellido,email) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users WHERE dni=?)", dni, first, last, email, dni)
		if e != nil {
			return s, e
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			s.Duplicates++
		} else {
			s.Imported++
		}
	}
	return s, tx.Commit()
}

// Detect spreadsheet text encodings before interpreting NUL bytes as binary data.
// Without a BOM require a strong alternating-zero pattern, rather than stripping NULs.
func decodeCSV(data []byte) ([]byte, error) {
	var decoder transform.Transformer
	width := 1
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xfe, 0, 0}) || bytes.HasPrefix(data, []byte{0, 0, 0xfe, 0xff}):
		decoder = utf32.UTF32(utf32.LittleEndian, utf32.ExpectBOM).NewDecoder()
		width = 4
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}) || bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		decoder = unicode.UTF16(unicode.LittleEndian, unicode.ExpectBOM).NewDecoder()
		width = 2
	case looksUTF32(data, true):
		decoder = utf32.UTF32(utf32.LittleEndian, utf32.IgnoreBOM).NewDecoder()
		width = 4
	case looksUTF32(data, false):
		decoder = utf32.UTF32(utf32.BigEndian, utf32.IgnoreBOM).NewDecoder()
		width = 4
	case looksUTF16(data, true):
		decoder = unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder()
		width = 2
	case looksUTF16(data, false):
		decoder = unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder()
		width = 2
	case !utf8.Valid(data):
		decoder = charmap.Windows1252.NewDecoder()
	}
	if len(data)%width != 0 {
		return nil, errors.New("El CSV tiene una secuencia Unicode incompleta. Vuelva a guardarlo como CSV UTF-8.")
	}
	if decoder != nil {
		var e error
		data, e = io.ReadAll(transform.NewReader(bytes.NewReader(data), decoder))
		if e != nil {
			return nil, errors.New("No se pudo decodificar el CSV. Vuelva a guardarlo como CSV UTF-8.")
		}
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if bytes.IndexByte(data, 0) >= 0 {
		return nil, errors.New("Se encontraron caracteres nulos y no se pudo reconocer la codificación. Guarde el archivo como CSV UTF-8 o adjúntelo para revisar su formato.")
	}
	return data, nil
}
func looksUTF16(data []byte, little bool) bool {
	sample := data
	if len(sample) > 4096 {
		sample = sample[:4096]
	}
	pairs := len(sample) / 2
	if pairs < 4 {
		return false
	}
	low, high := 0, 0
	for i := 0; i+1 < len(sample); i += 2 {
		a, b := sample[i], sample[i+1]
		if !little {
			a, b = b, a
		}
		if a == 0 {
			low++
		}
		if b == 0 {
			high++
		}
	}
	return high > pairs/2 && low*4 < high
}
func looksUTF32(data []byte, little bool) bool {
	sample := data
	if len(sample) > 4096 {
		sample = sample[:4096]
	}
	units := len(sample) / 4
	if units < 4 {
		return false
	}
	matches, letters := 0, 0
	for i := 0; i+3 < len(sample); i += 4 {
		a, b, c, d := sample[i], sample[i+1], sample[i+2], sample[i+3]
		if !little {
			a, b, c, d = d, c, b, a
		}
		if b == 0 && c == 0 && d == 0 {
			matches++
			if a != 0 {
				letters++
			}
		}
	}
	return matches > units*3/4 && letters > units/4
}
