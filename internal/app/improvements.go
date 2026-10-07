package app

import (
	"errors"
	"golang.org/x/text/unicode/norm"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
)

func dateInput(s string) string {
	s = strings.TrimSpace(s)
	if t, e := time.Parse("02/01/2006", s); e == nil {
		return t.Format("2006-01-02")
	}
	return s
}

var datePattern = regexp.MustCompile(`[0-9]{4}-[0-9]{2}-[0-9]{2}`)

func detailES(s string) string { return datePattern.ReplaceAllStringFunc(s, dateES) }
func dateES(s string) string {
	t, e := time.Parse("2006-01-02", s)
	if e != nil {
		return s
	}
	return t.Format("02/01/2006")
}
func (a *App) timestampES(s string) string {
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return s
	}
	return t.In(a.Location).Format("02/01/2006 15:04")
}
func searchText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Mn, r) {
			return -1
		}
		return unicode.ToLower(r)
	}, norm.NFD.String(s))
}
func (a *App) mediatorSearch(w http.ResponseWriter, r *http.Request) {
	users, e := a.activeMediators()
	if e != nil {
		a.error(w, r, e)
		return
	}
	terms := strings.Fields(searchText(r.URL.Query().Get("q")))
	out := []User{}
	for _, u := range users {
		if u.ID == current(r).ID {
			continue
		}
		text := searchText(u.Apellido + " " + u.Nombre + " " + u.DNI)
		match := true
		for _, term := range terms {
			if !strings.Contains(text, term) {
				match = false
				break
			}
		}
		if match {
			out = append(out, u)
			if len(out) == 50 {
				break
			}
		}
	}
	a.render(w, r, "Buscar mediador", mediatorPickerTemplate, map[string]any{"Mediators": out})
}
func (a *App) EnableDNI(actor int64, dni, first, last, email string) error {
	dni = normalizeDNI(dni)
	first = strings.Join(strings.Fields(first), " ")
	last = strings.Join(strings.Fields(last), " ")
	email = strings.ToLower(strings.TrimSpace(email))
	if !validDNI(dni) || first == "" || last == "" || len(first) > 100 || len(last) > 100 || !validEmail(email) {
		return errors.New("Complete DNI numérico, nombre, apellido y email válidos.")
	}
	tx, e := a.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = requireAdmin(tx, actor); e != nil {
		return e
	}
	var n int
	if e = tx.QueryRow("SELECT (SELECT count(*) FROM users WHERE dni=?)+(SELECT count(*) FROM whitelist WHERE dni=?)", dni, dni).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return errors.New("Ese DNI ya está habilitado o registrado.")
	}
	if _, e = tx.Exec("INSERT INTO whitelist(dni,nombre,apellido,email) VALUES(?,?,?,?)", dni, first, last, email); e != nil {
		return e
	}
	if e = audit(tx, actor, "ENABLE_DNI", "whitelist", 0, ""); e != nil {
		return e
	}
	return tx.Commit()
}
func (a *App) enableDNI(w http.ResponseWriter, r *http.Request) {
	if e := a.EnableDNI(current(r).ID, r.FormValue("dni"), r.FormValue("first"), r.FormValue("last"), r.FormValue("email")); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/dnis", "DNI habilitado. El mediador ya puede registrarse.")
}
func (a *App) ChangeState(actor, id int64, state, result string) error {
	tx, e := a.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = requireAdmin(tx, actor); e != nil {
		return e
	}
	var old string
	if e = tx.QueryRow("SELECT state FROM mediations WHERE id=?", id).Scan(&old); e != nil {
		return e
	}
	if old == "CANCELADA_POR_ADMIN" && state != old {
		return errors.New("La mediación fue cancelada por un bloqueo. Cree una nueva reserva.")
	}
	if e = transition(old, state, result); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE mediations SET state=?,result=?,updated_at=?,exported_at=NULL,export_id=NULL WHERE id=?", state, result, stamp(), id); e != nil {
		return e
	}
	if e = audit(tx, actor, "CHANGE_STATE", "mediations", id, old+" → "+state); e != nil {
		return e
	}
	return tx.Commit()
}
func (a *App) statePage(w http.ResponseWriter, r *http.Request) {
	rows, e := a.DB.Query(medSelect+"WHERE m.id=?", number(r.URL.Query().Get("id")))
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
	a.render(w, r, "Cambiar estado", stateTemplate, map[string]any{"M": ms[0]})
}
func (a *App) stateSave(w http.ResponseWriter, r *http.Request) {
	if e := a.ChangeState(current(r).ID, number(r.FormValue("id")), r.FormValue("state"), r.FormValue("result")); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/admin/mediaciones", "Estado actualizado.")
}
