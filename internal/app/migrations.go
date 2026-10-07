package app

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrations embed.FS

func migrate(db *sql.DB) error {
	tx, e := db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)"); e != nil {
		return e
	}
	files, e := fs.Glob(migrations, "migrations/*.sql")
	if e != nil {
		return e
	}
	for _, file := range files {
		part := strings.Split(strings.TrimPrefix(file, "migrations/"), "_")[0]
		version, e := strconv.Atoi(part)
		if e != nil {
			return e
		}
		var exists int
		if e = tx.QueryRow("SELECT count(*) FROM schema_migrations WHERE version=?", version).Scan(&exists); e != nil {
			return e
		}
		if exists != 0 {
			continue
		}
		sqlText, e := migrations.ReadFile(file)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(string(sqlText)); e != nil {
			return fmt.Errorf("migración %s: %w", file, e)
		}
		if _, e = tx.Exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)", version); e != nil {
			return e
		}
	}
	return tx.Commit()
}
