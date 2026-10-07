package app

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManualDNI(t *testing.T) {
	a, ids, admin := fixture(t)
	if e := a.EnableDNI(ids[0], "32280055", "Ana", "Perez", "ana@example.com"); e == nil {
		t.Fatal("mediator enabled DNI")
	}
	if e := a.EnableDNI(admin, "32.280.055", " Ana ", " Perez ", "ANA@example.com"); e != nil {
		t.Fatal(e)
	}
	if e := a.EnableDNI(admin, "32280055", "Ana", "Perez", "ana@example.com"); e == nil {
		t.Fatal("duplicate accepted")
	}
	if e := a.EnableDNI(admin, "100", "Ana", "Perez", "ana@example.com"); e == nil {
		t.Fatal("registered DNI accepted")
	}
	if e := a.EnableDNI(admin, "invalid", "Ana", "Perez", "bad"); e == nil {
		t.Fatal("invalid accepted")
	}
}
func TestSeparateStateAndDetails(t *testing.T) {
	a, ids, admin := fixture(t)
	id := mustReserve(t, a, ids)
	if e := a.ChangeState(ids[0], id, "INICIADA", ""); e == nil {
		t.Fatal("mediator changed state")
	}
	if e := a.ChangeState(admin, id, "FINALIZADA", ""); e == nil {
		t.Fatal("result missing")
	}
	if e := a.ChangeState(admin, id, "FINALIZADA", "CON_ACUERDO"); e != nil {
		t.Fatal(e)
	}
	m := load(t, a, id)
	m.Title = "Edited"
	m.State = "RESERVADA"
	m.Result = ""
	if e := a.EditDetails(admin, m); e != nil {
		t.Fatal(e)
	}
	m = load(t, a, id)
	if m.State != "FINALIZADA" || m.Result != "CON_ACUERDO" || m.Title != "Edited" {
		t.Fatal("edit changed state", m)
	}
	if e := a.ChangeState(admin, id, "FIRMADA", "CON_ACUERDO"); e != nil {
		t.Fatal(e)
	}
	m = load(t, a, id)
	if m.Title != "Edited" || m.Date != "2026-10-08" {
		t.Fatal("state modified data")
	}
}
func TestDateFormats(t *testing.T) {
	for raw, want := range map[string]string{"07/10/2026": "2026-10-07", "2026-10-07": "2026-10-07", "31/02/2026": "31/02/2026"} {
		if got := dateInput(raw); got != want {
			t.Fatal(raw, got)
		}
	}
	a, _, _ := fixture(t)
	if dateES("2026-10-07") != "07/10/2026" || a.timestampES("2026-10-08T01:00:00Z") != "07/10/2026 22:00" {
		t.Fatal("date/timezone")
	}
}
func TestLiveSearchAccentAndTokens(t *testing.T) {
	a, ids, _ := fixture(t)
	a.DB.Exec("UPDATE users SET nombre='María Sol',apellido='Pérez' WHERE id=?", ids[1])
	for _, q := range []string{"maria+perez", "perez+maria", "101"} {
		r := httptest.NewRequest("GET", "/mediadores/buscar?q="+q, nil)
		r = r.WithContext(context.WithValue(r.Context(), userKey, &User{ID: ids[0], Role: "MEDIADOR"}))
		w := httptest.NewRecorder()
		a.mediatorSearch(w, r)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "Pérez María Sol") {
			t.Fatal(q, w.Body.String())
		}
	}
	r := httptest.NewRequest("GET", "/mediadores/buscar?q=100", nil)
	r = r.WithContext(context.WithValue(r.Context(), userKey, &User{ID: ids[0], Role: "MEDIADOR"}))
	w := httptest.NewRecorder()
	a.mediatorSearch(w, r)
	if !strings.Contains(w.Body.String(), "No se encontraron") {
		t.Fatal("self searchable")
	}
}
