package app

import (
	"fmt"
	"os"
	"time"
)

type Sede struct {
	Code, Name, Start, End string
	SlotMinutes, Rooms     int
}

// Único lugar para agregar sedes. Horas locales, intervalos sin superposición.
var Sedes = []Sede{{"COSQUIN", "Cosquín", "08:00", "15:30", 90, 1}}

func Slots(s Sede) []string {
	a, _ := time.Parse("15:04", s.Start)
	b, _ := time.Parse("15:04", s.End)
	var out []string
	for ; !a.Add(time.Duration(s.SlotMinutes) * time.Minute).After(b); a = a.Add(time.Duration(s.SlotMinutes) * time.Minute) {
		out = append(out, a.Format("15:04"))
	}
	return out
}
func sede(code string) (Sede, bool) {
	for _, s := range Sedes {
		if s.Code == code {
			return s, true
		}
	}
	return Sede{}, false
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// Calendar month addition clamps the day instead of Go AddDate overflow (31 Jan → 28 Feb).
func monthLimit(t time.Time) time.Time {
	y, m, d := t.Date()
	last := time.Date(y, m+2, 0, 0, 0, 0, 0, t.Location()).Day()
	if d > last {
		d = last
	}
	return time.Date(y, m+1, d, 23, 59, 59, 0, t.Location())
}

func validateSedes() error {
	seen := map[string]bool{}
	if len(Sedes) == 0 {
		return fmt.Errorf("configure al menos una sede")
	}
	for _, s := range Sedes {
		start, e1 := time.Parse("15:04", s.Start)
		end, e2 := time.Parse("15:04", s.End)
		if seen[s.Code] || s.Code == "" || s.Name == "" || e1 != nil || e2 != nil || !start.Before(end) || s.SlotMinutes <= 0 || s.SlotMinutes > 1440 || s.Rooms <= 0 || start.Add(time.Duration(s.SlotMinutes)*time.Minute).After(end) {
			return fmt.Errorf("configuración inválida de sede: %s", s.Code)
		}
		seen[s.Code] = true
	}
	return nil
}
