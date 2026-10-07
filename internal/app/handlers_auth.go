package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (a *App) loginPage(w http.ResponseWriter, r *http.Request) {
	a.render(w, r, "Ingresar", loginTemplate, nil)
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if len(r.FormValue("username")) > 254 || len(r.FormValue("password")) > 72 {
		a.error(w, r, errors.New("Credenciales inválidas."))
		return
	}
	ip := clientIP(r)
	if limited("ip:"+ip, 120) || limited("user:"+strings.ToLower(strings.TrimSpace(r.FormValue("username"))), 15) {
		w.WriteHeader(429)
		a.render(w, r, "Espere unos minutos", `<p role="alert">Demasiados intentos. Espere 15 minutos.</p>`, nil)
		return
	}
	id, e := a.Authenticate(r.FormValue("username"), r.FormValue("password"))
	if e != nil {
		slog.Warn("fallo de login", "ip", ip)
		a.error(w, r, e)
		return
	}
	token := randomToken()
	sum := sha256.Sum256([]byte(token))
	tx, e := a.DB.Begin()
	if e != nil {
		a.error(w, r, e)
		return
	}
	defer tx.Rollback()
	old := sha256.Sum256([]byte(cookie(r, "session")))
	if _, e = tx.Exec("DELETE FROM sessions WHERE token=?", hex.EncodeToString(old[:])); e == nil {
		_, e = tx.Exec("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)", hex.EncodeToString(sum[:]), id, time.Now().UTC().Add(12*time.Hour).Format(time.RFC3339Nano))
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		a.error(w, r, e)
		return
	}
	a.setCookie(w, "session", token, 12*3600)
	a.setCookie(w, "csrf", randomToken(), 86400)
	http.Redirect(w, r, "/", 303)
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	sum := sha256.Sum256([]byte(cookie(r, "session")))
	if _, e := a.DB.Exec("DELETE FROM sessions WHERE token=?", hex.EncodeToString(sum[:])); e != nil {
		a.error(w, r, e)
		return
	}
	a.setCookie(w, "session", "", -1)
	http.Redirect(w, r, "/login", 303)
}
func (a *App) registerPage(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{}
	m := normalizeDNI(r.URL.Query().Get("dni"))
	if m != "" {
		var first, last, email string
		e := a.DB.QueryRow("SELECT nombre,apellido,email FROM whitelist WHERE dni=?", m).Scan(&first, &last, &email)
		if e != nil {
			data["Error"] = "El DNI no está habilitado o ya fue registrado."
		} else {
			data["DNI"] = m
			data["Nombre"] = first
			data["Apellido"] = last
			data["Email"] = email
		}
	}
	a.render(w, r, "Registro de mediador", registerTemplate, data)
}
func (a *App) register(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("password") != r.FormValue("confirm") {
		a.error(w, r, errors.New("Las contraseñas no coinciden."))
		return
	}
	file, _, e := r.FormFile("photo")
	if e != nil {
		a.error(w, r, errors.New("Seleccione una foto JPEG o PNG."))
		return
	}
	defer file.Close()
	photo, e := a.Image(file, "mediadores")
	if e != nil {
		a.error(w, r, e)
		return
	}
	_, e = a.Register(r.FormValue("dni"), r.FormValue("phone"), r.FormValue("password"), photo)
	if e != nil {
		os.Remove(filepath.Join(a.Dir, "uploads", photo))
		a.error(w, r, e)
		return
	}
	redirect(w, r, "/login", "Registro completado. Ya puede ingresar.")
}

// Forwarded addresses are accepted only from explicitly configured proxy networks.
func clientIP(r *http.Request) string {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	remote, e := netip.ParseAddr(ip)
	if e != nil {
		return ip
	}
	for _, raw := range strings.Split(env("TRUSTED_PROXY_CIDRS", ""), ",") {
		prefix, e := netip.ParsePrefix(strings.TrimSpace(raw))
		if e == nil && prefix.Contains(remote) {
			parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
			for i := len(parts) - 1; i >= 0; i-- {
				candidate, e := netip.ParseAddr(strings.TrimSpace(parts[i]))
				if e == nil && !prefix.Contains(candidate) {
					return candidate.String()
				}
			}
		}
	}
	return ip
}
