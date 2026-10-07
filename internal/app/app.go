package app

import (
	"database/sql"
	"errors"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type App struct {
	DB         *sql.DB
	Dir        string
	Location   *time.Location
	Secret     []byte
	Production bool
	Now        func() time.Time
}

func Open(dir string) (*App, error) {
	if err := validateSedes(); err != nil {
		return nil, err
	}
	if dir == "" {
		dir = "data"
	}
	for _, p := range []string{"database", "uploads/mediadores", "uploads/news", "exports", "backups"} {
		if err := os.MkdirAll(filepath.Join(dir, p), 0700); err != nil {
			return nil, err
		}
	}
	loc, err := time.LoadLocation(env("TZ", "America/Argentina/Cordoba"))
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", filepath.Join(dir, "database/app.sqlite")+"?_journal_mode=WAL&_foreign_keys=on&_busy_timeout=10000&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err = migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	secret := []byte(os.Getenv("SESSION_SECRET"))
	prod := os.Getenv("APP_ENV") == "production"
	if prod && !strings.HasPrefix(env("PUBLIC_URL", ""), "https://") {
		db.Close()
		return nil, errors.New("PUBLIC_URL debe usar https en producción")
	}
	if prod && len(secret) < 32 {
		db.Close()
		return nil, errors.New("SESSION_SECRET debe tener al menos 32 caracteres en producción")
	}
	if len(secret) < 32 {
		path := filepath.Join(dir, "session-secret")
		secret, err = os.ReadFile(path)
		if os.IsNotExist(err) {
			secret = []byte(randomToken())
			err = os.WriteFile(path, secret, 0600)
		}
		if err != nil {
			return nil, err
		}
	}
	return &App{db, dir, loc, secret, prod, time.Now}, nil
}
func (a *App) now() time.Time { return a.Now().In(a.Location) }
func stamp() string           { return time.Now().UTC().Format(time.RFC3339Nano) }
func audit(tx *sql.Tx, actor int64, action, entity string, id int64, detail string) error {
	var who any
	if actor != 0 {
		who = actor
	}
	_, err := tx.Exec("INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at,detail) VALUES(?,?,?,?,?,?)", who, action, entity, id, stamp(), detail)
	return err
}
func (a *App) Cleanup() error {
	cut := a.now().AddDate(0, 0, -7).Format("2006-01-02")
	tx, err := a.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM sessions WHERE expires_at < ?", stamp()); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM mediations WHERE date < ? AND exported_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mediations other WHERE other.date=mediations.date AND other.exported_at IS NULL)", cut); err != nil {
		return err
	}
	return tx.Commit()
}
func Fail(err error) {
	if err != nil {
		slog.Error("operación fallida", "error", err)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
