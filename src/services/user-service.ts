import { BusinessError, type Env } from "../types";
import { whitelistRow, searchText, normalizeDNI } from "../lib/validation";
import { adminSQL, auditAfter, stmt, stamp } from "./database";
import { hashProof } from "../lib/crypto";
export interface PasswordProof {
  passwordSalt: string;
  passwordProof: string;
  passwordBytes?: string;
}
export function checkProofFields(p: PasswordProof) {
  const n = Number(p.passwordBytes);
  if (!Number.isInteger(n) || n < 12 || n > 72)
    throw new BusinessError("La contraseña debe tener entre 12 y 72 bytes.");
}
export async function createAdmin(
  env: Env,
  actor: number | null,
  name: string,
  username: string,
  p: PasswordProof,
) {
  name = name.trim();
  username = username.trim().toLowerCase();
  if (!name || name.length > 100 || !username || username.length > 254)
    throw new BusinessError("Complete nombre y usuario válidos.");
  checkProofFields(p);
  const password = await hashProof(
      env.SESSION_SECRET,
      p.passwordSalt,
      p.passwordProof,
    ),
    ts = stamp();
  const condition =
    actor === null
      ? "NOT EXISTS(SELECT 1 FROM users WHERE role='ADMIN')"
      : adminSQL;
  const [write] = await env.DB.batch([
    stmt(
      env,
      `INSERT INTO users(role,username,nombre,password,created_at,updated_at,search_text) SELECT 'ADMIN',?,?,?,?,?,? WHERE ${condition}`,
      username,
      name,
      password,
      ts,
      ts,
      searchText(name + " " + username),
      ...(actor === null ? [] : [actor]),
    ),
    auditAfter(env, actor, "CREATE_ADMIN", "users", null),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "El primer administrador ya existe o no tiene permiso.",
      409,
    );
  return Number(write.meta.last_row_id);
}
export async function enableDNI(
  env: Env,
  actor: number,
  data: Record<string, unknown>,
) {
  const r = whitelistRow(data);
  const [write] = await env.DB.batch([
    stmt(
      env,
      `INSERT INTO whitelist(dni,nombre,apellido,email) SELECT ?,?,?,? WHERE ${adminSQL} AND NOT EXISTS(SELECT 1 FROM users WHERE dni=?) AND NOT EXISTS(SELECT 1 FROM whitelist WHERE dni=?)`,
      r.dni,
      r.nombre,
      r.apellido,
      r.email,
      actor,
      r.dni,
      r.dni,
    ),
    auditAfter(env, actor, "ENABLE_DNI", "whitelist", 0),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "Ese DNI ya está habilitado, registrado o no tiene permiso.",
      409,
    );
}
export async function register(
  env: Env,
  dni: string,
  phone: string,
  photo: string,
  p: PasswordProof,
) {
  dni = normalizeDNI(dni);
  phone = phone.trim();
  if (!phone || phone.length > 60 || !photo)
    throw new BusinessError("Complete teléfono y foto.");
  checkProofFields(p);
  const source = await stmt(
    env,
    "SELECT nombre,apellido FROM whitelist WHERE dni=?",
    dni,
  ).first<{ nombre: string; apellido: string }>();
  if (!source)
    throw new BusinessError(
      "El DNI no está habilitado o ya fue registrado.",
      409,
    );
  const normalized = searchText(`${source.apellido} ${source.nombre} ${dni}`);
  const password = await hashProof(
      env.SESSION_SECRET,
      p.passwordSalt,
      p.passwordProof,
    ),
    ts = stamp();
  const sql = `INSERT INTO users(role,username,dni,nombre,apellido,email,telefono,photo,password,created_at,updated_at,search_text) SELECT 'MEDIADOR',dni,dni,nombre,apellido,email,?,?,?, ?,?,? FROM whitelist WHERE dni=? AND NOT EXISTS(SELECT 1 FROM users WHERE dni=?)`;
  const [write] = await env.DB.batch([
    stmt(env, sql, phone, photo, password, ts, ts, normalized, dni, dni),
    stmt(
      env,
      `INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at,detail) SELECT last_insert_rowid(),'REGISTER','users',last_insert_rowid(),?,'' WHERE changes()=1`,
      ts,
    ),
    stmt(
      env,
      `DELETE FROM whitelist WHERE dni=? AND EXISTS(SELECT 1 FROM users WHERE dni=? AND photo=?)`,
      dni,
      dni,
      photo,
    ),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "El DNI no está habilitado o ya fue registrado.",
      409,
    );
  return Number(write.meta.last_row_id);
}
export async function manageUser(
  env: Env,
  actor: number,
  id: number,
  action: string,
  p?: PasswordProof,
) {
  let update: D1PreparedStatement;
  if (action === "reset") {
    if (!p) throw new BusinessError("Indique una contraseña.");
    checkProofFields(p);
    const h = await hashProof(
      env.SESSION_SECRET,
      p.passwordSalt,
      p.passwordProof,
    );
    update = stmt(
      env,
      `UPDATE users SET password=?,updated_at=? WHERE id=? AND ${adminSQL}`,
      h,
      stamp(),
      id,
      actor,
    );
  } else if (action === "toggle") {
    update = stmt(
      env,
      `UPDATE users SET active=1-active,updated_at=? WHERE id=? AND ${adminSQL} AND NOT(role='ADMIN' AND active=1 AND (SELECT count(*) FROM users WHERE role='ADMIN' AND active=1)<=1)`,
      stamp(),
      id,
      actor,
    );
  } else throw new BusinessError("Acción inválida.");
  const [write] = await env.DB.batch([
    update,
    auditAfter(env, actor, action, "users", id),
    stmt(
      env,
      `DELETE FROM sessions WHERE user_id=? AND changes()=1 AND EXISTS(SELECT 1 FROM audit_log WHERE id=last_insert_rowid() AND actor_id=? AND entity='users' AND entity_id=? AND action=?)`,
      id,
      actor,
      id,
      action,
    ),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "No tiene permiso, el usuario no existe o es el último administrador activo.",
      409,
    );
}
export async function importRows(env: Env, actor: number, rows: unknown[]) {
  if (!Array.isArray(rows) || rows.length > 40)
    throw new BusinessError("Envíe lotes de hasta 40 filas.");
  let imported = 0,
    invalid = 0,
    duplicates = 0;
  const errors: string[] = [],
    writes: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = whitelistRow(rows[i] as Record<string, unknown>);
      writes.push(
        stmt(
          env,
          `INSERT OR IGNORE INTO whitelist(dni,nombre,apellido,email) SELECT ?,?,?,? WHERE ${adminSQL} AND NOT EXISTS(SELECT 1 FROM users WHERE dni=?)`,
          r.dni,
          r.nombre,
          r.apellido,
          r.email,
          actor,
          r.dni,
        ),
      );
    } catch (e) {
      invalid++;
      errors.push(`Fila ${i + 1}: ${(e as Error).message}`);
    }
  }
  if (writes.length) {
    const results = await env.DB.batch([
      ...writes,
      stmt(
        env,
        `INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at,detail) SELECT ?,'IMPORT','whitelist',0,?,? WHERE ${adminSQL}`,
        actor,
        stamp(),
        `${writes.length} filas validadas`,
        actor,
      ),
    ]);
    for (let i = 0; i < writes.length; i++) {
      if (results[i].meta.changes) imported++;
      else duplicates++;
    }
  }
  return { read: rows.length, imported, duplicates, invalid, errors };
}

export async function updateProfile(
  env: Env,
  actor: number,
  data: Record<string, unknown>,
  photo = "",
) {
  const row = whitelistRow({ ...data, dni: "1" });
  const telefono = String(data.telefono ?? "").trim();
  if (!telefono || telefono.length > 60)
    throw new BusinessError("Complete un teléfono válido.");
  const current = await stmt(
    env,
    "SELECT dni FROM users WHERE id=? AND role='MEDIADOR' AND active=1",
    actor,
  ).first<{ dni: string }>();
  if (!current)
    throw new BusinessError(
      "No tiene permiso para modificar este perfil.",
      403,
    );
  const [write] = await env.DB.batch([
    stmt(
      env,
      `UPDATE users SET nombre=?,apellido=?,email=?,telefono=?,photo=CASE WHEN ?='' THEN photo ELSE ? END,search_text=?,updated_at=? WHERE id=? AND role='MEDIADOR' AND active=1`,
      row.nombre,
      row.apellido,
      row.email,
      telefono,
      photo,
      photo,
      searchText(`${row.apellido} ${row.nombre} ${current.dni}`),
      stamp(),
      actor,
    ),
    auditAfter(env, actor, "UPDATE_PROFILE", "users", actor),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError("No se pudo modificar su perfil.", 403);
}
