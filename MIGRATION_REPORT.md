# Informe de migración · CJM Lite → Cloudflare

## Estado final

**Implementación, paridad local y despliegue remoto verificados.** Publicado en https://cjm-lite.gondutarigd.workers.dev con D1/R2 y cinco migraciones aplicadas. Se corrigió APP_ENV a production, APP_URL a la URL real y un SESSION_SECRET insuficiente. No se utilizó una cuenta de preview anónima ni se activó un plan pago.

La aplicación activa de desarrollo es `http://localhost:8787`. El primer administrador se crea con el bootstrap documentado; no se trasladaron cuentas/contraseñas antiguas, conforme a la autorización del usuario.

## Arquitectura y archivos

- `src/index.ts`: único Worker Hono; health, assets, rutas y scheduled cleanup.
- `src/routes/auth.ts`, `mediator.ts`, `admin.ts`: todas las pantallas/operaciones existentes, sin SPA.
- `src/services/`: auth, usuarios, reservas, noticias, exportaciones, auditoría y acceso D1 preparado.
- `src/views/`: composición HTML con escape, layout original y fragments HTMX.
- `src/lib/`: zona Córdoba, fechas, validación, Web Crypto y R2 privado.
- `src/config/sites.ts`: Cosquín y configuración central validada; mismos cinco slots de 90 minutos y una sala.
- `public/static/`: CSS y HTMX originales; JS mínimo adicional necesario para PBKDF2, imágenes e import/export browser.
- `migrations/0001..0005`: esquema compatible, DNI y extensiones técnicas para Cloudflare.
- `wrangler.toml`, `package.json`, lockfile, tsconfig y Vitest: desarrollo/build/test/deploy reproducibles.
- `scripts/bootstrap.mjs`, `local-env.mjs`: primer admin seguro y secretos locales aleatorios.
- `scripts/migrate-sqlite-to-d1/`, `migrate-uploads-to-r2/`: snapshot/dump/counts/FKs/objetos y actualización de referencias.
- `scripts/browser-smoke.mjs`, `browser-flow.cjs`: flujo real en Chromium, con D1/R2 aislados que se eliminan al finalizar.
- `docs/cloudflare-migration-plan.md`, `password-migration.md`, `sqlite-to-d1.md`, README: auditoría, decisiones y operación.

**Retirado a pedido del usuario:** cmd/, internal/, web/, Go modules, Dockerfile, Compose/Caddy, configuración y scripts de runtime Go. Se detuvo/retiró el contenedor legacy. El volumen original y los backups se conservan para recuperar datos; no son dependencia del nuevo runtime. El código previo está en Git, commit `00cbda9`.

## Paridad y diferencias necesarias

Se conservan DNI, carga manual/CSV/XLSX, registro habilitado transaccional, dos roles, búsqueda en vivo por tokens/tildes, activación/desactivación, reset manual, sesiones, calendarios de lunes a viernes, anticipación de un mes calendario, conflictos por intervalos entre sedes, reservas compartidas, cancelación antes del inicio, ayer/hoy/mañana, filtros de estado/resultado, botones Editar/Estado separados, noticias, auditoría y retención segura. No hay firma digital ni nuevos estados.

CSS idéntico al original: SHA-256 `bf9111f46aeeb8a5e14da750ba9dece85650c709bb0393a63cf4fee69de43dfb`.

Cambios técnicamente necesarios:

1. D1 usa escritura condicional/batch en lugar de BEGIN IMMEDIATE local.
2. R2 reemplaza filesystem; archivos privados servidos con sesión y referencia D1 válida. Imágenes privadas usan no-store.
3. Imágenes se reducen en browser; Worker valida cabecera MIME, dimensiones ≤800 y ≤512 KB. Original ≤5 MB/20 MP en formulario.
4. CSV/XLSX se parsea en browser y se confirma por lotes de 40, revalidando backend. Lotes son idempotentes; no existe rollback global entre requests de una importación grande.
5. XLSX se genera en browser, se guarda en R2 y luego se registran export/versions en D1. Hasta 5.000 filas por archivo; rangos mayores se dividen.
6. Passwords: cambio expresamente autorizado a PBKDF2-HMAC-SHA256 estándar de 600k iteraciones en browser + verificador HMAC con pepper en Worker. Login requiere JavaScript. Ver documentación de seguridad/longitud declarada y persistencia de SESSION_SECRET.
7. Política actual autorizada posteriormente: limpieza diaria de todas las mediaciones al cumplir siete días, independientemente de exportación.

## Schema D1 e índices

Tablas de negocio conservadas: users, whitelist, mediations, blocked_days, news, sessions, exports, audit_log, schema_migrations. `matricula` fue renombrada a `dni` como en la versión Go actual. Sin columnas de negocio eliminadas.

Adiciones técnicas: `users.search_text` normalizado, `mediations.version`, `sessions.created_at`, `exports.manifest` y `login_attempts` para rate limiting persistente. Wrangler administra `d1_migrations`.

Índices: DNI y username únicos, sessions/token y expires_at; slot sede/date/start; m1/date y m2/date; date/start; pendiente export por date; noticias published/publication_date; role/active/apellido/nombre; email; date/state/result/start; exported_at/date; blocked_days/date; login_attempts/expires_at; id/version para exportación. FK y CHECK preservan roles, estados/resultados y participantes diferentes.

## Concurrencia y tiempo

Reservar es **INSERT SELECT WHERE**, con capacidad, participantes activos, bloqueo, horario/configuración, rango, día hábil y conflictos en la escritura. Editar asignación es UPDATE condicional equivalente que excluye su propio ID. Cambiar carátula/expediente de una mediación pasada conserva estado/resultado sin exigir una nueva fecha futura.

El reloj decisivo se evalúa dentro de D1, con un modificador de zona obtenido explícitamente de America/Argentina/Cordoba; no se depende del UTC implícito del runtime ni de una hora anterior al encolado de la escritura. Un CTE calcula el mes siguiente ajustando fin de mes. La hora de test puede inyectarse únicamente en llamadas internas de tests, no en requests.

Operación/auditoría se agrupan en D1 batch; audits condicionales dependen de changes(). Se comprobó rollback al fallar la auditoría. Cancelación auditada decide antes del inicio dentro del batch y elimina solo si esa auditoría se insertó. Reset/desactivación invalidan sesiones incluso cuando un admin se desactiva a sí mismo.

## Exportación y retención

Dataset paginado de 100 filas con HMAC por página de pares ID/version, ligado a admin/rango. Confirmación rechaza pages/manifests alterados. Un UPDATE por `(id,version)` marca solamente filas idénticas a las incluidas en el archivo; una edición o bloqueo incrementa versión y quita la marca. Export/audit/marcas son un batch. R2 recibe el XLSX antes de ese batch.

**Fallo de transporte ambiguo:** no se borra el objeto durable si D1 pudo haber confirmado la transacción antes de fallar la respuesta. Se prefiere un objeto adicional a dejar registros exportados apuntando a un archivo perdido. La misma precaución se aplica a fotos/noticias al fallar D1 de forma ambigua. No hay limpieza automática de objetos huérfanos.

La política anterior se reemplazó a pedido del usuario: la limpieza elimina todas las mediaciones al cumplir siete días desde su fecha, exportadas o no. XLSX/objetos ya guardados permanecen disponibles.

## Datos originales y autorización del reset

Conteos de la copia original: {"users": 4, "whitelist": 26, "mediations": 1, "blocked_days": 1, "news": 0, "sessions": 1, "audit_log": 17, "exports": 0}.

Por instrucción del usuario, D1 activo inicia sin esos usuarios/contraseñas/sesiones. Se importaron whitelist, noticias y bloqueos y se verificaron counts/FK. Las mediaciones/auditorías/export metadata que referencian cuentas descartadas quedan íntegros en snapshot y dump privados; no se inventaron usuarios ni se borró su historia original. Los archivos de perfiles excluidos permanecen en el backup. Este corte fresco es una decisión de migración autorizada, no una nueva política de retención del sistema.

Respaldo inicial legacy: `/data/backups/backup-42f82f7cbb2b7ade.tar.gz`, copia de trabajo y `.migration/initial/original.sqlite` + `original-all-data.sql` protegidos y excluidos de Git. Para el corte remoto debe realizarse una copia final si hubo escrituras posteriores en la versión anterior.

## Tests y resultados

- `npm run typecheck`: pasó.
- `npm test`: **22 tests pasaron**, ejecutados en runtime Workers con D1/R2 reales emulados.
- Concurrencia por último cupo: un éxito/un conflicto, incluyendo dos solicitudes HTTP y movimientos administrativos simultáneos.
- Conflictos m1/m2/cruzados y solapamiento entre sedes; límites, weekend, bloqueos y cancelación en el instante de comienzo.
- Registro/duplicados, roles/CSRF, login, reset, desactivación propia y último admin.
- Estado/resultado, rollback al fallar audit, import, R2, escape HTML y fragments.
- Export durable, firma/manifests, versión editada pendiente, retención y preservación de objeto ante error ambiguo.
- `npm run test:browser`: pasó con Chrome desktop/móvil, PBKDF2 real, CSV/XLSX real y Unicode, preview, resize 1200→800, R2 autenticado, búsqueda en vivo, reserva compartida, edición/estado, download XLSX que se abrió y verificó, noticias y bloqueos.
- Scripts de migración probados con fixture SQLite/PNG: snapshot read-only, import D1, upload R2, cambio de referencia e idempotencia al repetir.
- D1 local: cinco migraciones aplicadas; padrón real importado y counts/FKs verificados.
- `npm run build`: Total Upload: 143.55 KiB / gzip: 38.87 KiB; dry-run exitoso, sin importar APIs fs/process/socket en el Worker.
- `npm audit`: **0 vulnerabilidades reportadas en dependencias npm**. No equivale a certificar software o librerías vendorizadas contra todo fallo posible.
- `git diff --check`: pasó. `/healthz`: ok en http://localhost:8787.

## Deploy y riesgos conocidos

README contiene npm install/dev, wrangler login, d1 create, r2 bucket create, secrets, migrations y deploy. Bindings: DB, FILES, ASSETS. El ID D1 de ceros es únicamente desarrollo y se reemplaza al crear la base remota. R2 no debe tener acceso público.

**Pendiente operativo:** crear el primer administrador remoto y medir uso bajo carga real. Login y healthcheck remotos responden 200; cookies Secure/HSTS y rechazo correcto de credenciales con Origin/CSRF válidos comprobados. No se certificó CPU Free bajo carga remota usando tests locales. R2 puede requerir activar su producto/billing; consumo esperado muy por debajo de las cuotas Free, sin habilitar planes pagos desde esta sesión.

Estimación cualitativa: favorable para ~500 mediadores y picos ~100 usuarios con los cinco slots diarios de Cosquín. HTML/CSS ligeros, assets directos, queries acotadas/indexadas, sin polling, XLSX/imagen/PBKDF2 fuera del Worker. Vigilar requests, CPU, filas/index writes y R2; imports/exports masivos y búsquedas intensivas pueden agotar cuotas. Exportar por rangos, conservar SESSION_SECRET, respaldar D1/R2 externamente y revisar métricas antes del corte.

Fuentes oficiales de límites y semántica: [Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Verificación del despliegue posterior

Versión corregida: `1eb5540f-d5c8-48f2-ba62-2e8e31283db9`. El secreto fue renovado antes de existir usuarios remotos, sin invalidar contraseñas. Respaldo privado en `.migration/production-secrets/SESSION_SECRET`, mode 0600, excluido de Git: copiar a un lugar seguro externo antes de limpiar esa carpeta. El padrón pendiente y bloqueos se copiaron con el procedimiento y se verifican contra el manifest de migración.

## Cambio de subdominio solicitado

URL actual: https://cjm-lite.mediacionescba.workers.dev. APP_URL actualizado después de que el usuario cambió el subdominio de la cuenta. Se conserva el mismo Worker y los bindings D1/R2.

## Mejoras posteriores solicitadas

Perfil editable propio (datos/foto, DNI fijo y sin cambio de contraseña); autocompletado de mediadores en reserva y edición, por DNI/formato/texto; exportación opcional y retención automática de siete días; UI de Auditoría retirada, manteniendo el audit_log funcional en D1. Logging técnico JSON solo en Workers Logs (retención Free actual de tres días), helper central y `invocation_logs=false`, sin tabla ni bucket técnico. Respaldo privado anterior al cambio: `.migration/backups/before-seven-day-retention.sql`.

## Estado directo en la tabla

La administración de mediaciones ahora permite cambiar estado desde un desplegable en cada fila, guardando automáticamente. Finalizada/Firmada requieren seleccionar resultado en esa misma fila. Se conserva autorización, CSRF y auditoría transaccional; no se necesita abrir la pantalla separada. Verificado con 31 tests y Chrome.
