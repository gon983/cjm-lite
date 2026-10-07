package app

import (
	"errors"
	"fmt"
	"net/http"
	"time"
)

type SlotView struct {
	Date, Start, Sede string
	Free              int
	Available         bool
	Label             string
}
type DayView struct {
	Date, Label string
	Slots       []SlotView
}

func (a *App) calendar(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("sede")
	if code == "" {
		code = Sedes[0].Code
	}
	s, ok := sede(code)
	if !ok {
		a.error(w, r, errors.New("Sede inválida."))
		return
	}
	now := a.now()
	week := now
	if q := r.URL.Query().Get("semana"); q != "" {
		var e error
		week, e = time.ParseInLocation("2006-01-02", q, a.Location)
		if e != nil {
			a.error(w, r, e)
			return
		}
	}
	week = time.Date(week.Year(), week.Month(), week.Day(), 0, 0, 0, 0, a.Location)
	offset := (int(week.Weekday()) + 6) % 7
	week = week.AddDate(0, 0, -offset)
	if week.Before(now.AddDate(0, 0, -7)) || week.After(monthLimit(now)) {
		a.error(w, r, errors.New("La semana está fuera del período disponible."))
		return
	}
	counts := map[string]int{}
	rows, e := a.DB.Query("SELECT date,start,count(*) FROM mediations WHERE sede=? AND date BETWEEN ? AND ? AND state<>'CANCELADA_POR_ADMIN' GROUP BY date,start", code, week.Format("2006-01-02"), week.AddDate(0, 0, 4).Format("2006-01-02"))
	if e != nil {
		a.error(w, r, e)
		return
	}
	for rows.Next() {
		var d, h string
		var n int
		if e = rows.Scan(&d, &h, &n); e != nil {
			break
		}
		counts[d+" "+h] = n
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	blocked := map[string]bool{}
	rows, e = a.DB.Query("SELECT date FROM blocked_days WHERE sede=? AND date BETWEEN ? AND ?", code, week.Format("2006-01-02"), week.AddDate(0, 0, 4).Format("2006-01-02"))
	if e != nil {
		a.error(w, r, e)
		return
	}
	for rows.Next() {
		var d string
		if e = rows.Scan(&d); e != nil {
			break
		}
		blocked[d] = true
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		a.error(w, r, e)
		return
	}
	labels := []string{"Lunes", "Martes", "Miércoles", "Jueves", "Viernes"}
	var days []DayView
	for i := 0; i < 5; i++ {
		d := week.AddDate(0, 0, i)
		dv := DayView{Date: d.Format("2006-01-02"), Label: labels[i] + " " + d.Format("02/01/2006")}
		for _, h := range Slots(s) {
			t, _ := time.ParseInLocation("2006-01-02 15:04", dv.Date+" "+h, a.Location)
			free := s.Rooms - counts[dv.Date+" "+h]
			available := free > 0 && !blocked[dv.Date] && t.After(now) && !t.After(monthLimit(now))
			label := fmt.Sprintf("%d lugar(es) disponible(s)", free)
			if !available {
				label = "No disponible"
				if free <= 0 {
					label = "Completo"
				}
				if blocked[dv.Date] {
					label = "Día bloqueado"
				}
			}
			dv.Slots = append(dv.Slots, SlotView{dv.Date, h, code, free, available, label})
		}
		days = append(days, dv)
	}
	a.render(w, r, "Calendario semanal", calendarTemplate, map[string]any{"Days": days, "Sede": code, "Name": s.Name, "Week": week.Format("02/01/2006"), "Prev": week.AddDate(0, 0, -7).Format("2006-01-02"), "Next": week.AddDate(0, 0, 7).Format("2006-01-02"), "HasPrev": !week.AddDate(0, 0, -7).Before(now.AddDate(0, 0, -7)), "HasNext": !week.AddDate(0, 0, 7).After(monthLimit(now)), "Limit": monthLimit(now).Format("02/01/2006")})
}
func (a *App) activeMediators() ([]User, error) {
	rows, e := a.DB.Query("SELECT id,nombre,apellido,dni FROM users WHERE role='MEDIADOR' AND active=1 ORDER BY apellido,nombre")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Nombre, &u.Apellido, &u.DNI); e != nil {
			return nil, e
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
func (a *App) reservePage(w http.ResponseWriter, r *http.Request) {
	users, e := a.activeMediators()
	if e != nil {
		a.error(w, r, e)
		return
	}
	a.render(w, r, "Reservar mediación", reserveTemplate, map[string]any{"Mediators": users, "Sede": r.URL.Query().Get("sede"), "Date": r.URL.Query().Get("fecha"), "Start": r.URL.Query().Get("hora")})
}
func formM(r *http.Request) Mediation {
	return Mediation{ID: number(r.FormValue("id")), Sede: r.FormValue("sede"), Date: r.FormValue("date"), Start: r.FormValue("start"), M1: number(r.FormValue("m1")), M2: number(r.FormValue("m2")), Title: r.FormValue("title"), Case: r.FormValue("case"), State: r.FormValue("state"), Result: r.FormValue("result")}
}
func (a *App) reserve(w http.ResponseWriter, r *http.Request) {
	_, e := a.Reserve(current(r).ID, formM(r))
	if e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/mis-mediaciones", "Reserva creada para ambos mediadores.")
}
func (a *App) myMediations(w http.ResponseWriter, r *http.Request) {
	u := current(r)
	rows, e := a.DB.Query(medSelect+"WHERE (m.m1=? OR m.m2=?) AND m.date>=? ORDER BY m.date,m.start LIMIT 100", u.ID, u.ID, a.now().AddDate(0, 0, -7).Format("2006-01-02"))
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
	can := map[int64]bool{}
	for _, m := range ms {
		t, _ := time.ParseInLocation("2006-01-02 15:04", m.Date+" "+m.Start, a.Location)
		can[m.ID] = m.State != "CANCELADA_POR_ADMIN" && a.now().Before(t)
	}
	a.render(w, r, "Mis mediaciones", myTemplate, map[string]any{"Mediations": ms, "CanCancel": can})
}
func (a *App) cancel(w http.ResponseWriter, r *http.Request) {
	if e := a.Cancel(current(r).ID, number(r.FormValue("id"))); e != nil {
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/mis-mediaciones", "Reserva cancelada. El cupo vuelve a estar disponible.")
}
