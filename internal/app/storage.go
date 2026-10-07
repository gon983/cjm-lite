package app

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"github.com/xuri/excelize/v2"
	"golang.org/x/image/draw"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
)

const maxUpload = 5 << 20

var imageWork = make(chan struct{}, 2)

func (a *App) Image(r io.Reader, kind string) (string, error) {
	select {
	case imageWork <- struct{}{}:
		defer func() { <-imageWork }()
	default:
		return "", errors.New("Hay otras imágenes en procesamiento. Intente nuevamente.")
	}
	if kind != "mediadores" && kind != "news" {
		return "", errors.New("Destino de imagen inválido.")
	}
	data, e := io.ReadAll(io.LimitReader(r, maxUpload+1))
	if e != nil {
		return "", e
	}
	if len(data) > maxUpload {
		return "", errors.New("La imagen supera 5 MB.")
	}
	config, format, e := image.DecodeConfig(bytes.NewReader(data))
	if e != nil || (format != "jpeg" && format != "png") || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 20_000_000 {
		return "", errors.New("Use una imagen JPEG o PNG de hasta 20 megapíxeles.")
	}
	src, _, e := image.Decode(bytes.NewReader(data))
	if e != nil {
		return "", e
	}
	w, h := config.Width, config.Height
	if w > 800 || h > 800 {
		if w >= h {
			h = h * 800 / w
			w = 800
		} else {
			w = w * 800 / h
			h = 800
		}
	}
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)
	name := kind + "/" + randomToken() + ".jpg"
	f, e := os.OpenFile(filepath.Join(a.Dir, "uploads", name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return "", e
	}
	e = jpeg.Encode(f, dst, &jpeg.Options{Quality: 80})
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		os.Remove(f.Name())
		return "", e
	}
	return name, nil
}

func (a *App) Export(actor int64, from, to string) (string, error) {
	if !validDate(from) || !validDate(to) || from > to {
		return "", errors.New("Rango de fechas inválido.")
	}
	tx, e := a.DB.Begin()
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	if e = requireAdmin(tx, actor); e != nil {
		return "", e
	}
	rows, e := tx.Query(medSelect+"WHERE m.date BETWEEN ? AND ? ORDER BY m.date,m.start,m.id", from, to)
	if e != nil {
		return "", e
	}
	ms, e := scanM(rows)
	rows.Close()
	if e != nil {
		return "", e
	}
	f := excelize.NewFile()
	defer f.Close()
	headers := []any{"ID", "Fecha", "Hora", "Sede", "Carátula", "Expediente", "Mediador 1", "DNI 1", "Mediador 2", "DNI 2", "Estado", "Resultado", "Creada", "Modificada"}
	if e = f.SetSheetRow("Sheet1", "A1", &headers); e != nil {
		return "", e
	}
	for i, m := range ms {
		v := []any{m.ID, dateES(m.Date), m.Start, m.Sede, m.Title, m.Case, m.Name1, m.DNI1, m.Name2, m.DNI2, m.State, m.Result, a.timestampES(m.Created), a.timestampES(m.Updated)}
		if e = f.SetSheetRow("Sheet1", fmt.Sprintf("A%d", i+2), &v); e != nil {
			return "", e
		}
	}
	name := "mediaciones-" + from + "-" + to + "-" + randomToken()[:16] + ".xlsx"
	path := filepath.Join(a.Dir, "exports", name)
	if e = f.SaveAs(path); e != nil {
		return "", e
	}
	committed := false
	defer func() {
		if !committed {
			os.Remove(path)
		}
	}()
	ts := stamp()
	r, e := tx.Exec("INSERT INTO exports(date_from,date_to,created_at,admin_id,filename,count) VALUES(?,?,?,?,?,?)", from, to, ts, actor, name, len(ms))
	if e != nil {
		return "", e
	}
	id, _ := r.LastInsertId()
	if _, e = tx.Exec("UPDATE mediations SET exported_at=?,export_id=? WHERE date BETWEEN ? AND ?", ts, id, from, to); e != nil {
		return "", e
	}
	if e = audit(tx, actor, "EXPORT", "exports", id, fmt.Sprintf("%d registros", len(ms))); e != nil {
		return "", e
	}
	e = tx.Commit()
	committed = e == nil
	return name, e
}
func (a *App) Backup() (string, error) {
	name := filepath.Join(a.Dir, "backups", "backup-"+randomToken()[:16]+".tar.gz")
	snapshot := filepath.Join(a.Dir, "backups", randomToken()+".sqlite")
	defer os.Remove(snapshot)
	var e error
	if _, e = a.DB.Exec("VACUUM INTO ?", snapshot); e != nil {
		return "", e
	}
	out, e := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return "", e
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	add := func(path, relative string) error {
		f, e := os.Open(path)
		if e != nil {
			return e
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil {
			return e
		}
		h, e := tar.FileInfoHeader(info, "")
		if e != nil {
			return e
		}
		h.Name = relative
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		_, e = io.Copy(tw, f)
		return e
	}
	e = add(snapshot, "database/app.sqlite")
	if e == nil {
		for _, dir := range []string{"uploads", "exports"} {
			e = filepath.Walk(filepath.Join(a.Dir, dir), func(path string, info os.FileInfo, err error) error {
				if err != nil {
					return err
				}
				if info.IsDir() {
					return nil
				}
				relative, _ := filepath.Rel(a.Dir, path)
				return add(path, relative)
			})
			if e != nil {
				break
			}
		}
	}
	if e == nil {
		if _, err := os.Stat(filepath.Join(a.Dir, "session-secret")); err == nil {
			e = add(filepath.Join(a.Dir, "session-secret"), "session-secret")
		}
	}
	for _, err := range []error{tw.Close(), gz.Close(), out.Close()} {
		if e == nil {
			e = err
		}
	}
	if e != nil {
		os.Remove(name)
	}
	return name, e
}
