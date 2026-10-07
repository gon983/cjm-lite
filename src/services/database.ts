import type { Env } from "../types";
export const USER_COLUMNS =
  "id,role,username,dni,nombre,apellido,email,telefono,photo,active,created_at,updated_at,search_text";
export const MED_SELECT = `SELECT m.id,m.sede,m.date,m.start,m.m1,m.m2,m.title,m.case_number,m.state,m.result,m.created_at,m.updated_at,m.exported_at,m.export_id,m.version,u1.apellido||' '||u1.nombre AS name1,u2.apellido||' '||u2.nombre AS name2,coalesce(u1.dni,'') AS dni1,coalesce(u2.dni,'') AS dni2 FROM mediations m JOIN users u1 ON u1.id=m.m1 JOIN users u2 ON u2.id=m.m2 `;
export const stmt = (
  env: Env,
  sql: string,
  ...args: (string | number | null | number[])[]
) => env.DB.prepare(sql).bind(...args);
export const adminSQL =
  "EXISTS(SELECT 1 FROM users WHERE id=? AND role='ADMIN' AND active=1)";
export const stamp = () => new Date().toISOString();
export function auditAfter(
  env: Env,
  actor: number | null,
  action: string,
  entity: string,
  entityID: number | null,
  detail = "",
) {
  return stmt(
    env,
    `INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at,detail) SELECT ?,?,?,${entityID === null ? "last_insert_rowid()" : "?"},?,? WHERE changes()=1`,
    ...[
      actor,
      action,
      entity,
      ...(entityID === null ? [] : [entityID]),
      stamp(),
      detail,
    ],
  );
}
