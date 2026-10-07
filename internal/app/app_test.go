package app

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"fmt"
	"github.com/xuri/excelize/v2"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixture(t *testing.T) (*App, []int64, int64) {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	t.Setenv("TZ", "America/Argentina/Cordoba")
	a, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.DB.Close() })
	a.Now = func() time.Time { return time.Date(2026, 10, 7, 7, 0, 0, 0, a.Location) }
	if e = a.CreateAdmin(0, "Funcionario", "admin", "a-long-admin-password"); e != nil {
		t.Fatal(e)
	}
	var admin int64
	a.DB.QueryRow("SELECT id FROM users WHERE role='ADMIN'").Scan(&admin)
	var ids []int64
	for i := 0; i < 4; i++ {
		m := fmt.Sprint(100 + i)
		_, e = a.DB.Exec("INSERT INTO whitelist VALUES(?,?,?,?)", m, "Nombre", "Apellido", "mediador@example.com")
		if e != nil {
			t.Fatal(e)
		}
		id, e := a.Register(m, "123456789", "a-long-test-password", "mediadores/test.jpg")
		if e != nil {
			t.Fatal(e)
		}
		ids = append(ids, id)
	}
	return a, ids, admin
}
func booking(ids []int64) Mediation {
	return Mediation{Sede: "COSQUIN", Date: "2026-10-08", Start: "08:00", M1: ids[0], M2: ids[1], Title: "Carátula", Case: "123"}
}
func mustReserve(t *testing.T, a *App, ids []int64) int64 {
	t.Helper()
	id, e := a.Reserve(ids[0], booking(ids))
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func TestRegistration(t *testing.T) {
	a, _, _ := fixture(t)
	if _, e := a.Register("missing", "123", "a-long-password", "photo.jpg"); e == nil {
		t.Fatal("invalid whitelist registered")
	}
	if _, e := a.Register("100", "123", "a-long-password", "photo.jpg"); e == nil {
		t.Fatal("duplicate registration allowed")
	}
	_, e := a.DB.Exec("INSERT INTO whitelist VALUES('500','Ana','Perez','ana@example.com')")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Register(" 500 ", "123", "a-long-password", "photo.jpg"); e != nil {
		t.Fatal(e)
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM whitelist WHERE dni='500'").Scan(&n)
	if n != 0 {
		t.Fatal("whitelist not consumed")
	}
}
func TestInactiveLoginAndReset(t *testing.T) {
	a, ids, admin := fixture(t)
	if _, e := a.Authenticate("100", "a-long-test-password"); e != nil {
		t.Fatal(e)
	}
	if e := a.ManageUser(admin, ids[0], "toggle", ""); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Authenticate("100", "a-long-test-password"); e == nil {
		t.Fatal("inactive logged in")
	}
	if e := a.ManageUser(admin, ids[0], "toggle", ""); e != nil {
		t.Fatal(e)
	}
	a.DB.Exec("INSERT INTO sessions VALUES('token',?,?)", ids[0], "2099-01-01T00:00:00Z")
	if e := a.ManageUser(admin, ids[0], "reset", "new-long-password"); e != nil {
		t.Fatal(e)
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM sessions WHERE user_id=?", ids[0]).Scan(&n)
	if n != 0 {
		t.Fatal("session survived reset")
	}
	if _, e := a.Authenticate("100", "a-long-test-password"); e == nil {
		t.Fatal("old password works")
	}
}
func TestConcurrentLastRoom(t *testing.T) {
	a, ids, _ := fixture(t) // Separate pool simulates another process/CLI sharing SQLite.
	db, e := sql.Open("sqlite3", filepath.Join(a.Dir, "database/app.sqlite")+"?_foreign_keys=on&_busy_timeout=10000&_txlock=immediate")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	other := *a
	other.DB = db
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i, instance := range []*App{a, &other} {
		wg.Add(1)
		go func(i int, x *App) {
			defer wg.Done()
			<-start
			pair := ids[i*2 : i*2+2]
			_, e := x.Reserve(pair[0], booking(pair))
			results <- e
		}(i, instance)
	}
	close(start)
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("success=%d", success)
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM mediations").Scan(&n)
	if n != 1 {
		t.Fatalf("oversold %d", n)
	}
}
func TestConflictsBothRolesAndOverlap(t *testing.T) {
	a, ids, _ := fixture(t)
	original := Sedes
	Sedes = append(Sedes, Sede{"OTHER", "Otra", "08:30", "17:30", 90, 2})
	defer func() { Sedes = original }()
	mustReserve(t, a, ids)
	for _, pair := range [][]int64{{ids[0], ids[2]}, {ids[2], ids[1]}, {ids[1], ids[2]}} {
		m := booking(pair)
		m.Sede = "OTHER"
		m.Start = "08:30"
		if _, e := a.Reserve(pair[0], m); e == nil {
			t.Fatal("overlap allowed")
		}
	}
	m := booking(ids[2:])
	m.Sede = "OTHER"
	m.Start = "10:00"
	if _, e := a.Reserve(ids[2], m); e != nil {
		t.Fatal(e)
	}
}
func TestBookingLimits(t *testing.T) {
	a, ids, admin := fixture(t)
	for _, date := range []string{"2026-11-09", "2026-10-10", "2026-10-06"} {
		m := booking(ids)
		m.Date = date
		if _, e := a.Reserve(ids[0], m); e == nil {
			t.Fatalf("allowed %s", date)
		}
	}
	if e := a.Block(admin, "COSQUIN", "2026-10-08", "Feriado", false); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Reserve(ids[0], booking(ids)); e == nil {
		t.Fatal("blocked day allowed")
	}
	a.Now = func() time.Time { return time.Date(2026, 10, 9, 7, 0, 0, 0, a.Location) }
	m := booking(ids)
	m.Date = "2026-11-09"
	if _, e := a.Reserve(ids[0], m); e != nil {
		t.Fatal("exact month rejected", e)
	}
	jan := time.Date(2027, 1, 31, 12, 0, 0, 0, a.Location)
	if monthLimit(jan).Format("2006-01-02") != "2027-02-28" {
		t.Fatal("month overflow")
	}
}
func TestCancel(t *testing.T) {
	a, ids, admin := fixture(t)
	id := mustReserve(t, a, ids)
	if e := a.Cancel(ids[2], id); e == nil {
		t.Fatal("nonparticipant cancelled")
	}
	m := load(t, a, id)
	m.State = "INICIADA"
	if e := a.Edit(admin, m); e != nil {
		t.Fatal(e)
	}
	if e := a.Cancel(ids[1], id); e != nil {
		t.Fatal(e)
	}
	id = mustReserve(t, a, ids[2:])
	a.Now = func() time.Time { return time.Date(2026, 10, 8, 8, 0, 0, 0, a.Location) }
	if e := a.Cancel(ids[2], id); e == nil {
		t.Fatal("cancelled at start")
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM audit_log WHERE action='CANCEL'").Scan(&n)
	if n != 1 {
		t.Fatal("cancel not audited")
	}
}
func TestBlockUnblock(t *testing.T) {
	a, ids, admin := fixture(t)
	id := mustReserve(t, a, ids)
	if e := a.Block(admin, "COSQUIN", "2026-10-08", "", false); e != nil {
		t.Fatal(e)
	}
	var state string
	a.DB.QueryRow("SELECT state FROM mediations WHERE id=?", id).Scan(&state)
	if state != "CANCELADA_POR_ADMIN" {
		t.Fatal(state)
	}
	if e := a.Block(admin, "COSQUIN", "2026-10-08", "", true); e != nil {
		t.Fatal(e)
	}
	a.DB.QueryRow("SELECT state FROM mediations WHERE id=?", id).Scan(&state)
	if state != "CANCELADA_POR_ADMIN" {
		t.Fatal("restored cancelled")
	}
	mustReserve(t, a, ids[2:])
}
func load(t *testing.T, a *App, id int64) Mediation {
	t.Helper()
	rows, e := a.DB.Query(medSelect+"WHERE m.id=?", id)
	if e != nil {
		t.Fatal(e)
	}
	ms, e := scanM(rows)
	rows.Close()
	if e != nil || len(ms) != 1 {
		t.Fatal("missing mediation", e)
	}
	return ms[0]
}
func TestStatesAndEdit(t *testing.T) {
	a, ids, admin := fixture(t)
	id := mustReserve(t, a, ids)
	m := load(t, a, id)
	m.State = "FINALIZADA"
	if e := a.Edit(admin, m); e == nil {
		t.Fatal("no result accepted")
	}
	m.Result = "CON_ACUERDO"
	if e := a.Edit(ids[0], m); e == nil {
		t.Fatal("mediator changed state")
	}
	if e := a.Edit(admin, m); e != nil {
		t.Fatal("admin free state change failed", e)
	}
	m.State = "FIRMADA"
	if e := a.Edit(admin, m); e != nil {
		t.Fatal(e)
	}
	m.State = "RESERVADA"
	m.Result = ""
	if e := a.Edit(admin, m); e != nil {
		t.Fatal("admin cannot correct state", e)
	}
	m.M2 = m.M1
	if e := a.Edit(admin, m); e == nil {
		t.Fatal("same mediator accepted")
	}
	m = load(t, a, id)
	m.Date = "2026-11-09"
	if e := a.Edit(admin, m); e == nil {
		t.Fatal("edit limit bypass")
	}
}
func TestRetentionAndExportInvalidation(t *testing.T) {
	a, ids, admin := fixture(t)
	id := mustReserve(t, a, ids)
	a.Now = func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, a.Location) }
	if e := a.Cleanup(); e != nil {
		t.Fatal(e)
	}
	load(t, a, id)
	name, e := a.Export(admin, "2026-10-08", "2026-10-08")
	if e != nil {
		t.Fatal(e)
	}
	f, e := excelize.OpenFile(filepath.Join(a.Dir, "exports", name))
	if e != nil {
		t.Fatal(e)
	}
	rows, e := f.GetRows("Sheet1")
	f.Close()
	if e != nil || len(rows) != 2 {
		t.Fatal("bad export", e)
	}
	m := load(t, a, id)
	m.Title = "Corrección"
	if e := a.Edit(admin, m); e != nil {
		t.Fatal(e)
	}
	if e := a.Cleanup(); e != nil {
		t.Fatal(e)
	}
	load(t, a, id)
	if _, e = a.Export(admin, "2026-10-08", "2026-10-08"); e != nil {
		t.Fatal(e)
	}
	if e = a.Cleanup(); e != nil {
		t.Fatal(e)
	}
	var count int
	a.DB.QueryRow("SELECT count(*) FROM mediations").Scan(&count)
	if count != 0 {
		t.Fatal("exported old record retained")
	}
}
func TestDayCleanupAllExported(t *testing.T) {
	a, ids, _ := fixture(t)
	id := mustReserve(t, a, ids)
	m := booking(ids[2:])
	m.Start = "09:30"
	if _, e := a.Reserve(ids[2], m); e != nil {
		t.Fatal(e)
	}
	a.DB.Exec("UPDATE mediations SET exported_at=? WHERE id=?", stamp(), id)
	a.Now = func() time.Time { return time.Date(2026, 10, 30, 12, 0, 0, 0, a.Location) }
	if e := a.Cleanup(); e != nil {
		t.Fatal(e)
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM mediations").Scan(&n)
	if n != 2 {
		t.Fatal("partially exported day deleted")
	}
}
func TestImport(t *testing.T) {
	a, _, _ := fixture(t)
	f := excelize.NewFile()
	defer f.Close()
	rows := [][]any{{"Apellido", "Nombre", "DNI", "", "", "", "", "Email"}, {" PEREZ ", " ANA ", " 900 ", "", "", "", "", " ANA@EXAMPLE.COM "}, {"Dup", "Dup", "900", "", "", "", "", "dup@example.com"}, {"Bad", "Bad", "901", "", "", "", "", "no-email"}, {"Old", "Old", "100", "", "", "", "", "old@example.com"}}
	for i, row := range rows {
		f.SetSheetRow("Sheet1", fmt.Sprintf("A%d", i+1), &row)
	}
	path := filepath.Join(t.TempDir(), "input.xlsx")
	if e := f.SaveAs(path); e != nil {
		t.Fatal(e)
	}
	s, e := a.Import(path)
	if e != nil {
		t.Fatal(e)
	}
	if s.Read != 4 || s.Imported != 1 || s.Duplicates != 2 || s.Invalid != 1 {
		t.Fatalf("%+v", s)
	}
	s, e = a.Import(path)
	if e != nil || s.Imported != 0 {
		t.Fatal("import not idempotent", s, e)
	}
}
func TestPhotosAndBackup(t *testing.T) {
	a, _, _ := fixture(t)
	if _, e := a.Image(strings.NewReader("<svg>bad</svg>"), "mediadores"); e == nil {
		t.Fatal("unsafe upload accepted")
	}
	var b bytes.Buffer
	png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 1200, 600)))
	path, e := a.Image(&b, "mediadores")
	if e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(filepath.Join(a.Dir, "uploads", path))
	if e != nil {
		t.Fatal(e)
	}
	c, format, e := image.DecodeConfig(f)
	f.Close()
	if e != nil || format != "jpeg" || c.Width != 800 || c.Height != 400 {
		t.Fatal("bad resize", c, format, e)
	}
	name, e := a.Backup()
	if e != nil {
		t.Fatal(e)
	}
	f, e = os.Open(name)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		t.Fatal(e)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	found := map[string]bool{}
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		found[h.Name] = true
	}
	if !found["database/app.sqlite"] || !found["uploads/"+path] || !found["session-secret"] {
		t.Fatal("incomplete backup", found)
	}
}
func TestCSRFAndRoleGuard(t *testing.T) {
	a, ids, _ := fixture(t)
	h := a.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	r := httptest.NewRequest("POST", "/", strings.NewReader("csrf=bad"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("csrf bypass", w.Code)
	}
	v := url.Values{"csrf": {a.csrf("token")}}
	r = httptest.NewRequest("POST", "/", strings.NewReader(v.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.AddCookie(&http.Cookie{Name: "csrf", Value: "token"})
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
	if e := a.Block(ids[0], "COSQUIN", "2026-10-08", "", false); e == nil {
		t.Fatal("mediator blocked day")
	}
	if _, e := a.Export(ids[0], "2026-10-08", "2026-10-08"); e == nil {
		t.Fatal("mediator exported")
	}
}
func TestAllTemplates(t *testing.T) {
	a, ids, admin := fixture(t)
	mustReserve(t, a, ids)
	a.DB.Exec("INSERT INTO news(title,content,published,publication_date,updated_at) VALUES('<script>alert(1)</script>','Texto',1,'2026-10-07',?)", stamp())
	for _, role := range []struct {
		ID   int64
		Role string
	}{{ids[0], "MEDIADOR"}, {admin, "ADMIN"}} {
		for _, page := range []struct {
			path    string
			handler http.HandlerFunc
		}{{"/", a.home}, {"/calendario", a.calendar}, {"/reservar?sede=COSQUIN&fecha=2026-10-08&hora=09:30", a.reservePage}, {"/mis-mediaciones", a.myMediations}, {"/admin/mediaciones?date=2026-10-08", a.adminMediations}, {"/admin/editar?id=1", a.editPage}, {"/admin/usuarios", a.users}, {"/admin/usuarios?role=ADMIN", a.users}, {"/admin/bloqueos", a.blocks}, {"/admin/noticias", a.newsPage}, {"/admin/dnis", a.whitelist}, {"/admin/exportaciones", a.exports}, {"/admin/auditoria", a.audits}, {"/login", a.loginPage}, {"/registro?dni=missing", a.registerPage}} {
			r := httptest.NewRequest("GET", page.path, nil)
			r = r.WithContext(context.WithValue(r.Context(), userKey, &User{ID: role.ID, Role: role.Role, Nombre: "Test"}))
			w := httptest.NewRecorder()
			page.handler(w, r)
			body := w.Body.String()
			if w.Code != 200 || !strings.HasSuffix(body, "</html>") {
				t.Fatalf("render %s role %s code %d: %s", page.path, role.Role, w.Code, body)
			}
			if strings.Contains(body, "<script>alert(1)</script>") {
				t.Fatal("XSS")
			}
		}
	}
}

func TestBackupSQLiteSnapshotIntegrity(t *testing.T) {
	a, _, _ := fixture(t)
	name, e := a.Backup()
	if e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(name)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		t.Fatal(e)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	restored := filepath.Join(t.TempDir(), "restored.sqlite")
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		if h.Name == "database/app.sqlite" {
			data, e := io.ReadAll(tr)
			if e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(restored, data, 0600); e != nil {
				t.Fatal(e)
			}
		}
	}
	db, e := sql.Open("sqlite3", restored)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var integrity string
	if e = db.QueryRow("PRAGMA integrity_check").Scan(&integrity); e != nil || integrity != "ok" {
		t.Fatal("backup corruption", integrity, e)
	}
	var n int
	db.QueryRow("SELECT count(*) FROM users").Scan(&n)
	if n != 5 {
		t.Fatal("missing committed users", n)
	}
}
func TestMigrationsIdempotent(t *testing.T) {
	a, _, _ := fixture(t)
	if e := migrate(a.DB); e != nil {
		t.Fatal(e)
	}
	var n int
	if e := a.DB.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&n); e != nil || n != 3 {
		t.Fatal("migration versions", n, e)
	}
	var foreignKeys int
	a.DB.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys)
	if foreignKeys != 1 {
		t.Fatal("foreign keys disabled")
	}
	var journal string
	a.DB.QueryRow("PRAGMA journal_mode").Scan(&journal)
	if journal != "wal" {
		t.Fatal("WAL disabled")
	}
}

func TestImportSparseRowLimit(t *testing.T) {
	a, _, _ := fixture(t)
	f := excelize.NewFile()
	defer f.Close()
	row := []any{"Apellido", "Nombre", "9999", "", "", "", "", "valid@example.com"}
	if e := f.SetSheetRow("Sheet1", "A1", &row); e != nil {
		t.Fatal(e)
	}
	if e := f.SetCellValue("Sheet1", "A20001", "Sparse row"); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "sparse.xlsx")
	if e := f.SaveAs(path); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Import(path); e == nil {
		t.Fatal("unbounded import allowed")
	}
	var n int
	a.DB.QueryRow("SELECT count(*) FROM whitelist WHERE dni='9999'").Scan(&n)
	if n != 0 {
		t.Fatal("partial import committed on size error")
	}
}
