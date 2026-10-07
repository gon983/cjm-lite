package app

import (
	"bytes"
	"database/sql"
	"fmt"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/encoding/unicode/utf32"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCSVImportFormatsAndHeaders(t *testing.T) {
	a, _, _ := fixture(t)
	cases := []struct {
		name, content                          string
		headers, imported, duplicates, invalid int
	}{
		{"csv-renamed.xlsx", "Apellido,Nombre,DNI,,,,,Email\nPerez,Ana,32.280.055,,,,,ANA@example.com\n", 1, 1, 0, 0},
		{"semicolon.csv", "\ufeffAPELLIDO;NOMBRE;DNI;;;;;EMAIL\r\nGarcia;Juan;32 280 056;;;;;juan@example.com\r\nApellido;Nombre;DNI;;;;;Email\r\n", 2, 1, 0, 0},
		{"reordered.csv", "Email;DNI;Nombre;Apellido\nrosa@example.com;32280057;\"Rosa; María\";Pérez\n", 1, 1, 0, 0},
		{"legacy-header.csv", "\nApellido,Nombre,Matrícula,,,,,Email\nPerez,Ana,32280055,,,,,ana@example.com\n", 1, 0, 1, 0},
		{"partial-header.csv", "Apellido,Nombre,Documento,,,,,Correo electrónico\n\"Pérez, Lopez\",María,32280058,,,,,maria@example.com\nApellido,Nombre,,,,,,\n", 2, 1, 0, 0},
		{"no-header.csv", "Perez,Diego,32280059,,,,,diego@example.com\nInvalid,Bad,AB123,,,,,bad@example.com\n", 0, 1, 0, 1},
		{"tab.csv", "Apellido\tNombre\tDNI\tEmail\nSilva\tSol\t32280060\tsol@example.com\n", 1, 1, 0, 0},
		{"sep.csv", "sep=;\r\nApellido;Nombre;DNI;Email\r\nLopez;Luis;32280061;luis@example.com\r\n", 1, 1, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), c.name)
			if e := os.WriteFile(path, []byte(c.content), 0600); e != nil {
				t.Fatal(e)
			}
			s, e := a.Import(path)
			if e != nil {
				t.Fatal(e)
			}
			if s.Headers != c.headers || s.Imported != c.imported || s.Duplicates != c.duplicates || s.Invalid != c.invalid {
				t.Fatalf("%+v", s)
			}
		})
	}
	var name string
	a.DB.QueryRow("SELECT nombre FROM whitelist WHERE dni='32280057'").Scan(&name)
	if name != "Rosa; María" {
		t.Fatal("quoted separator broken", name)
	}
}
func TestCSVEncodings(t *testing.T) {
	a, _, _ := fixture(t)
	text := "Apellido;Nombre;DNI;Email\nPérez;María;32280062;maria62@example.com\n"
	cp, e := charmap.Windows1252.NewEncoder().Bytes([]byte(text))
	if e != nil {
		t.Fatal(e)
	}
	utf16, e := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().Bytes([]byte(strings.ReplaceAll(text, "32280062", "32280063")))
	if e != nil {
		t.Fatal(e)
	}
	for i, data := range [][]byte{cp, utf16} {
		path := filepath.Join(t.TempDir(), "padron.csv")
		os.WriteFile(path, data, 0600)
		s, e := a.Import(path)
		if e != nil || s.Imported != 1 {
			t.Fatal(i, s, e)
		}
	}
	var name string
	a.DB.QueryRow("SELECT nombre FROM whitelist WHERE dni='32280063'").Scan(&name)
	if name != "María" {
		t.Fatal("encoding corrupted", name)
	}
}
func TestCSVFailuresRollback(t *testing.T) {
	a, _, _ := fixture(t)
	for _, data := range [][]byte{nil, []byte("not a spreadsheet"), {0xd0, 0xcf, 0x11, 0xe0}, bytes.Repeat([]byte("x"), maxImportBytes+1), []byte("Apellido;Nombre;DNI;Email\nPerez;Ana;32280064;ana64@example.com\n\"broken;quote\n")} {
		path := filepath.Join(t.TempDir(), "input.xlsx")
		os.WriteFile(path, data, 0600)
		if _, e := a.Import(path); e == nil {
			t.Fatal("bad input accepted")
		}
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM whitelist WHERE dni='32280064'").Scan(&n)
	if n != 0 {
		t.Fatal("partial CSV persisted")
	}
}
func TestDNINormalizationRegistrationAndLogin(t *testing.T) {
	a, _, _ := fixture(t)
	for raw, want := range map[string]string{"32.280.055": "32280055", " 32 280 055 ": "32280055", "032280055": "32280055", "000": ""} {
		if got := normalizeDNI(raw); got != want {
			t.Fatal(raw, got, want)
		}
	}
	for _, bad := range []string{"AB123", "322800550", "32-280-055", "", "12a34"} {
		if validDNI(bad) {
			t.Fatal("invalid DNI accepted", bad)
		}
	}
	a.DB.Exec("INSERT INTO whitelist(dni,nombre,apellido,email) VALUES('32280055','Ana','Perez','ana@example.com')")
	id, e := a.Register("32.280.055", "3511234567", "a-long-test-password", "mediadores/test.jpg")
	if e != nil {
		t.Fatal(e)
	}
	if got, e := a.Authenticate("32.280.055", "a-long-test-password"); e != nil || got != id {
		t.Fatal("formatted DNI login failed", got, e)
	}
	if _, e := a.Register("032280055", "3511234567", "a-long-test-password", "mediadores/test.jpg"); e == nil {
		t.Fatal("normalized duplicate allowed")
	}
}
func TestDNIMigrationPreservesLegacyData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, e := sql.Open("sqlite3", path+"?_foreign_keys=on&_txlock=immediate")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	for _, file := range []string{"migrations/001_initial.sql", "migrations/002_indexes.sql"} {
		b, e := migrations.ReadFile(file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(string(b)); e != nil {
			t.Fatal(e)
		}
	}
	db.Exec("INSERT INTO schema_migrations VALUES(2)")
	_, e = db.Exec("INSERT INTO users(id,role,username,matricula,nombre,password,created_at,updated_at) VALUES(1,'MEDIADOR','32280055','32280055','Ana',X'01','today','today')")
	if e != nil {
		t.Fatal(e)
	}
	db.Exec("INSERT INTO whitelist VALUES('32280056','Luis','Lopez','luis@example.com')")
	db.Exec("INSERT INTO whitelist VALUES('DNI','Nombre','Apellido','email@example.com')")
	if e = migrate(db); e != nil {
		t.Fatal(e)
	}
	var dni, name string
	if e = db.QueryRow("SELECT dni,nombre FROM users WHERE id=1").Scan(&dni, &name); e != nil || dni != "32280055" || name != "Ana" {
		t.Fatal("user lost", dni, name, e)
	}
	var n int
	db.QueryRow("SELECT count(*) FROM whitelist").Scan(&n)
	if n != 1 {
		t.Fatal("header not removed or pending DNI lost", n)
	}
	if e = migrate(db); e != nil {
		t.Fatal("migration not idempotent", e)
	}
}

func TestCSVUnicodeWithoutBOMAndUTF32(t *testing.T) {
	a, _, _ := fixture(t)
	encodings := []struct {
		name     string
		encoding encoding.Encoding
	}{{"utf16-le", unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)}, {"utf16-be", unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)}, {"utf32-le", utf32.UTF32(utf32.LittleEndian, utf32.IgnoreBOM)}, {"utf32-be", utf32.UTF32(utf32.BigEndian, utf32.IgnoreBOM)}, {"utf32-le-bom", utf32.UTF32(utf32.LittleEndian, utf32.UseBOM)}, {"utf32-be-bom", utf32.UTF32(utf32.BigEndian, utf32.UseBOM)}}
	for i, c := range encodings {
		t.Run(c.name, func(t *testing.T) {
			dni := fmt.Sprint(32280100 + i)
			text := "Apellido\tNombre\tDNI\tEmail\r\nPérez\tMaría\t" + dni + "\tmaria@example.com\r\n"
			data, e := c.encoding.NewEncoder().Bytes([]byte(text))
			if e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(t.TempDir(), "padron.csv")
			os.WriteFile(path, data, 0600)
			s, e := a.Import(path)
			if e != nil || s.Imported != 1 || s.Headers != 1 {
				t.Fatal(s, e)
			}
			var last, first string
			e = a.DB.QueryRow("SELECT apellido,nombre FROM whitelist WHERE dni=?", dni).Scan(&last, &first)
			if e != nil || last != "Pérez" || first != "María" {
				t.Fatal("Unicode damaged", last, first, e)
			}
		})
	}
}
func TestCSVNULNotSilentlyRemoved(t *testing.T) {
	for _, data := range [][]byte{[]byte("Apellido;Nombre;DNI;Email\nPerez;Ana;32\x00280055;ana@example.com\n"), {0xff, 0xfe, 'A', 0, 'B'}} {
		if _, e := decodeCSV(data); e == nil {
			t.Fatal("ambiguous/corrupt data accepted")
		}
	}
}
