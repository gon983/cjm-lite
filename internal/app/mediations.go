package app

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Mediation struct {
	ID                                           int64
	Sede, Date, Start                            string
	M1, M2                                       int64
	Title, Case, State, Result, Created, Updated string
	Name1, Name2, DNI1, DNI2                     string
	Exported                                     bool
}

func (a *App) validate(tx *sql.Tx, m Mediation, exclude int64) error {
	s, ok := sede(m.Sede)
	if !ok {
		return errors.New("Sede inválida.")
	}
	valid := false
	for _, h := range Slots(s) {
		if h == m.Start {
			valid = true
		}
	}
	if !valid {
		return errors.New("Horario inválido.")
	}
	d, e := time.ParseInLocation("2006-01-02 15:04", m.Date+" "+m.Start, a.Location)
	if e != nil {
		return errors.New("Fecha inválida.")
	}
	if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
		return errors.New("Solo se reserva de lunes a viernes.")
	}
	if !d.After(a.now()) {
		return errors.New("No se puede reservar un horario pasado.")
	}
	if d.After(monthLimit(a.now())) {
		return errors.New("No se puede reservar con más de un mes de anticipación.")
	}
	var n int
	if e = tx.QueryRow("SELECT count(*) FROM blocked_days WHERE sede=? AND date=?", m.Sede, m.Date).Scan(&n); e != nil {
		return e
	}
	if n > 0 {
		return errors.New("Ese día fue marcado como no laborable.")
	}
	if m.M1 == m.M2 {
		return errors.New("Seleccione dos mediadores diferentes.")
	}
	if e = tx.QueryRow("SELECT count(*) FROM users WHERE id IN (?,?) AND role='MEDIADOR' AND active=1", m.M1, m.M2).Scan(&n); e != nil {
		return e
	}
	if n != 2 {
		return errors.New("Ambos mediadores deben estar activos.")
	}
	if e = tx.QueryRow("SELECT count(*) FROM mediations WHERE sede=? AND date=? AND start=? AND state<>'CANCELADA_POR_ADMIN' AND id<>?", m.Sede, m.Date, m.Start, exclude).Scan(&n); e != nil {
		return e
	}
	if n >= s.Rooms {
		return errors.New("Ese horario acaba de ser reservado por otro usuario.")
	}
	rows, e := tx.Query("SELECT start,sede FROM mediations WHERE date=? AND state<>'CANCELADA_POR_ADMIN' AND id<>? AND (m1 IN (?,?) OR m2 IN (?,?))", m.Date, exclude, m.M1, m.M2, m.M1, m.M2)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var h, code string
		if e = rows.Scan(&h, &code); e != nil {
			return e
		}
		other, ok := sede(code)
		if !ok {
			return fmt.Errorf("sede histórica desconocida: %s", code)
		}
		t, e := time.ParseInLocation("2006-01-02 15:04", m.Date+" "+h, a.Location)
		if e != nil {
			return e
		}
		if d.Before(t.Add(time.Duration(other.SlotMinutes)*time.Minute)) && t.Before(d.Add(time.Duration(s.SlotMinutes)*time.Minute)) {
			return errors.New("Un mediador seleccionado ya tiene una mediación en ese horario.")
		}
	}
	return rows.Err()
}
func (a *App) Reserve(actor int64, m Mediation) (int64, error) {
	tx, e := a.DB.Begin()
	if e != nil {
		return 0, e
	}
	defer tx.Rollback()
	var role string
	if e = tx.QueryRow("SELECT role FROM users WHERE id=? AND active=1", actor).Scan(&role); e != nil || role != "MEDIADOR" {
		return 0, errors.New("Solo un mediador activo puede reservar.")
	}
	m.M1 = actor
	m.State = "RESERVADA"
	if strings.TrimSpace(m.Title) == "" || strings.TrimSpace(m.Case) == "" || len(m.Title) > 300 || len(m.Case) > 120 {
		return 0, errors.New("Complete carátula y expediente.")
	}
	if e = a.validate(tx, m, 0); e != nil {
		return 0, e
	}
	r, e := tx.Exec("INSERT INTO mediations(sede,date,start,m1,m2,title,case_number,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'RESERVADA',?,?)", m.Sede, m.Date, m.Start, m.M1, m.M2, m.Title, m.Case, stamp(), stamp())
	if e != nil {
		return 0, e
	}
	id, _ := r.LastInsertId()
	if e = audit(tx, actor, "RESERVE", "mediations", id, ""); e != nil {
		return 0, e
	}
	return id, tx.Commit()
}
func (a *App) Cancel(actor, id int64) error {
	tx, e := a.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var date, start, state, role string
	var m1, m2 int64
	if e = tx.QueryRow("SELECT date,start,state,m1,m2 FROM mediations WHERE id=?", id).Scan(&date, &start, &state, &m1, &m2); e != nil {
		return e
	}
	if e = tx.QueryRow("SELECT role FROM users WHERE id=? AND active=1", actor).Scan(&role); e != nil || role != "MEDIADOR" || actor != m1 && actor != m2 {
		return errors.New("No tiene permiso para cancelar esta mediación.")
	}
	t, e := time.ParseInLocation("2006-01-02 15:04", date+" "+start, a.Location)
	if e != nil {
		return e
	}
	if !a.now().Before(t) || state == "CANCELADA_POR_ADMIN" {
		return errors.New("No se puede cancelar una mediación que ya comenzó.")
	}
	if e = audit(tx, actor, "CANCEL", "mediations", id, date+" "+start); e != nil {
		return e
	}
	if _, e = tx.Exec("DELETE FROM mediations WHERE id=?", id); e != nil {
		return e
	}
	return tx.Commit()
}
func transition(from, to, result string) error {
	if to != "RESERVADA" && to != "INICIADA" && to != "FINALIZADA" && to != "FIRMADA" && !(from == "CANCELADA_POR_ADMIN" && to == from) {
		return errors.New("Estado inválido. Las cancelaciones administrativas se gestionan bloqueando el día.")
	}
	if to == "FINALIZADA" || to == "FIRMADA" {
		if result != "CON_ACUERDO" && result != "SIN_ACUERDO" && result != "INCOMPARECENCIA" {
			return errors.New("Indique un resultado válido al finalizar.")
		}
	} else if to == "CANCELADA_POR_ADMIN" {
		if result != "" && result != "CON_ACUERDO" && result != "SIN_ACUERDO" && result != "INCOMPARECENCIA" {
			return errors.New("Resultado inválido.")
		}
	} else if result != "" {
		return errors.New("El resultado corresponde a una mediación finalizada.")
	}
	return nil
}
func (a *App) Edit(actor int64, m Mediation) error        { return a.editMediation(actor, m, false) }
func (a *App) EditDetails(actor int64, m Mediation) error { return a.editMediation(actor, m, true) }
func (a *App) editMediation(actor int64, m Mediation, detailsOnly bool) error {
	tx, e := a.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = requireAdmin(tx, actor); e != nil {
		return e
	}
	var old Mediation
	if e = tx.QueryRow("SELECT sede,date,start,m1,m2,state,result FROM mediations WHERE id=?", m.ID).Scan(&old.Sede, &old.Date, &old.Start, &old.M1, &old.M2, &old.State, &old.Result); e != nil {
		return e
	}
	if detailsOnly {
		m.State = old.State
		m.Result = old.Result
	}
	if e = transition(old.State, m.State, m.Result); e != nil {
		return e
	}
	if strings.TrimSpace(m.Title) == "" || strings.TrimSpace(m.Case) == "" || len(m.Title) > 300 || len(m.Case) > 120 {
		return errors.New("Complete carátula y expediente.")
	}
	if old.Sede != m.Sede || old.Date != m.Date || old.Start != m.Start || old.M1 != m.M1 || old.M2 != m.M2 {
		if m.State == "CANCELADA_POR_ADMIN" {
			return errors.New("Una cancelación administrativa no puede reprogramarse.")
		}
		if e = a.validate(tx, m, m.ID); e != nil {
			return e
		}
	}
	_, e = tx.Exec("UPDATE mediations SET sede=?,date=?,start=?,m1=?,m2=?,title=?,case_number=?,state=?,result=?,updated_at=?,exported_at=NULL,export_id=NULL WHERE id=?", m.Sede, m.Date, m.Start, m.M1, m.M2, m.Title, m.Case, m.State, m.Result, stamp(), m.ID)
	if e != nil {
		return e
	}
	action := "EDIT"
	if old.State != m.State {
		action = "CHANGE_STATE"
	}
	if e = audit(tx, actor, action, "mediations", m.ID, old.State+" → "+m.State); e != nil {
		return e
	}
	return tx.Commit()
}
func (a *App) Block(actor int64, code, date, reason string, unblock bool) error {
	if _, ok := sede(code); !ok {
		return errors.New("Sede inválida.")
	}
	if _, e := time.Parse("2006-01-02", date); e != nil {
		return errors.New("Fecha inválida.")
	}
	tx, e := a.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = requireAdmin(tx, actor); e != nil {
		return e
	}
	action := "BLOCK"
	if unblock {
		action = "UNBLOCK"
		_, e = tx.Exec("DELETE FROM blocked_days WHERE sede=? AND date=?", code, date)
	} else {
		_, e = tx.Exec("INSERT INTO blocked_days(sede,date,reason) VALUES(?,?,?) ON CONFLICT(sede,date) DO UPDATE SET reason=excluded.reason", code, date, reason)
		if e == nil {
			_, e = tx.Exec("UPDATE mediations SET state='CANCELADA_POR_ADMIN',updated_at=?,exported_at=NULL,export_id=NULL WHERE sede=? AND date=?", stamp(), code, date)
		}
	}
	if e != nil {
		return e
	}
	if e = audit(tx, actor, action, "blocked_days", 0, code+" "+date); e != nil {
		return e
	}
	return tx.Commit()
}

const medSelect = `SELECT m.id,m.sede,m.date,m.start,m.m1,m.m2,m.title,m.case_number,m.state,m.result,m.created_at,m.updated_at,u1.apellido||' '||u1.nombre,u2.apellido||' '||u2.nombre,coalesce(u1.dni,''),coalesce(u2.dni,''),m.exported_at IS NOT NULL FROM mediations m JOIN users u1 ON u1.id=m.m1 JOIN users u2 ON u2.id=m.m2 `

func scanM(rows *sql.Rows) ([]Mediation, error) {
	out := []Mediation{}
	for rows.Next() {
		var m Mediation
		if e := rows.Scan(&m.ID, &m.Sede, &m.Date, &m.Start, &m.M1, &m.M2, &m.Title, &m.Case, &m.State, &m.Result, &m.Created, &m.Updated, &m.Name1, &m.Name2, &m.DNI1, &m.DNI2, &m.Exported); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
