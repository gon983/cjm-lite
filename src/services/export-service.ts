import { siteFilter } from "../config/sites";
import { BusinessError, type Env, type Mediation } from "../types";
import { dateInput, validDate, dateES, timestampES } from "../lib/dates";
import { hmac, equal, randomToken } from "../lib/crypto";
import { stmt, MED_SELECT, stamp, adminSQL } from "./database";
export const EXPORT_HEADERS = [
  "ID",
  "Fecha",
  "Hora",
  "Sede",
  "Carátula",
  "Expediente",
  "Mediador 1",
  "DNI 1",
  "Mediador 2",
  "DNI 2",
  "Estado",
  "Resultado",
  "Creada",
  "Modificada",
];
export async function exportPage(
  env: Env,
  actor: number,
  from: string,
  to: string,
  cursor: number,
  sede = "",
) {
  sede = siteFilter(sede);
  from = dateInput(from);
  to = dateInput(to);
  if (!validDate(from) || !validDate(to) || from > to)
    throw new BusinessError("Rango de fechas inválido.");
  const result = await stmt(
    env,
    MED_SELECT +
      `WHERE m.date BETWEEN ? AND ? AND m.id>? AND (?='' OR m.sede=?) ORDER BY m.id LIMIT 100`,
    from,
    to,
    cursor,
    sede, sede,
  ).all<Mediation>();
  const rows = result.results.map((m) => ({
    values: [
      m.id,
      dateES(m.date),
      m.start,
      m.sede,
      m.title,
      m.case_number,
      m.name1,
      m.dni1,
      m.name2,
      m.dni2,
      m.state,
      m.result,
      timestampES(m.created_at),
      timestampES(m.updated_at),
    ],
    id: m.id,
    version: m.version,
  }));
  const signature = await hmac(
    env.SESSION_SECRET,
    `export-page:${actor}:${from}:${to}:${sede ? `sede=${sede}:` : ""}${JSON.stringify(rows.map((r) => ({ id: r.id, version: r.version })))}`,
  );
  return {
    signature,
    headers: EXPORT_HEADERS,
    rows,
    next: rows.length === 100 ? rows[rows.length - 1].id : null,
    from,
    to,
    sede,
  };
}
interface VersionRef {
  id: number;
  version: number;
}
export interface Manifest {
  rows: VersionRef[];
  signature: string;
}
export async function confirmExport(
  env: Env,
  actor: number,
  from: string,
  to: string,
  pages: Manifest[],
  file: File,
  sede = "",
) {
  sede = siteFilter(sede);
  from = dateInput(from);
  to = dateInput(to);
  if (
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    !Array.isArray(pages) ||
    pages.length > 51
  )
    throw new BusinessError(
      "Exportación inválida (máximo 5.000 filas por archivo).",
    );
  if (file.size > 8 * 1024 * 1024 || file.size < 100)
    throw new BusinessError("Archivo XLSX inválido o demasiado grande.");
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (magic[0] !== 80 || magic[1] !== 75 || magic[2] !== 3 || magic[3] !== 4)
    throw new BusinessError("La exportación debe ser un archivo XLSX.");
  const ids = new Set<number>(),
    manifest: VersionRef[] = [];
  for (const page of pages) {
    if (
      !Array.isArray(page.rows) ||
      page.rows.length > 100 ||
      typeof page.signature !== "string"
    )
      throw new BusinessError("Manifest de exportación inválido.", 403);
    const refs = page.rows.map((r) => ({ id: r.id, version: r.version }));
    if (
      !equal(
        page.signature,
        await hmac(
          env.SESSION_SECRET,
          `export-page:${actor}:${from}:${to}:${sede ? `sede=${sede}:` : ""}${JSON.stringify(refs)}`,
        ),
      )
    )
      throw new BusinessError("El dataset de exportación no es válido.", 403);
    for (const row of refs) {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        ids.has(row.id)
      )
        throw new BusinessError("El dataset de exportación no es válido.", 403);
      ids.add(row.id);
      manifest.push(row);
    }
  }
  if (manifest.length > 5000)
    throw new BusinessError(
      "Exporte un rango menor: máximo 5.000 registros por archivo.",
    );
  const key = `exports/${from.slice(0, 4)}/${randomToken()}.xlsx`;
  await env.FILES.put(key, file.stream(), {
    httpMetadata: {
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
  const ts = stamp();
  try {
    const results = await env.DB.batch([
      stmt(
        env,
        `INSERT INTO exports(date_from,date_to,created_at,admin_id,filename,count,manifest,sede) SELECT ?,?,?,?,?,?,?,? WHERE ${adminSQL}`,
        from,
        to,
        ts,
        actor,
        key,
        manifest.length,
        JSON.stringify(manifest),
        sede,
        actor,
      ),
      stmt(
        env,
        `UPDATE mediations SET exported_at=?,export_id=last_insert_rowid() WHERE (id,version) IN (SELECT CAST(json_extract(j.value,'$.id') AS INTEGER),CAST(json_extract(j.value,'$.version') AS INTEGER) FROM json_each(?) j) AND ${adminSQL}`,
        ts,
        JSON.stringify(manifest),
        actor,
      ),
      stmt(
        env,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at,detail) SELECT ?,'EXPORT','exports',id,?,? FROM exports WHERE filename=? AND admin_id=?`,
        actor,
        ts,
        `${manifest.length} registros`,
        key,
        actor,
      ),
    ]);
    if (results[0].meta.changes !== 1)
      throw new BusinessError("No tiene permiso para exportar.", 403);
    return {
      key,
      id: Number(results[0].meta.last_row_id),
      marked: results[1].meta.changes,
      count: manifest.length,
    };
  } catch (e) {
    // D1 may have committed before a transport error. Keep the durable file:
    // deleting it here could leave exported records pointing to a missing archive.
    throw e;
  }
}
