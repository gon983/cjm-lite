# CJM Lite

Sistema pequeño de gestión de mediaciones del Centro Judicial de Mediación de Córdoba. Un servicio Go, SQLite en WAL, HTML renderizado en servidor, HTMX local y archivos en un volumen persistente. Sin servidor Node, SPA ni servicios de datos adicionales.

## Desarrollo y primera ejecución

Requisitos: Docker con Docker Compose. No necesita instalar Go en el host.

```bash
cp .env.example .env
docker compose up -d
```

Abrir **http://localhost:8090**. El servicio escucha internamente en 8080; `PORT` configura el puerto publicado del host. El enlace predeterminado es local (`127.0.0.1`).

```bash
docker compose ps
docker compose logs --tail=100 app
curl http://localhost:8090/healthz
docker compose down
```

`down` conserva el volumen. **`down -v` elimina los datos** y no debe usarse en producción. Cambiar código requiere `docker compose up -d --build`.

### Primer administrador

No hay usuario ni contraseña predeterminados. La contraseña se recibe por stdin para que no aparezca en argumentos del proceso ni en el historial. En Bash:

```bash
read -rsp 'Contraseña inicial (12–72 bytes): ' ADMIN_PASSWORD; echo
printf '%s\n' "$ADMIN_PASSWORD" | docker compose exec -T app /app create-admin 'Funcionario inicial' admin
unset ADMIN_PASSWORD
```

Ingrese con `admin` y la contraseña elegida. El comando solo funciona antes de existir el primer administrador. Los siguientes se crean en **Administradores** dentro del panel. No se puede desactivar al último administrador activo.

### Importar DNI

Desde **DNI habilitados**, puede completar DNI, nombre, apellido y email manualmente, o subir un XLSX o CSV. También puede usar CLI:

```bash
docker compose cp ./mediadores.csv app:/data/mediadores.csv
docker compose exec -T app /app import-mediators /data/mediadores.csv
```

El comando muestra filas leídas, importadas, duplicadas e inválidas y los números de filas con errores. Detecta el formato por contenido, incluso si se cambió la extensión. XLSX: lee la primera hoja. CSV: acepta coma, punto y coma, tabulación o barra vertical, UTF-8 (con o sin BOM), Windows-1252, UTF-16 y UTF-32 (con BOM o con detección de orden de bytes). Cambiar `.csv` a `.xlsx` no convierte el archivo y ya no impide importarlo.

Los encabezados **Apellido, Nombre, DNI y Email** permiten detectar columnas en cualquier orden (también se reconoce Documento y Correo electrónico). Se omiten encabezados repetidos, incluso si solo se identifican Apellido y Nombre. Sin encabezado, la distribución predeterminada es:

| Columna | Dato |
| --- | --- |
| A | Apellido |
| B | Nombre |
| C | DNI |
| H | Email |

La asignación está centralizada en `ImportColumns` en [internal/app/imports.go](internal/app/imports.go). Se normalizan espacios, DNI y email. Los DNI ya habilitados o registrados no se sobrescriben. Filas inválidas se omiten y se informan; errores del archivo revierten toda la importación. El XLSX se descomprime con límites de tamaño y se procesa fila a fila, con un máximo de 20.000 filas por importación.

El mediador consulta su DNI en **Registrar DNI habilitado**, comprueba sus datos y completa teléfono, contraseña y foto. La creación y el consumo del DNI son una misma transacción. No hay registro público de funcionarios.

## Uso

- **Mediador:** inicio con próximas mediaciones y noticias; calendario semanal de lunes a viernes; selección de un segundo mediador activo; reservas compartidas entre ambos participantes; cancelación antes de la hora de comienzo, incluso si el funcionario ya cambió su estado administrativo.
- Las fechas visibles y los campos de fecha usan **dd/mm/aaaa**, incluidas las exportaciones. Los timestamps se muestran en hora de Córdoba.
- La búsqueda de mediador al reservar se actualiza mientras escribe y reconoce nombre, apellido y DNI, sin distinguir tildes ni el orden de las palabras.
- **Funcionario:** dashboard útil, mediaciones por ayer/hoy/mañana y fecha, filtros por estado y resultado, corrección de datos y asignaciones, botones separados **Editar** (datos) y **Estado** (estado/resultado), días bloqueados, mediadores, administradores, noticias, DNI, exportaciones y auditoría.
- El administrador elige libremente `RESERVADA`, `INICIADA`, `FINALIZADA` o `FIRMADA`. Finalizada y firmada requieren `CON_ACUERDO`, `SIN_ACUERDO` o `INCOMPARECENCIA`. No existe firma digital.
- Bloquear una sede/fecha cancela todas sus mediaciones con `CANCELADA_POR_ADMIN`. Desbloquear permite nuevas reservas, sin restaurar las canceladas.
- Los horarios, comienzo, cancelación y anticipación usan `America/Argentina/Cordoba`. Se permite hasta la misma fecha del mes siguiente, inclusive; al no existir ese día se usa el último día del mes siguiente.
- No hay recuperación automática por email. Un funcionario restablece la contraseña y las sesiones anteriores se invalidan.

## Producción y HTTPS

Configurar `.env`:

```dotenv
APP_ENV=production
PORT=8090
BIND_ADDRESS=127.0.0.1
PUBLIC_URL=https://mediaciones.ejemplo.org
SESSION_SECRET=REEMPLAZAR_CON_UN_SECRETO_ALEATORIO_DE_AL_MENOS_32_CARACTERES
DOMAIN=mediaciones.ejemplo.org
```

Genere el secreto con `openssl rand -hex 32`. Conserve `.env` fuera de Git y respáldelo por separado en un lugar seguro. La aplicación rechaza producción sin secreto suficiente o sin `PUBLIC_URL` HTTPS. Las cookies llevan `Secure` en producción.

Puede usar un reverse proxy existente hacia `127.0.0.1:8090`, o el archivo opcional de Caddy para certificados TLS automáticos:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
# Para detener esta variante:
docker compose -f docker-compose.yml -f docker-compose.https.yml down
```

Apunte el DNS del dominio al servidor y habilite 80/443 en la red de Oracle y el firewall. Caddy conserva certificados en volúmenes propios. El servicio Go no se expone públicamente por defecto. La subred del proxy opcional es `172.30.87.0/24`; cámbiela en el override si colisiona con una red existente.

El limitador permite hasta 120 intentos por IP y 15 por usuario en 15 minutos; usa la dirección de conexión. Con otro proxy, configure `TRUSTED_PROXY_CIDRS` únicamente con sus IP/subredes; solo entonces se acepta `X-Forwarded-For`. No configure una red pública amplia. En el override de Caddy ya está definido. Sin proxy se ignoran esas cabeceras.

### Persistencia y recursos

El volumen `app-data` contiene:

```text
/data/database/app.sqlite       # SQLite, más WAL/SHM mientras corre
/data/uploads/mediadores/       # Fotos JPEG ≤800×800
/data/uploads/news/             # Imágenes de noticias
/data/exports/                  # XLSX históricos permanentes
/data/backups/                  # Copias tar.gz
/data/session-secret           # Secreto local solo para desarrollo
```

El contenedor corre como UID 10001. Si reemplaza el volumen por un bind mount, dé a ese UID permisos sobre el directorio. Puede cambiar `DATA_DIR` al ejecutar el binario fuera de Docker; todo el almacenamiento deriva de esa carpeta.

Compose limita la aplicación a 1 CPU y 512 MB. Se serializan escrituras en una conexión SQLite, con `BEGIN IMMEDIATE`, `busy_timeout=10000`, claves foráneas y WAL. La exclusión SQLite también protege frente a una segunda conexión o proceso. Los cupos y conflictos se vuelven a comprobar dentro de la transacción. Los conflictos consideran intervalos solapados incluso entre sedes con distintos horarios.

El hash bcrypt y la conversión de imágenes admiten como máximo dos trabajos simultáneos de cada tipo. El resto recibe un mensaje para reintentar. Fotos: JPEG/PNG reales, 5 MB, hasta 20 megapíxeles, conversión a JPEG calidad 80, nombre aleatorio. No se guardan BLOBs. No hay polling ni WebSockets; los listados grandes usan páginas de 50 registros.

La arquitectura apunta a unos 500 mediadores y picos de 100 usuarios. Las pruebas de carga incluidas miden lecturas concurrentes; **no constituyen una certificación de capacidad en Oracle Always Free**. La CPU, disco y carga real deben medirse en la instancia elegida. La imagen se puede compilar nativamente para AMD64 o ARM64 (Ampere); el driver SQLite usa CGO en la compilación.

## Exportaciones y retención

**Exportar mediaciones** genera un XLSX por rango, guarda permanentemente el archivo y registra administrador, rango, momento y cantidad. El archivo se puede descargar nuevamente desde **Exportaciones**, aun después de limpiar las filas operativas.

La marca de exportación se establece solo después de escribir correctamente el XLSX. Cualquier edición o bloqueo invalida la marca de las filas afectadas y obliga a exportarlas otra vez. La limpieza al iniciar y cada hora elimina solamente fechas con antigüedad **mayor a siete días** en las que todas las mediaciones están exportadas. Las no exportadas se conservan indefinidamente con avisos visibles. Cancelar una reserva por un mediador elimina esa reserva operacional y conserva auditoría, como requiere el flujo de cancelación.

Los XLSX y backups no se eliminan automáticamente. Debe copiarlos fuera de la instancia y vigilar el espacio libre. Las imágenes antiguas de noticias se conservan para que los backups online mantengan referencias válidas; el reemplazo no modifica archivos existentes.

## Backup

```bash
./scripts/backup.sh
# Equivalente:
docker compose exec -T app /app backup
```

Muestra la ruta del `.tar.gz` generado. Usa `VACUUM INTO` para obtener una imagen consistente de SQLite, incluyendo datos confirmados que estén en WAL; no copia en crudo una base abierta. Agrega imágenes, exportaciones y el secreto local de desarrollo. Los archivos referenciados son inmutables. La copia online puede contener archivos adicionales creados durante el backup, sin afectar las referencias del snapshot.

```bash
docker compose cp app:/data/backups/backup-IDENTIFICADOR.tar.gz ./backup.tar.gz
```

Guarde además `.env` y cualquier configuración propia en un respaldo seguro externo. Puede programar `scripts/backup.sh` con cron. No agregamos un servicio de scheduler.

### Restauración

Use únicamente backups propios confiables. Restaure con el servicio detenido; primero conserve una copia del estado actual.

```bash
# Crear carpeta de restauración y extraer el backup.
mkdir -p restore-data
tar -xzf backup.tar.gz -C restore-data
# Detener Go, dejando disponible el contenedor para copiar archivos.
docker compose stop app
# Eliminar WAL/SHM antiguos y sustituir SQLite antes de arrancar.
docker compose run --rm --user root --entrypoint sh app -c 'rm -f /data/database/app.sqlite /data/database/app.sqlite-wal /data/database/app.sqlite-shm'
docker compose cp ./restore-data/. app:/data/
docker compose run --rm --user root --entrypoint sh app -c 'chown -R 10001:10001 /data'
docker compose up -d
curl http://localhost:8090/healthz
```

Restaure también `.env` si fuera necesario. Para volver a un estado exacto use un volumen nuevo y copie allí el respaldo; el procedimiento anterior puede conservar archivos sin referencias. No mezcle una base restaurada con WAL/SHM de otra versión. Las sesiones incluidas en el snapshot pueden seguir vigentes: para invalidarlas todas después de restaurar, ejecute con la aplicación detenida `DELETE FROM sessions` mediante una herramienta SQLite, o espere su vencimiento máximo de 12 horas.

## Agregar una sede

Editar únicamente [internal/app/config.go](internal/app/config.go), agregando una entrada a `Sedes`:

```go
var Sedes = []Sede{
    {"COSQUIN", "Cosquín", "08:00", "15:30", 90, 1},
    {"OTRA", "Otra sede", "08:00", "14:00", 60, 2},
}
```

Orden de campos: código estable, nombre visible, apertura, cierre, duración en minutos, salas. Todos los slots se generan al consultar; no hay filas futuras permanentes. La interfaz descubre las sedes automáticamente. Recompilar con `docker compose up -d --build`. No renombre ni elimine códigos con mediaciones aún conservadas. Cambiar horarios o duración con reservas existentes requiere revisar esas reservas primero.

## Migraciones y desarrollo local

La migración 003 renombra los identificadores a `dni` sin eliminar usuarios ni reservas. Los identificadores previos se conservan; el sistema original ya cargaba la columna C del padrón. Se admiten DNI numéricos de hasta ocho dígitos y se normalizan puntos, espacios y ceros iniciales al importar, registrar e iniciar sesión.

Las migraciones SQL están embebidas en [internal/app/migrations](internal/app/migrations). Se aplican automáticamente en una transacción al iniciar y se registran en `schema_migrations`. Agregar una nueva migración numerada `002_descripcion.sql`, sin modificar migraciones ya aplicadas. También existe:

```bash
docker compose exec -T app /app migrate
```

Con Go 1.25 y compilador C instalados:

```bash
go run ./cmd/app serve
go test -race ./...
go vet ./...
```

Sin Go local:

```bash
./scripts/test.sh
# Flujo completo en contenedor/volumen de prueba aislados (puerto 18090):
python3 scripts/smoke.py
```

La estructura agrupa módulos sencillos dentro de `internal/app`: configuración, migraciones, usuarios, reservas, almacenamiento, handlers y templates; `cmd/app` es el único ejecutable. CSS, HTMX y JavaScript están embebidos, así que el binario no depende de archivos de frontend externos ni CDN en ejecución.

## Seguridad y pruebas

Sesiones aleatorias de 256 bits, tokens almacenados con SHA-256, expiración a 12 horas, rotación al login, cookies HttpOnly/SameSite=Lax, CSRF HMAC en todo POST, control de origen, autorización de backend, bcrypt, escape HTML, SQL parametrizado, límites de requests y cabeceras CSP. Desactivar una cuenta o restablecer su contraseña invalida sus sesiones. No se almacenan contraseñas en logs.

Auditoría transaccional de registro, creación de admin, activación/desactivación, reset, reserva, edición/estado, cancelación, bloqueo/desbloqueo y exportación. El log operacional es JSON por stderr.

La dependencia XLSX se fijó en Excelize 2.11.0 para incluir las correcciones de [los avisos de seguridad del lector de filas](https://pkg.go.dev/vuln/GO-2026-6453). Puede repetir la revisión con `GOTOOLCHAIN=auto go run golang.org/x/vuln/cmd/govulncheck@latest ./...`.

Las pruebas cubren registro y duplicados, cuentas inactivas, invalidación de sesiones, concurrencia entre dos conexiones SQLite, conflictos de ambos mediadores y sedes, límite mensual, fines de semana, bloqueo/desbloqueo, cancelación en el instante de inicio, estados y resultados, autorización, XLSX, retención e invalidación tras edición, fotos, backup, CSRF y escape/render de todas las pantallas.
