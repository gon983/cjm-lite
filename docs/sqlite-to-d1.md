# Migrar datos SQLite a D1

## Corte autorizado en esta sesión

El usuario pidió comenzar sin usuarios ni contraseñas anteriores. Se generó un backup consistente del servicio Go: `/data/backups/backup-42f82f7cbb2b7ade.tar.gz`; se conserva además una copia de trabajo protegida. La base original no se borra. Las mediaciones y auditorías que referencian esas cuentas no se importan inventando participantes ni rompiendo FKs: quedan conservadas íntegramente en `original.sqlite` y `original-all-data.sql`. No se ejecuta limpieza sobre ese archivo ni se afirma que esté exportado a XLSX.

Para este corte se copian whitelist, noticias y bloqueos; cuentas/sesiones empiezan vacías. El administrador nuevo se crea por bootstrap. Esta exclusión de datos operativos ligados a cuentas borradas es un resultado del reset autorizado, no una nueva política de retención del sistema. La aplicación nueva conserva registros no exportados indefinidamente y tiene las mismas reglas de limpieza segura.

## Procedimiento reproducible

Detenga escrituras en la versión Go para el backup final del corte. La herramienta puede leer con WAL mediante sqlite3.backup; no copia a ciegas una base abierta.

```bash
# En Go legacy, generar y copiar el backup consistente:
docker compose exec -T app /app backup
docker compose cp app:/data/backups/backup-IDENTIFICADOR.tar.gz ./backup.tar.gz
mkdir -p restored-source
tar -xzf backup.tar.gz -C restored-source
# Snapshot propio, dump completo y SQL para el target sin cuentas anteriores:
python3 scripts/migrate-sqlite-to-d1/export.py restored-source/database/app.sqlite --reset-users --out .migration/cutover
```

El output privado contiene snapshot consistente, dump completo, `data.sql` y `verification.json` con cantidades exactas de origen/target. El script rechaza reusar el directorio de snapshot. Usa SQL quoting/NULL/BLOB correctos y nombres de tabla fijos. Verifica integrity_check y foreign_key_check antes de preparar la importación; la fuente se abre read-only y nunca se elimina.

```bash
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler d1 execute DB --local --file .migration/cutover/data.sql
node scripts/migrate-sqlite-to-d1/verify.mjs .migration/cutover --local
```

Primero verifique en local. Para una base D1 **nueva y vacía**, con database_id real configurado:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 execute DB --remote --file .migration/cutover/data.sql
node scripts/migrate-sqlite-to-d1/verify.mjs .migration/cutover --remote
```

No importar sobre una instancia activa con diferentes datos: INSERT OR IGNORE facilita repetir el mismo corte, pero no sincroniza actualizaciones. Los counts deben coincidir exactamente, sin violaciones FK. Crear primer admin, comprobar roles/calendario/DNI y hacer smoke tests de reserva/cancelación/bloqueo antes de mover el dominio.

## Archivos R2

Extraiga uploads/exports desde el mismo backup. Por defecto solo noticias que siguen en D1; perfiles y exportaciones de cuentas/historial excluidos permanecen en el respaldo.

```bash
python3 scripts/migrate-uploads-to-r2/migrate.py .migration/cutover/original.sqlite restored-source --out .migration/cutover/uploads
# Revisar mapping.json y references.sql; después subir y cambiar referencias:
python3 scripts/migrate-uploads-to-r2/migrate.py .migration/cutover/original.sqlite restored-source --out .migration/cutover/uploads --apply
# Remoto, explícito:
python3 scripts/migrate-uploads-to-r2/migrate.py .migration/cutover/original.sqlite restored-source --out .migration/cutover/uploads --apply --remote
```

Keys de contenido estables por SHA-256, nombres originales ignorados para crear keys, límites de path y existencia de archivos comprobados, correspondencias guardadas y originales intactos. Repetir sube a la misma key y actualiza referencias solo si siguen en su valor original o ya migrado. Nunca se cambia una referencia a una key cuyo upload falló. Los flags include-users/include-exports son únicamente para otros cortes que efectivamente hayan conservado sus metadatos y cuentas, no para este reset.

## Backups y rollback

D1: `npx wrangler d1 export DB --remote --output backup-d1.sql`. R2: mantener copia externa de los objetos privados y mapping. Conservar SESSION_SECRET seguro por separado. D1 Time Travel es una ayuda, no sustituto de una copia independiente de archivos: https://developers.cloudflare.com/d1/reference/time-travel/ . Para rollback no mezclar snapshots con WAL de otra copia; use el tar.gz legacy y el código/documentación del commit legacy `00cbda9` en un checkout separado.
