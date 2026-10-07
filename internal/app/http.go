package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"github.com/mattn/go-sqlite3"
	"html/template"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func validEmail(s string) bool {
	v, e := mail.ParseAddress(s)
	return e == nil && v.Address == s && len(s) <= 254
}
func validDate(s string) bool { _, e := time.Parse("2006-01-02", s); return e == nil }
func number(s string) int64   { n, _ := strconv.ParseInt(s, 10, 64); return n }
func (a *App) csrf(token string) string {
	h := hmac.New(sha256.New, a.Secret)
	h.Write([]byte(token))
	return hex.EncodeToString(h.Sum(nil))
}

type contextKey int

const userKey contextKey = 1

func current(r *http.Request) *User { u, _ := r.Context().Value(userKey).(*User); return u }
func cookie(r *http.Request, name string) string {
	c, e := r.Cookie(name)
	if e != nil {
		return ""
	}
	return c.Value
}
func (a *App) setCookie(w http.ResponseWriter, name, value string, seconds int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: a.Production, SameSite: http.SameSiteLaxMode, MaxAge: seconds})
}
func (a *App) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		if a.Production {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
		token := cookie(r, "session")
		if token != "" {
			sum := sha256.Sum256([]byte(token))
			var u User
			e := a.DB.QueryRow("SELECT u.id,u.role,u.username,coalesce(u.dni,''),u.nombre,u.apellido,u.email,u.telefono,u.photo,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1", hex.EncodeToString(sum[:]), stamp()).Scan(&u.ID, &u.Role, &u.Username, &u.DNI, &u.Nombre, &u.Apellido, &u.Email, &u.Telefono, &u.Photo, &u.Active)
			if e == nil {
				r = r.WithContext(context.WithValue(r.Context(), userKey, &u))
			} else if !errors.Is(e, sql.ErrNoRows) {
				slog.Error("lectura de sesión", "error", e)
			}
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
				if e := r.ParseMultipartForm(1 << 20); e != nil {
					http.Error(w, "El archivo o formulario supera el límite permitido.", 400)
					return
				}
				defer r.MultipartForm.RemoveAll()
			} else if e := r.ParseForm(); e != nil {
				http.Error(w, "Formulario inválido.", 400)
				return
			}
			base := cookie(r, "csrf")
			if base == "" || !hmac.Equal([]byte(r.FormValue("csrf")), []byte(a.csrf(base))) {
				http.Error(w, "El formulario venció. Recargue la página.", 403)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				expected := env("PUBLIC_URL", "http://localhost:8090")
				if strings.TrimRight(origin, "/") != strings.TrimRight(expected, "/") {
					http.Error(w, "Origen inválido.", 403)
					return
				}
			}
		}
		for _, key := range []string{"date", "from", "to"} {
			if values := r.Form[key]; len(values) > 0 {
				r.Form[key][0] = dateInput(values[0])
			}
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) protected(role string, f http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := current(r)
		if u == nil {
			http.Redirect(w, r, "/login", 303)
			return
		}
		if role != "" && u.Role != role {
			http.Error(w, "No tiene permiso para acceder.", 403)
			return
		}
		f(w, r)
	}
}
func (a *App) Serve() error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if e := a.DB.Ping(); e != nil {
			http.Error(w, "base no disponible", 503)
			return
		}
		w.Write([]byte("ok"))
	})
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	mux.HandleFunc("GET /uploads/{kind}/{file}", a.protected("", a.upload))
	mux.HandleFunc("GET /login", a.loginPage)
	mux.HandleFunc("POST /login", a.login)
	mux.HandleFunc("GET /registro", a.registerPage)
	mux.HandleFunc("POST /registro", a.register)
	mux.HandleFunc("POST /logout", a.logout)
	mux.HandleFunc("GET /{$}", a.protected("", a.home))
	mux.HandleFunc("GET /calendario", a.protected("", a.calendar))
	mux.HandleFunc("GET /mediadores/buscar", a.protected("MEDIADOR", a.mediatorSearch))
	mux.HandleFunc("GET /reservar", a.protected("MEDIADOR", a.reservePage))
	mux.HandleFunc("POST /reservar", a.protected("MEDIADOR", a.reserve))
	mux.HandleFunc("GET /mis-mediaciones", a.protected("MEDIADOR", a.myMediations))
	mux.HandleFunc("POST /cancelar", a.protected("MEDIADOR", a.cancel))
	mux.HandleFunc("GET /admin/mediaciones", a.protected("ADMIN", a.adminMediations))
	mux.HandleFunc("GET /admin/estado", a.protected("ADMIN", a.statePage))
	mux.HandleFunc("POST /admin/estado", a.protected("ADMIN", a.stateSave))
	mux.HandleFunc("GET /admin/editar", a.protected("ADMIN", a.editPage))
	mux.HandleFunc("POST /admin/editar", a.protected("ADMIN", a.edit))
	mux.HandleFunc("GET /admin/usuarios", a.protected("ADMIN", a.users))
	mux.HandleFunc("POST /admin/usuarios", a.protected("ADMIN", a.manageUser))
	mux.HandleFunc("POST /admin/crear-admin", a.protected("ADMIN", a.createAdmin))
	mux.HandleFunc("GET /admin/bloqueos", a.protected("ADMIN", a.blocks))
	mux.HandleFunc("POST /admin/bloqueos", a.protected("ADMIN", a.block))
	mux.HandleFunc("GET /admin/noticias", a.protected("ADMIN", a.newsPage))
	mux.HandleFunc("POST /admin/noticias", a.protected("ADMIN", a.newsSave))
	mux.HandleFunc("GET /admin/dnis", a.protected("ADMIN", a.whitelist))
	mux.HandleFunc("GET /admin/matriculas", a.protected("ADMIN", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/admin/dnis", http.StatusSeeOther) }))
	mux.HandleFunc("POST /admin/dnis", a.protected("ADMIN", a.enableDNI))
	mux.HandleFunc("POST /admin/importar", a.protected("ADMIN", a.importFile))
	mux.HandleFunc("GET /admin/exportaciones", a.protected("ADMIN", a.exports))
	mux.HandleFunc("POST /admin/exportar", a.protected("ADMIN", a.export))
	mux.HandleFunc("GET /admin/descargar/{file}", a.protected("ADMIN", a.download))
	mux.HandleFunc("GET /admin/auditoria", a.protected("ADMIN", a.audits))
	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: a.guard(mux), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if e := a.Cleanup(); e != nil {
					slog.Error("limpieza", "error", e)
				}
			case <-ctx.Done():
				c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				srv.Shutdown(c)
				return
			}
		}
	}()
	if e := a.Cleanup(); e != nil {
		return e
	}
	slog.Info("servidor iniciado", "address", srv.Addr)
	e := srv.ListenAndServe()
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
func (a *App) upload(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	file := r.PathValue("file")
	if (kind != "mediadores" && kind != "news") || filepath.Base(file) != file || !strings.HasSuffix(file, ".jpg") {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(a.Dir, "uploads", kind, file))
}
func (a *App) render(w http.ResponseWriter, r *http.Request, title, body string, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	base := cookie(r, "csrf")
	if base == "" {
		base = randomToken()
		a.setCookie(w, "csrf", base, 86400)
	}
	data["CSRF"] = a.csrf(base)
	data["User"] = current(r)
	data["Title"] = title
	data["Message"] = r.URL.Query().Get("mensaje")
	data["Sedes"] = Sedes
	data["Today"] = a.now().Format("2006-01-02")
	t, e := template.New("page").Funcs(template.FuncMap{"states": func() []string {
		return []string{"RESERVADA", "INICIADA", "FINALIZADA", "FIRMADA", "CANCELADA_POR_ADMIN"}
	}, "editableStates": func() []string { return []string{"RESERVADA", "INICIADA", "FINALIZADA", "FIRMADA"} }, "results": func() []string { return []string{"CON_ACUERDO", "SIN_ACUERDO", "INCOMPARECENCIA"} }, "eqInt": func(a, b int64) bool { return a == b }, "dateES": dateES, "timestampES": a.timestampES, "detailES": detailES}).Parse(layout + body + "{{end}}")
	if e != nil {
		slog.Error("template", "error", e)
		http.Error(w, "Error de pantalla.", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if e = t.Execute(w, data); e != nil {
		slog.Error("render", "error", e)
	}
}
func redirect(w http.ResponseWriter, r *http.Request, path, message string) {
	http.Redirect(w, r, path+"?mensaje="+url.QueryEscape(message), 303)
}
func (a *App) error(w http.ResponseWriter, r *http.Request, e error) {
	slog.Warn("operación rechazada", "path", r.URL.Path, "error", e)
	w.WriteHeader(400)
	var dbError sqlite3.Error
	var pathError *os.PathError
	message := e.Error()
	if errors.As(e, &dbError) || errors.As(e, &pathError) || errors.Is(e, sql.ErrNoRows) {
		message = "No se pudo completar la operación. Verifique los datos o intente nuevamente."
	}
	a.render(w, r, "No se pudo completar", `<section class="card"><h2>No se pudo completar</h2><p role="alert">{{.Error}}</p><a class="button" href="{{.Back}}">Volver</a></section>`, map[string]any{"Error": message, "Back": safeBack(r)})
}
func safeBack(r *http.Request) string {
	u, e := url.Parse(r.Referer())
	if e == nil && u.Host == r.Host && strings.HasPrefix(u.Path, "/") {
		return u.RequestURI()
	}
	return "/"
}

type attempts struct {
	N     int
	Until time.Time
}

var loginLimit = struct {
	sync.Mutex
	Values map[string]attempts
}{Values: map[string]attempts{}}

func limited(key string, max int) bool {
	loginLimit.Lock()
	defer loginLimit.Unlock()
	now := time.Now()
	if len(loginLimit.Values) > 4096 {
		for k, v := range loginLimit.Values {
			if now.After(v.Until) {
				delete(loginLimit.Values, k)
			}
		}
		if len(loginLimit.Values) > 4096 {
			return true
		}
	}
	v := loginLimit.Values[key]
	if now.After(v.Until) {
		v = attempts{0, now.Add(15 * time.Minute)}
	}
	v.N++
	loginLimit.Values[key] = v
	return v.N > max
}
