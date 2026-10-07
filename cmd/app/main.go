package main

import (
	"bufio"
	"cjm-lite/internal/app"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	if cmd == "healthcheck" {
		c := &http.Client{}
		r, e := c.Get("http://127.0.0.1:" + getenv("PORT", "8080") + "/healthz")
		if e != nil || r.StatusCode != 200 {
			os.Exit(1)
		}
		r.Body.Close()
		return
	}
	a, e := app.Open(getenv("DATA_DIR", "data"))
	app.Fail(e)
	defer a.DB.Close()
	switch cmd {
	case "serve":
		app.Fail(a.Serve())
	case "create-admin":
		if len(os.Args) != 4 {
			fmt.Fprintln(os.Stderr, "Uso: app create-admin NOMBRE USUARIO < password.txt")
			os.Exit(1)
		}
		p, e := bufio.NewReader(os.Stdin).ReadString('\n')
		if e != nil && p == "" {
			app.Fail(e)
		}
		app.Fail(a.CreateAdmin(0, os.Args[2], os.Args[3], strings.TrimRight(p, "\r\n")))
		fmt.Println("Primer administrador creado.")
	case "import-mediators":
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, "Uso: app import-mediators archivo.xlsx_o_csv")
			os.Exit(1)
		}
		s, e := a.Import(os.Args[2])
		app.Fail(e)
		fmt.Printf("Leídas: %d\nImportadas: %d\nDuplicadas: %d\nInválidas: %d\nEncabezados omitidos: %d\n", s.Read, s.Imported, s.Duplicates, s.Invalid, s.Headers)
		for _, e := range s.Errors {
			fmt.Println(e)
		}
	case "backup":
		name, e := a.Backup()
		app.Fail(e)
		fmt.Println(name)
	case "cleanup":
		app.Fail(a.Cleanup())
	case "migrate":
		fmt.Println("Migraciones aplicadas.")
	default:
		fmt.Fprintln(os.Stderr, "Comandos: serve, create-admin, import-mediators, backup, cleanup, migrate")
		os.Exit(1)
	}
}
func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
