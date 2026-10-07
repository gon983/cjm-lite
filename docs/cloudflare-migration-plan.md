# Auditoría y plan de migración Cloudflare

Se inspeccionó el monolito existente antes de modificar código. Base: commit `00cbda9`.

## Inventario

- `cmd/app/main.go`: servidor y CLI (primer admin, importación, backup, migración y limpieza).
- `internal/app/http.go`: router, middleware, authz, CSRF HMAC, cabeceras y render Go html/template.
- `handlers_auth.go`, `handlers_calendar.go`, `handlers_admin.go`, `improvements.go`: todas las rutas de negocio.
- `templates.go`: layout, login/registro, dashboard, noticias, calendario semanal, reserva, mis mediaciones, panel diario, editar, estado, usuarios, DNI habilitados, exportaciones, bloqueos, auditoría y selector HTMX.
- `static/app.css`, `app.js`, `htmx.min.js`: apariencia sobria responsive; HTMX 2; búsqueda en vivo, filtros y navegación semanal.
- `users.go`, `mediations.go`, `config.go`: roles, DNI, bcrypt coste 10, sesiones SHA-256, reservas con BEGIN IMMEDIATE, conflictos por intervalos entre sedes, reglas de fecha y Cosquín.
- `migrations/001..003`: users, whitelist, sessions, mediations, blocked_days, news, exports, audit_log y schema_migrations. La migración 003 adoptó **DNI**, no matrícula.
- `imports.go`: CSV/XLSX, codificación UTF-8/Windows-1252/UTF-16/UTF-32, encabezados repetidos/reordenados, duplicados y límite de 20.000 filas.
- `storage.go`: JPEG optimizado ≤800px, XLSX duradero, snapshot VACUUM INTO y backup con imágenes/exports.
- `app_test.go`, `imports_test.go`, `improvements_test.go`: 28 tests de negocio, concurrencia entre dos conexiones, retención, seguridad, formatos y migración DNI.
- `scripts/smoke.py`: flujo HTTP completo, carga de archivos y 100 lecturas concurrentes; pruebas adicionales Chrome realizadas durante desarrollo.
- Dockerfile multi-stage CGO + Debian no-root, Compose con volumen `/data`, HTTPS Caddy opcional. Se conservarán como referencia hasta la paridad.

## Actual → destino → cambio necesario

| Actual | Destino | Cambio necesario |
| --- | --- | --- |
| Go ServeMux / handlers | Un Worker TypeScript + Hono | Portar todas las rutas y conservar URLs |
| SQLite + BEGIN IMMEDIATE | D1 | SQL condicional atómico y batch transaccional con auditoría |
| SQLite schema 003 | D1 migrations | Conservar columnas, IDs, constraints y DNI; índices adicionales |
| html/template | Views HTML TypeScript | Escape HTML y mismo layout, CSS, etiquetas y formularios |
| HTMX con páginas hx-select | HTMX con fragments reales | Respuestas parciales en HX-Request y páginas en navegación normal |
| Fotos/news filesystem | R2 privado | Browser reduce imágenes; Worker valida MIME, dimensiones/tamaño y autorización |
| Exportaciones XLSX filesystem | XLSX browser + R2 | Dataset paginado, archivo guardado, confirmación con versiones; impedir marcar filas modificadas |
| Importador XLSX/CSV Go | Parser browser + lotes JSON | Mantener CSV Unicode, preview, validación server-side y duplicados |
| Bcrypt coste 10 | Web Crypto + compatibilidad documentada | Medir CPU y acordar transición de hashes existentes; no invalidar usuarios silenciosamente |
| Sesiones SHA-256 SQLite | Sesiones SHA-256 D1 | HttpOnly/Secure/SameSite=Lax, expiración y revocación por reset/desactivación |
| CSRF HMAC cookie | Web Crypto HMAC cookie | Mantener protección en formularios/JSON/uploads y comprobar origen |
| Rate limit en RAM | Rate limit lógico D1 | Contadores limitados/indexados por IP/cuenta; limpieza |
| Cosquín en config.go | src/config/sites.ts | Misma sede, capacidad, slots y extensibilidad sin CRUD |
| Zona Córdoba y dd/mm/aaaa | Helpers explícitos Intl/UTC | Sin depender del TZ de Workers; mes calendario con ajuste del último día |
| Limpieza horaria Go | Worker scheduled + comando | Solo días totalmente exportados, antigüedad mayor a siete días |
| Backup local | D1 export/Time Travel + copia R2 | Scripts reproducibles, copia original intacta y verificación FK/counts |
| Docker runtime | Wrangler | Desarrollo local y deploy sin servidor Node ni Docker en producción |

## Reglas que permanecen

Únicamente ADMIN y MEDIADOR. Identificación **DNI**, carga manual y CSV/XLSX; no se vuelve a matrícula pese a que el pedido genérico la menciona. Calendario lunes a viernes, anticipación de un mes calendario en Córdoba, cancelación por participante antes del inicio aun si cambió el estado administrativo. Los estados son RESERVADA, INICIADA, FINALIZADA, FIRMADA y CANCELADA_POR_ADMIN; los administradores eligen libremente los cuatro primeros, con resultado obligatorio al finalizar/firmar. Editar y Estado siguen separados. Un bloqueo cancela todas las reservas; desbloquear no las restaura. No se borran usuarios. Ningún registro sin exportar se limpia.

## Concurrencia y consistencia

Las reservas usan INSERT SELECT con todas las condiciones dentro de la escritura; edición usa UPDATE condicional con las mismas reglas, excluyendo su ID. Los conflictos consideran duración por sede, no solo igualdad del inicio. Cada operación sensible y su audit se agrupan en D1 batch; los audits condicionales dependen de la escritura previa. No hay SELECT disponibilidad seguido de INSERT desprotegido. Las exportaciones confirman únicamente versiones incluidas en un XLSX que ya está en R2.

## Etapas de verificación

1. Base Wrangler, D1 schema y tests SQL atómicos.
2. Sesiones, CSRF, authz y estrategia de password explícita.
3. Views conservadas y rutas completas.
4. R2, imágenes browser, import/export XLSX y CSV.
5. Scripts de migración y backups sin tocar la base original.
6. Tests integrales Workers/D1/R2 local, concurrencia, navegador, typecheck y build.
7. Informe final y comandos de despliegue. No se publicará sin cuenta Cloudflare autenticada; paridad local no equivale a medición remota del límite CPU Free.

## Límites y fuentes oficiales

D1 batch es transaccional: https://developers.cloudflare.com/d1/worker-api/d1-database/ . Free HTTP CPU se verifica en https://developers.cloudflare.com/workers/platform/limits/ . D1 cuotas: https://developers.cloudflare.com/d1/platform/pricing/ . R2: https://developers.cloudflare.com/r2/pricing/ . XLSX, conversión de imágenes y compatibilidad bcrypt no deben ejecutarse como cómputo JS pesado en el Worker. Se medirán y documentarán las limitaciones de autenticación antes del cutover.

## Limpieza autorizada después de la verificación

El usuario solicitó retirar todo el runtime antiguo. Tras pasar los tests D1/R2 y el flujo integral de navegador, se retiraron cmd/, internal/, web/, Go modules, Docker/Compose/Caddy y scripts de ejecución Go. El servicio Docker se detuvo y se retiró su contenedor sin borrar el volumen original. El respaldo privado y los scripts de migración se conservan; el commit `00cbda9` permite recuperar el código legacy.
