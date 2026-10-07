package app

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type News struct {
	ID                          int64
	Title, Content, Image, Date string
	Published                   bool
}

func (a *App) readNews(admin bool) ([]News, error) { return a.readNewsPage(admin, 1) }
func (a *App) readNewsPage(admin bool, page int) ([]News, error) {
	q := "SELECT id,title,content,image,publication_date,published FROM news"
	args := []any{}
	if !admin {
		q += " WHERE published=1 AND publication_date<=?"
		args = append(args, a.now().Format("2006-01-02"))
	}
	q += " ORDER BY publication_date DESC,id DESC LIMIT 51 OFFSET ?"
	args = append(args, (page-1)*50)
	rows, e := a.DB.Query(q, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []News{}
	for rows.Next() {
		var n News
		if e = rows.Scan(&n.ID, &n.Title, &n.Content, &n.Image, &n.Date, &n.Published); e != nil {
			return nil, e
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
func (a *App) home(w http.ResponseWriter, r *http.Request) {
	u := current(r)
	news, e := a.readNews(false)
	if e != nil {
		a.error(w, r, e)
		return
	}
	data := map[string]any{"News": news}
	if u.Role == "ADMIN" {
		today := a.now().Format("2006-01-02")
		rows, e := a.DB.Query("SELECT state,count(*) FROM mediations WHERE date=? GROUP BY state", today)
		if e != nil {
			a.error(w, r, e)
			return
		}
		counts := map[string]int{}
		total := 0
		for rows.Next() {
			var s string
			var n int
			if e = rows.Scan(&s, &n); e != nil {
				break
			}
			counts[s] = n
			total += n
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close()
		if e != nil {
			a.error(w, r, e)
			return
		}
		var pending int
		var oldest string
		if e = a.DB.QueryRow("SELECT count(DISTINCT date),coalesce(min(date),'') FROM mediations WHERE date<? AND exported_at IS NULL", today).Scan(&pending, &oldest); e != nil {
			a.error(w, r, e)
			return
		}
		var blockDate, reason string
		a.DB.QueryRow("SELECT date,reason FROM blocked_days WHERE date>=? ORDER BY date LIMIT 1", today).Scan(&blockDate, &reason)
		data["Counts"] = counts
		data["Total"] = total
		data["Pending"] = pending
		data["Oldest"] = oldest
		data["BlockDate"] = blockDate
		data["Reason"] = reason
		a.render(w, r, "Dashboard", dashboardTemplate, data)
	} else {
		rows, e := a.DB.Query(medSelect+"WHERE (m.m1=? OR m.m2=?) AND m.date>=? AND m.state<>'CANCELADA_POR_ADMIN' ORDER BY m.date,m.start LIMIT 5", u.ID, u.ID, a.now().Format("2006-01-02"))
		if e != nil {
			a.error(w, r, e)
			return
		}
		ms, e := scanM(rows)
		rows.Close()
		if e != nil {
			a.error(w, r, e)
			return
		}
		data["Mediations"] = ms
		a.render(w, r, "Inicio", homeTemplate, data)
	}
}
func pageNumber(r *http.Request) int {
	n := int(number(r.URL.Query().Get("page")))
	if n < 1 {
		n = 1
	}
	if n > 100000 {
		n = 100000
	}
	return n
}
func (a *App) adminMediations(w http.ResponseWriter, r *http.Request) {
	date := dateInput(r.URL.Query().Get("date"))
	if date == "" {
		date = a.now().Format("2006-01-02")
	}
	if !validDate(date) {
		a.error(w, r, errors.New("Fecha inválida."))
		return
	}
	state := r.URL.Query().Get("state")
	result := r.URL.Query().Get("result")
	page := pageNumber(r)
	q := medSelect + "WHERE m.date=?"
	args := []any{date}
	if state != "" {
		q += " AND m.state=?"
		args = append(args, state)
	}
	if result != "" {
		q += " AND m.result=?"
		args = append(args, result)
	}
	q += " ORDER BY m.start,m.id LIMIT 51 OFFSET ?"
	args = append(args, (page-1)*50)
	rows, e := a.DB.Query(q, args...)
	if e != nil {
		a.error(w, r, e)
		return
	}
	ms, e := scanM(rows)
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	more := len(ms) > 50
	if more {
		ms = ms[:50]
	}
	var pending int
	a.DB.QueryRow("SELECT count(*) FROM mediations WHERE date=? AND exported_at IS NULL", date).Scan(&pending)
	a.render(w, r, "Mediaciones del día", adminMTemplate, map[string]any{"Mediations": ms, "Date": date, "State": state, "Result": result, "Yesterday": a.now().AddDate(0, 0, -1).Format("2006-01-02"), "Tomorrow": a.now().AddDate(0, 0, 1).Format("2006-01-02"), "Pending": pending, "Past": date < a.now().Format("2006-01-02"), "Page": page, "PrevPage": page - 1, "NextPage": page + 1, "More": more})
}
func (a *App) editPage(w http.ResponseWriter, r *http.Request) {
	id := number(r.URL.Query().Get("id"))
	rows, e := a.DB.Query(medSelect+"WHERE m.id=?", id)
	if e != nil {
		a.error(w, r, e)
		return
	}
	ms, e := scanM(rows)
	rows.Close()
	if e != nil || len(ms) != 1 {
		a.error(w, r, errors.New("Mediación no encontrada."))
		return
	}
	users, e := a.activeMediators()
	if e != nil {
		a.error(w, r, e)
		return
	} // Include historical inactive participants so status-only edits keep their assignment.
	for _, pair := range []struct {
		ID        int64
		Name, Mat string
	}{{ms[0].M1, ms[0].Name1, ms[0].DNI1}, {ms[0].M2, ms[0].Name2, ms[0].DNI2}} {
		found := false
		for _, u := range users {
			if u.ID == pair.ID {
				found = true
			}
		}
		if !found {
			users = append(users, User{ID: pair.ID, Nombre: pair.Name, DNI: pair.Mat})
		}
	}
	a.render(w, r, "Editar mediación", editTemplate, map[string]any{"M": ms[0], "Mediators": users})
}
func (a *App) edit(w http.ResponseWriter, r *http.Request) {
	m := formM(r)
	if e := a.EditDetails(current(r).ID, m); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/mediaciones", "Mediación actualizada.")
}
func (a *App) users(w http.ResponseWriter, r *http.Request) {
	role := "MEDIADOR"
	if r.URL.Query().Get("role") == "ADMIN" {
		role = "ADMIN"
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	page := pageNumber(r)
	rows, e := a.DB.Query("SELECT id,role,username,coalesce(dni,''),nombre,apellido,email,telefono,photo,active FROM users WHERE role=? AND (nombre||' '||apellido LIKE ? OR dni LIKE ? OR email LIKE ? OR username LIKE ?) ORDER BY apellido,nombre LIMIT 51 OFFSET ?", role, "%"+q+"%", "%"+q+"%", "%"+q+"%", "%"+q+"%", (page-1)*50)
	if e != nil {
		a.error(w, r, e)
		return
	}
	var users []User
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Role, &u.Username, &u.DNI, &u.Nombre, &u.Apellido, &u.Email, &u.Telefono, &u.Photo, &u.Active); e != nil {
			break
		}
		users = append(users, u)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	more := len(users) > 50
	if more {
		users = users[:50]
	}
	a.render(w, r, "Usuarios", usersTemplate, map[string]any{"Users": users, "Role": role, "Q": q, "Page": page, "PrevPage": page - 1, "NextPage": page + 1, "More": more})
}
func (a *App) manageUser(w http.ResponseWriter, r *http.Request) {
	if e := a.ManageUser(current(r).ID, number(r.FormValue("id")), r.FormValue("action"), r.FormValue("password")); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/usuarios", "Usuario actualizado. Sus sesiones fueron invalidadas.")
}
func (a *App) createAdmin(w http.ResponseWriter, r *http.Request) {
	if e := a.CreateAdmin(current(r).ID, r.FormValue("name"), r.FormValue("username"), r.FormValue("password")); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/usuarios", "Administrador creado.")
}
func (a *App) blocks(w http.ResponseWriter, r *http.Request) {
	rows, e := a.DB.Query("SELECT sede,date,reason FROM blocked_days ORDER BY date DESC LIMIT 200")
	if e != nil {
		a.error(w, r, e)
		return
	}
	type block struct{ Sede, Date, Reason string }
	var bs []block
	for rows.Next() {
		var b block
		if e = rows.Scan(&b.Sede, &b.Date, &b.Reason); e != nil {
			break
		}
		bs = append(bs, b)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	a.render(w, r, "Días bloqueados", blocksTemplate, map[string]any{"Blocks": bs})
}
func (a *App) block(w http.ResponseWriter, r *http.Request) {
	if e := a.Block(current(r).ID, r.FormValue("sede"), r.FormValue("date"), r.FormValue("reason"), r.FormValue("action") == "unblock"); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/bloqueos", "Calendario actualizado. Desbloquear no restaura reservas canceladas.")
}
func (a *App) newsPage(w http.ResponseWriter, r *http.Request) {
	page := pageNumber(r)
	ns, e := a.readNewsPage(true, page)
	if e != nil {
		a.error(w, r, e)
		return
	}

	more := len(ns) > 50
	if more {
		ns = ns[:50]
	}
	var edit News
	if id := number(r.URL.Query().Get("id")); id != 0 {
		e = a.DB.QueryRow("SELECT id,title,content,image,publication_date,published FROM news WHERE id=?", id).Scan(&edit.ID, &edit.Title, &edit.Content, &edit.Image, &edit.Date, &edit.Published)
		if e != nil {
			a.error(w, r, errors.New("Noticia no encontrada."))
			return
		}
	}
	a.render(w, r, "Noticias", newsTemplate, map[string]any{"News": ns, "Edit": edit, "Page": page, "PrevPage": page - 1, "NextPage": page + 1, "More": more})

}
func (a *App) newsSave(w http.ResponseWriter, r *http.Request) {
	id := number(r.FormValue("id"))
	action := r.FormValue("action")
	image := ""
	if action != "delete" {
		if strings.TrimSpace(r.FormValue("title")) == "" || strings.TrimSpace(r.FormValue("content")) == "" || len(r.FormValue("title")) > 200 || len(r.FormValue("content")) > 20000 || !validDate(r.FormValue("date")) {
			a.error(w, r, errors.New("Complete título, contenido y fecha válida."))
			return
		}
		file, _, e := r.FormFile("image")
		if e == nil {
			defer file.Close()
			image, e = a.Image(file, "news")
			if e != nil {
				a.error(w, r, e)
				return
			}
		} else if e != http.ErrMissingFile {
			a.error(w, r, e)
			return
		}
	}
	tx, e := a.DB.Begin()
	if e != nil {
		a.error(w, r, e)
		return
	}
	defer tx.Rollback()
	if e = requireAdmin(tx, current(r).ID); e == nil {
		if action == "delete" {
			_, e = tx.Exec("DELETE FROM news WHERE id=?", id)
		} else if id == 0 {
			_, e = tx.Exec("INSERT INTO news(title,content,image,published,publication_date,updated_at) VALUES(?,?,?,?,?,?)", r.FormValue("title"), r.FormValue("content"), image, r.FormValue("published") == "1", r.FormValue("date"), stamp())
		} else {
			_, e = tx.Exec("UPDATE news SET title=?,content=?,image=CASE WHEN ?='' THEN image ELSE ? END,published=?,publication_date=?,updated_at=? WHERE id=?", r.FormValue("title"), r.FormValue("content"), image, image, r.FormValue("published") == "1", r.FormValue("date"), stamp(), id)
		}
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/noticias", "Noticia actualizada.")
}
func (a *App) whitelist(w http.ResponseWriter, r *http.Request) {
	page := pageNumber(r)
	rows, e := a.DB.Query("SELECT dni,nombre,apellido,email FROM whitelist ORDER BY apellido,nombre LIMIT 51 OFFSET ?", (page-1)*50)
	if e != nil {
		a.error(w, r, e)
		return
	}
	var us []User
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.DNI, &u.Nombre, &u.Apellido, &u.Email); e != nil {
			break
		}
		us = append(us, u)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	more := len(us) > 50
	if more {
		us = us[:50]
	}
	a.render(w, r, "DNI habilitados pendientes", whitelistTemplate, map[string]any{"Users": us, "Page": page, "PrevPage": page - 1, "NextPage": page + 1, "More": more})
}
func (a *App) importFile(w http.ResponseWriter, r *http.Request) {
	file, _, e := r.FormFile("xlsx")
	if e != nil {
		a.error(w, r, e)
		return
	}
	defer file.Close()
	tmp, e := os.CreateTemp(filepath.Join(a.Dir, "database"), "import-*.xlsx")
	if e != nil {
		a.error(w, r, e)
		return
	}
	defer os.Remove(tmp.Name())
	n, copyErr := io.Copy(tmp, io.LimitReader(file, maxImportBytes+1))
	e = copyErr
	if closeErr := tmp.Close(); e == nil {
		e = closeErr
	}
	if n > maxImportBytes {
		e = errors.New("El archivo supera el límite de 6 MB.")
	}
	if e != nil {
		a.error(w, r, e)
		return
	}
	s, e := a.Import(tmp.Name())
	if e != nil {
		a.error(w, r, e)
		return
	}
	a.render(w, r, "Resultado de importación", `<section class="card"><h2>Importación completada</h2><p>Leídas: {{.S.Read}} · Importadas: {{.S.Imported}} · Duplicadas: {{.S.Duplicates}} · Inválidas: {{.S.Invalid}} · Encabezados omitidos: {{.S.Headers}}</p>{{range .S.Errors}}<p>{{.}}</p>{{end}}<a href="/admin/dnis">Volver a DNI</a></section>`, map[string]any{"S": s})
}
func (a *App) exports(w http.ResponseWriter, r *http.Request) {
	page := pageNumber(r)
	rows, e := a.DB.Query("SELECT id,date_from,date_to,created_at,filename,count FROM exports ORDER BY id DESC LIMIT 51 OFFSET ?", (page-1)*50)
	if e != nil {
		a.error(w, r, e)
		return
	}
	type exp struct {
		ID                      int64
		From, To, Created, File string
		Count                   int
	}
	var es []exp
	for rows.Next() {
		var x exp
		if e = rows.Scan(&x.ID, &x.From, &x.To, &x.Created, &x.File, &x.Count); e != nil {
			break
		}
		es = append(es, x)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	more := len(es) > 50
	if more {
		es = es[:50]
	}
	var pending int
	var oldest string
	a.DB.QueryRow("SELECT count(*),coalesce(min(date),'') FROM mediations WHERE exported_at IS NULL").Scan(&pending, &oldest)
	a.render(w, r, "Exportaciones", exportsTemplate, map[string]any{"Exports": es, "Pending": pending, "Oldest": oldest, "Page": page, "PrevPage": page - 1, "NextPage": page + 1, "More": more})
}
func (a *App) export(w http.ResponseWriter, r *http.Request) {
	name, e := a.Export(current(r).ID, r.FormValue("from"), r.FormValue("to"))
	if e != nil {
		a.error(w, r, e)
		return
	}
	http.Redirect(w, r, "/admin/descargar/"+name, 303)
}
func (a *App) download(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	var n int
	if filepath.Base(name) != name {
		http.NotFound(w, r)
		return
	}
	if e := a.DB.QueryRow("SELECT count(*) FROM exports WHERE filename=?", name).Scan(&n); e != nil || n == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	http.ServeFile(w, r, filepath.Join(a.Dir, "exports", name))
}
func (a *App) audits(w http.ResponseWriter, r *http.Request) {
	page := pageNumber(r)
	rows, e := a.DB.Query("SELECT a.created_at,coalesce(u.username,'CLI'),a.action,a.entity,coalesce(a.entity_id,0),a.detail FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 51 OFFSET ?", (page-1)*50)
	if e != nil {
		a.error(w, r, e)
		return
	}
	type entry struct {
		Date, Actor, Action, Entity string
		ID                          int64
		Detail                      string
	}
	var es []entry
	for rows.Next() {
		var x entry
		if e = rows.Scan(&x.Date, &x.Actor, &x.Action, &x.Entity, &x.ID, &x.Detail); e != nil {
			break
		}
		es = append(es, x)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	more := len(es) > 50
	if more {
		es = es[:50]
	}
	a.render(w, r, "Auditoría", auditTemplate, map[string]any{"Entries": es, "Page": page, "PrevPage": page - 1, "NextPage": page + 1, "More": more})
}
