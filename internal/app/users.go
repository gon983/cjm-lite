package app

import (
	"database/sql"
	"errors"
	"golang.org/x/crypto/bcrypt"
	"strings"
)

type User struct {
	ID                                                            int64
	Role, Username, DNI, Nombre, Apellido, Email, Telefono, Photo string
	Active                                                        bool
}

var passwordWork = make(chan struct{}, 2)

func passwordPermit() bool {
	select {
	case passwordWork <- struct{}{}:
		return true
	default:
		return false
	}
}
func hashPassword(p string) ([]byte, error) {
	if !passwordPermit() {
		return nil, errors.New("El servicio está ocupado. Intente nuevamente.")
	}
	defer func() { <-passwordWork }()
	if len(p) < 12 || len(p) > 72 {
		return nil, errors.New("La contraseña debe tener entre 12 y 72 bytes.")
	}
	return bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)
}
func (a *App) CreateAdmin(actor int64, name, username, password string) error {
	if strings.TrimSpace(name) == "" || len(name) > 100 || strings.TrimSpace(username) == "" || len(username) > 254 {
		return errors.New("Complete nombre y usuario válidos.")
	}
	h, e := hashPassword(password)
	if e != nil {
		return e
	}
	tx, e := a.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var n int
	if actor == 0 {
		e = tx.QueryRow("SELECT count(*) FROM users WHERE role='ADMIN'").Scan(&n)
		if e != nil {
			return e
		}
		if n > 0 {
			return errors.New("El primer administrador ya existe; use el panel.")
		}
	} else if e = requireAdmin(tx, actor); e != nil {
		return e
	}
	r, e := tx.Exec("INSERT INTO users(role,username,nombre,password,created_at,updated_at) VALUES('ADMIN',?,?,?,?,?)", strings.ToLower(strings.TrimSpace(username)), strings.TrimSpace(name), h, stamp(), stamp())
	if e != nil {
		return e
	}
	id, _ := r.LastInsertId()
	if e = audit(tx, actor, "CREATE_ADMIN", "users", id, ""); e != nil {
		return e
	}
	return tx.Commit()
}
func requireAdmin(tx *sql.Tx, id int64) error {
	var n int
	err := tx.QueryRow("SELECT count(*) FROM users WHERE id=? AND role='ADMIN' AND active=1", id).Scan(&n)
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("Solo un administrador activo puede realizar esta operación.")
	}
	return nil
}
func (a *App) Register(m, phone, password, photo string) (int64, error) {
	m = normalizeDNI(m)
	if !validDNI(m) || strings.TrimSpace(phone) == "" || len(phone) > 60 || photo == "" {
		return 0, errors.New("Complete DNI, teléfono y foto.")
	}
	h, e := hashPassword(password)
	if e != nil {
		return 0, e
	}
	tx, e := a.DB.Begin()
	if e != nil {
		return 0, e
	}
	defer tx.Rollback()
	var name, last, email string
	e = tx.QueryRow("SELECT nombre,apellido,email FROM whitelist WHERE dni=?", m).Scan(&name, &last, &email)
	if e != nil {
		return 0, errors.New("El DNI no está habilitado o ya fue registrado.")
	}
	r, e := tx.Exec("INSERT INTO users(role,username,dni,nombre,apellido,email,telefono,photo,password,created_at,updated_at) VALUES('MEDIADOR',?,?,?,?,?,?,?,?,?,?)", m, m, name, last, email, strings.TrimSpace(phone), photo, h, stamp(), stamp())
	if e != nil {
		return 0, e
	}
	id, _ := r.LastInsertId()
	if _, e = tx.Exec("DELETE FROM whitelist WHERE dni=?", m); e != nil {
		return 0, e
	}
	if e = audit(tx, id, "REGISTER", "users", id, ""); e != nil {
		return 0, e
	}
	return id, tx.Commit()
}
func (a *App) Authenticate(username, password string) (int64, error) {
	if !passwordPermit() {
		return 0, errors.New("El servicio está ocupado. Intente nuevamente.")
	}
	defer func() { <-passwordWork }()
	var id int64
	var hash []byte
	var active bool
	e := a.DB.QueryRow("SELECT id,password,active FROM users WHERE username=? OR (role='MEDIADOR' AND dni=?) ORDER BY CASE WHEN username=? THEN 0 ELSE 1 END LIMIT 1", strings.ToLower(strings.TrimSpace(username)), normalizeDNI(username), strings.ToLower(strings.TrimSpace(username))).Scan(&id, &hash, &active)
	if e != nil {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return 0, errors.New("Credenciales inválidas o cuenta inactiva.")
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil || !active {
		return 0, errors.New("Credenciales inválidas o cuenta inactiva.")
	}
	return id, nil
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password-value"), bcrypt.DefaultCost)

func (a *App) ManageUser(actor, id int64, action, password string) error {
	var h []byte
	var err error
	if action == "reset" {
		h, err = hashPassword(password)
		if err != nil {
			return err
		}
	}
	tx, err := a.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = requireAdmin(tx, actor); err != nil {
		return err
	}
	var role string
	var active bool
	if err = tx.QueryRow("SELECT role,active FROM users WHERE id=?", id).Scan(&role, &active); err != nil {
		return err
	}
	if action == "toggle" {
		if role == "ADMIN" && active {
			var n int
			tx.QueryRow("SELECT count(*) FROM users WHERE role='ADMIN' AND active=1").Scan(&n)
			if n <= 1 {
				return errors.New("No se puede desactivar al último administrador.")
			}
		}
		_, err = tx.Exec("UPDATE users SET active=?,updated_at=? WHERE id=?", !active, stamp(), id)
	} else if action == "reset" {
		_, err = tx.Exec("UPDATE users SET password=?,updated_at=? WHERE id=?", h, stamp(), id)
	} else {
		return errors.New("Acción inválida.")
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM sessions WHERE user_id=?", id); err != nil {
		return err
	}
	if err = audit(tx, actor, action, "users", id, ""); err != nil {
		return err
	}
	return tx.Commit()
}
func normalizeDNI(s string) string {
	s = strings.ReplaceAll(strings.Join(strings.Fields(s), ""), ".", "")
	return strings.TrimLeft(s, "0")
}
func validDNI(s string) bool {
	if len(s) < 1 || len(s) > 8 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
