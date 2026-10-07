# CJM Lite · Cloudflare

Migración del sistema existente a **un Worker TypeScript/Hono**, D1 y R2 privado. Mantiene el HTML renderizado en servidor, HTMX, CSS, navegación y reglas de negocio. Producción no necesita Docker ni un servidor Node. Node se usa solo para instalar herramientas, ejecutar Wrangler y comandos de mantenimiento.

Se conservaron las mejoras previas: **DNI**, carga manual/CSV/XLSX, búsqueda en tiempo real sin tildes ni orden, fechas **dd/mm/aaaa**, botones separados **Editar** y **Estado**, calendario de lunes a viernes, un mes calendario de anticipación y cancelación por participante antes de empezar.

## Desarrollo local

Requisitos: Node 22.12+ o 24 LTS y npm, Python 3 solamente para migrar archivos de la versión anterior.

```bash
npm install
npm run db:migrate
npm run dev
```

Abrir **http://localhost:8787**. `predev` genera `.dev.vars` con claves aleatorias privadas si no existe. Nunca se sube a Git. D1/R2 locales viven en `.wrangler/state`, una emulación de desarrollo; el Worker usa exclusivamente bindings y no lee filesystem ni SQLite local directamente.

### Primer administrador

No hay contraseña predeterminada. En Bash:

```bash
read -rsp 'Contraseña inicial (12–72 bytes): ' ADMIN_PASSWORD; echo
printf '%s\n' "$ADMIN_PASSWORD" | npm run bootstrap -- 'Funcionario inicial' admin
unset ADMIN_PASSWORD
```

El bootstrap solo funciona una vez. Los siguientes administradores se crean en el panel. El login requiere JavaScript para derivar PBKDF2 en el navegador, decisión autorizada para Workers Free. Más detalles: [migración de contraseñas](docs/password-migration.md).

## Despliegue en Cloudflare Free

Crear una cuenta Cloudflare y autenticar Wrangler. El despliegue actual está en https://cjm-lite.mediacionescba.workers.dev. El procedimiento siguiente sirve para repetirlo o cambiar de cuenta.

```bash
npx wrangler login
npx wrangler d1 create cjm-lite
npx wrangler r2 bucket create mediaciones-files
```

Copiar el `database_id` real a `wrangler.toml`. El valor de ceros permite desarrollo local, **no es un ID para producción**. El bucket debe permanecer privado: no habilitar `r2.dev` ni un dominio público para archivos personales.

Editar `[vars]` en `wrangler.toml`:

```toml
APP_ENV = "production"
APP_URL = "https://cjm-lite.TU-SUBDOMINIO.workers.dev"
SESSION_TTL = "43200"
TIMEZONE = "America/Argentina/Cordoba"
```

Configurar secretos remotos con valores aleatorios, separados de `.dev.vars`:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler d1 migrations apply DB --remote
npm run typecheck
npm test
npm run build
npx wrangler deploy
```

Crear el primer administrador remoto con la misma herramienta y URL real. Poner BOOTSTRAP_SECRET en el entorno local de la terminal para ese comando; recibir la contraseña por stdin como en desarrollo. Después:

```bash
npx wrangler secret delete BOOTSTRAP_SECRET
```

Conservar SESSION_SECRET en un respaldo seguro: protege los verificadores de contraseñas, además de CSRF. Cambiarlo sin migración invalida los logins. Cloudflare proporciona HTTPS; Caddy/Docker pertenecen solo a la versión legacy.

Bindings: **DB** (D1), **FILES** (R2), **ASSETS** (CSS/JS/HTMX). Las rutas públicas de assets se sirven sin ejecutar el Worker; XLSX se descarga solo cuando se usa importación/exportación.

## Datos y archivos anteriores

El usuario autorizó comenzar sin las cuentas y contraseñas viejas. La copia original, su historia y el dump completo siguen resguardados; no se inventan participantes para importar mediaciones que apuntan a cuentas borradas. Para este corte se copian el padrón pendiente, noticias y bloqueos. El procedimiento es explícito y revisable:

- [Auditoría y plan](docs/cloudflare-migration-plan.md).
- [SQLite → D1 y archivos → R2](docs/sqlite-to-d1.md).
- [Contraseñas y autorización del cambio](docs/password-migration.md).
- El código anterior se conserva en Git (commit `00cbda9`), fuera del runtime actual.

Los scripts preparan snapshot consistente, dump SQL, counts/FK y correspondencias R2. No borran el original. Primero ejecutar y verificar localmente; después usar los mismos archivos con `--remote` sobre una D1 nueva.

## Uso y conservación de datos

**DNI habilitados:** cargar manualmente apellido/nombre/DNI/email, o seleccionar CSV/XLSX, revisar el preview y confirmar. El navegador reconoce encabezados repetidos/reordenados; sin encabezado usa A apellido, B nombre, C DNI y H email. CSV admite UTF-8, Windows-1252 y UTF-16/32. El Worker vuelve a validar todas las filas y escribe lotes de hasta 40. Importar de nuevo no duplica ni sobrescribe DNI ya registrados. Importaciones de varios lotes son reanudables/idempotentes; un lote fallido no revierte los lotes anteriores.

**Fotos/noticias:** máximo original 5 MB y 20 megapíxeles en browser; se convierten a JPEG ≤800×800 antes de subir. El Worker comprueba el formato real, dimensiones ≤800 y tamaño ≤512 KB. R2 guarda objetos privados con keys aleatorias. Los endpoints requieren sesión y referencia válida en D1. No hay BLOBs de imágenes.

**Reservas:** un INSERT SELECT verifica dentro de la misma operación sede/configuración, slots, día hábil, rango de un mes, comienzo futuro, bloqueos, mediadores activos y diferentes, conflictos por intervalos entre sedes y cupos. Edición administrativa usa UPDATE condicional con las mismas reglas si se cambia la asignación. D1 batch une cada operación con auditoría; fallar la auditoría revierte la operación.

**Estados:** ADMIN elige RESERVADA, INICIADA, FINALIZADA o FIRMADA. Los dos últimos requieren resultado. Una cancelación por bloqueo no se restaura al desbloquear ni cambiando estado. Editar datos preserva estado/resultado. Cancelar una reserva antes del inicio elimina su registro operacional, libera cupo y conserva auditoría.

**Exportar mediaciones:** rango de fechas, dataset paginado de 100 filas, archivo XLSX generado en browser y guardado en R2 antes de marcar versiones. Cada página de versiones tiene HMAC; el backend rechaza manifests alterados. Si una mediación cambió mientras se generaba el archivo, queda sin exportar hasta una nueva exportación. El archivo guardado se puede descargar nuevamente. Máximo 5.000 registros por archivo: dividir un historial mayor por fechas.

**Retención:** limpieza programada diaria, solo fechas con antigüedad mayor a siete días completamente exportadas. Ninguna fila no exportada se elimina. El dashboard y panel diario mantienen avisos. Ante un error de transporte ambiguo de D1 se conserva el archivo R2, porque la transacción pudo haberse confirmado. Se prefiere conservar un archivo adicional antes que perder la exportación. Los XLSX y assets de R2 no se limpian automáticamente; conservarlos permite recuperación y evita borrar referencias usadas por backups. No hay SMTP, JWT, polling ni WebSockets.

## Sedes

Editar únicamente `src/config/sites.ts`:

```ts
export const SITES = [
  { code: 'COSQUIN', name: 'Cosquín', start: '08:00', end: '15:30', slotMinutes: 90, rooms: 1 },
  // { code: 'OTRA', name: 'Otra sede', start: '08:00', end: '14:00', slotMinutes: 60, rooms: 2 },
];
```

La UI descubre sedes y calcula slots sin filas futuras permanentes. No renombrar/eliminar códigos con reservas históricas ni cambiar duraciones sin revisar esas asignaciones. No hay CRUD de sedes.

## Seguridad y operación

Sesiones criptográficas de 256 bits, solo SHA-256 del token en D1, HttpOnly/Secure/SameSite=Lax, CSRF HMAC en formularios/JSON, control de origen, autorización backend, SQL preparado, HTML escapado, CSP y límites de request. Reset/desactivación revocan sesiones; último admin activo protegido. Login limita 15 intentos por usuario y 120 por IP en 15 minutos, guardando keys HMAC en D1. Los logs JSON registran errores con request ID sin contraseñas/pruebas/tokens. `/healthz` comprueba D1.

Backups:

```bash
npx wrangler d1 export DB --remote --output backup-d1.sql
# Guardar también copia externa privada de objetos R2 y SESSION_SECRET.
```

D1 Time Travel ayuda a restaurar, pero no reemplaza el respaldo de R2. Restaurar en D1 nueva, aplicar esquema/importar datos y restituir los objetos/keys y el mismo SESSION_SECRET; verificar FKs/counts antes de mover tráfico. [Procedimiento](docs/sqlite-to-d1.md).

## Verificación

```bash
npm run typecheck
npm test
npm run build
npm audit
# Flujo completo en navegador con D1/R2 aislados:
npm run test:browser
```

Para el test de navegador use Chrome instalado o ejecute `npx playwright install chromium`. Puede indicar `CJM_CHROME_PATH` si su Chrome está en otra ruta.

Los tests ejecutan el Worker con D1 y R2 emulados reales por Cloudflare Vitest, no un mock de las reglas. Incluyen registro, roles, sesiones/reset, límites, conflictos de ambos mediadores, solicitudes HTTP concurrentes, reservas y movimientos al último cupo, rollback por fallo de auditoría, bloqueos, estados, R2, exportaciones con versiones, retención y fragments HTMX. El flujo de navegador también fue comprobado en Chrome desktop/móvil, con PBKDF2, CSV/XLSX reales, resize y downloads.

## Free Tier y límites prácticos

La arquitectura evita cómputo pesado en el Worker; bundle TS/Hono pequeño y assets independientes, consultas indexadas y páginas acotadas, import de 40 filas por lote y una firma por página de exportación. Workers Free: 100.000 requests/día y 10 ms CPU HTTP; D1: 5M filas leídas y 100k escritas/día, 5 GB totales; R2 Standard: 10 GB-month incluidos y cuotas de operaciones. Verificar siempre [límites Workers](https://developers.cloudflare.com/workers/platform/limits/), [precios D1](https://developers.cloudflare.com/d1/platform/pricing/) y [precios R2](https://developers.cloudflare.com/r2/pricing/).

La capacidad estimada es favorable para ~500 mediadores/100 usuarios simultáneos con el volumen operacional de Cosquín. No equivale a certificar 10 ms remotamente: medir CPU/rows/requests en la cuenta antes del corte. Imports, exports muy grandes y búsquedas frecuentes de todos los usuarios pueden agotar cuotas; dividir rangos/lotes y consultar métricas. No hay plan pago habilitado ni despliegue remoto automático.
