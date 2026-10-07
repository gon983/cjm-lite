import { BusinessError, type Env, type Mediation } from "../types";
import { siteCTE } from "../config/sites";
import {
  dateInput,
  validDate,
  today,
  clockCTE,
  clockArgs,
  sqlMonthLimit,
} from "../lib/dates";
import { resultValid } from "../lib/validation";
import { stmt, adminSQL, auditAfter, stamp } from "./database";
const minutes = (field: string) =>
  `(CAST(substr(${field},1,2) AS INTEGER)*60+CAST(substr(${field},4,2) AS INTEGER))`;
export interface Booking {
  sede: string;
  date: string;
  start: string;
  m1: number;
  m2: number;
  title: string;
  case_number: string;
}
function input(m: Booking) {
  m = { ...m, date: dateInput(m.date) };
  if (!validDate(m.date) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(m.start))
    throw new BusinessError("Fecha u horario inválidos.");
  if (
    !m.title.trim() ||
    !m.case_number.trim() ||
    m.title.length > 300 ||
    m.case_number.length > 120
  )
    throw new BusinessError("Complete carátula y expediente.");
  return m;
}
function eligibility(exclude: number) {
  const n = "?";
  return {
    sql: `EXISTS(SELECT 1 FROM sites s WHERE s.code=? AND ${n}>=s.open AND ${n}+s.duration<=s.close AND (${n}-s.open)%s.duration=0)
 AND ?<>? AND (SELECT count(*) FROM users WHERE id IN (?,?) AND role='MEDIADOR' AND active=1)=2
 AND ? BETWEEN (SELECT substr(local_now,1,10) FROM clock) AND ${sqlMonthLimit} AND (?||' '||?)>(SELECT substr(local_now,1,16) FROM clock) AND strftime('%w',?) NOT IN ('0','6')
 AND NOT EXISTS(SELECT 1 FROM blocked_days WHERE sede=? AND date=?)
 AND (SELECT count(*) FROM mediations WHERE sede=? AND date=? AND start=? AND state<>'CANCELADA_POR_ADMIN' AND id<>?)<(SELECT rooms FROM sites WHERE code=?)
 AND NOT EXISTS(SELECT 1 FROM mediations x LEFT JOIN sites old ON old.code=x.sede WHERE x.date=? AND x.state<>'CANCELADA_POR_ADMIN' AND x.id<>? AND (x.m1 IN (?,?) OR x.m2 IN (?,?)) AND (old.code IS NULL OR (${minutes("x.start")}<${n}+(SELECT duration FROM sites WHERE code=?) AND ${n}<${minutes("x.start")}+old.duration)))`,
    args(m: Booking) {
      const start = Number(m.start.slice(0, 2)) * 60 + Number(m.start.slice(3));
      return [
        m.sede,
        start,
        start,
        start,
        m.m1,
        m.m2,
        m.m1,
        m.m2,
        m.date,
        m.date,
        m.start,
        m.date,
        m.sede,
        m.date,
        m.sede,
        m.date,
        m.start,
        exclude,
        m.sede,
        m.date,
        exclude,
        m.m1,
        m.m2,
        m.m1,
        m.m2,
        start,
        m.sede,
        start,
      ];
    },
  };
}
export async function reserve(
  env: Env,
  actor: number,
  data: Booking,
  now?: Date,
) {
  const m = input({ ...data, m1: actor }),
    rules = eligibility(0),
    ts = stamp();
  const sql = `WITH ${siteCTE()},${clockCTE} INSERT INTO mediations(sede,date,start,m1,m2,title,case_number,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'RESERVADA',?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND role='MEDIADOR' AND active=1) AND ${rules.sql}`;
  const [write] = await env.DB.batch([
    stmt(
      env,
      sql,
      ...clockArgs(now),
      m.sede,
      m.date,
      m.start,
      m.m1,
      m.m2,
      m.title,
      m.case_number,
      ts,
      ts,
      actor,
      ...rules.args(m),
    ),
    auditAfter(env, actor, "RESERVE", "mediations", null),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "Ese horario acaba de ser reservado, está bloqueado, fuera de plazo o un mediador ya está ocupado.",
      409,
    );
  return Number(write.meta.last_row_id);
}
export async function editDetails(
  env: Env,
  actor: number,
  id: number,
  data: Booking,
  now?: Date,
) {
  const m = input(data),
    rules = eligibility(id);
  const unchanged = `sede=? AND date=? AND start=? AND m1=? AND m2=?`;
  const sql = `WITH ${siteCTE()},${clockCTE} UPDATE mediations SET sede=?,date=?,start=?,m1=?,m2=?,title=?,case_number=?,updated_at=?,version=version+1,exported_at=NULL,export_id=NULL WHERE id=? AND ${adminSQL} AND ((${unchanged}) OR (state<>'CANCELADA_POR_ADMIN' AND ${rules.sql}))`;
  const [write] = await env.DB.batch([
    stmt(
      env,
      sql,
      ...clockArgs(now),
      m.sede,
      m.date,
      m.start,
      m.m1,
      m.m2,
      m.title,
      m.case_number,
      stamp(),
      id,
      actor,
      m.sede,
      m.date,
      m.start,
      m.m1,
      m.m2,
      ...rules.args(m),
    ),
    auditAfter(env, actor, "EDIT", "mediations", id),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "No se pudo editar: horario completo, mediador ocupado, día bloqueado, fecha fuera de plazo o sin permisos.",
      409,
    );
}
export async function cancel(env: Env, actor: number, id: number, now?: Date) {
  const predicate = `id=? AND state<>'CANCELADA_POR_ADMIN' AND (m1=? OR m2=?) AND (date||' '||start)>(SELECT substr(local_now,1,16) FROM clock) AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='MEDIADOR' AND active=1)`;
  const [audit, write] = await env.DB.batch([
    stmt(
      env,
      `WITH ${clockCTE} INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at,detail) SELECT ?,'CANCEL','mediations',id,?,date||' '||start FROM mediations WHERE ${predicate}`,
      ...clockArgs(now),
      actor,
      stamp(),
      id,
      actor,
      actor,
      actor,
    ),
    stmt(
      env,
      `DELETE FROM mediations WHERE id=? AND changes()=1 AND EXISTS(SELECT 1 FROM audit_log WHERE id=last_insert_rowid() AND actor_id=? AND action='CANCEL' AND entity='mediations' AND entity_id=?)`,
      id,
      actor,
      id,
    ),
  ]);
  if (write.meta.changes !== 1 || audit.meta.changes !== 1)
    throw new BusinessError(
      "No se puede cancelar una mediación que ya comenzó, ya fue cancelada o de la que no forma parte.",
      409,
    );
}
export async function changeState(
  env: Env,
  actor: number,
  id: number,
  state: string,
  result: string,
) {
  resultValid(state, result);
  const [write] = await env.DB.batch([
    stmt(
      env,
      `UPDATE mediations SET state=?,result=?,updated_at=?,version=version+1,exported_at=NULL,export_id=NULL WHERE id=? AND ${adminSQL} AND (state<>'CANCELADA_POR_ADMIN' OR ?='CANCELADA_POR_ADMIN')`,
      state,
      result,
      stamp(),
      id,
      actor,
      state,
    ),
    auditAfter(env, actor, "CHANGE_STATE", "mediations", id, state),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "No tiene permiso o la mediación fue cancelada por un bloqueo.",
      409,
    );
}
export async function block(
  env: Env,
  actor: number,
  sede: string,
  date: string,
  reason: string,
  unblock: boolean,
) {
  date = dateInput(date);
  if (!validDate(date)) throw new BusinessError("Fecha inválida.");
  const config = await import("../config/sites");
  if (!config.site(sede)) throw new BusinessError("Sede inválida.");
  if (reason.length > 300)
    throw new BusinessError("El motivo supera 300 caracteres.");
  const statements = unblock
    ? [
        stmt(
          env,
          `DELETE FROM blocked_days WHERE sede=? AND date=? AND ${adminSQL}`,
          sede,
          date,
          actor,
        ),
        auditAfter(env, actor, "UNBLOCK", "blocked_days", 0, `${sede} ${date}`),
      ]
    : [
        stmt(
          env,
          `INSERT INTO blocked_days(sede,date,reason) SELECT ?,?,? WHERE ${adminSQL} ON CONFLICT(sede,date) DO UPDATE SET reason=excluded.reason`,
          sede,
          date,
          reason,
          actor,
        ),
        auditAfter(env, actor, "BLOCK", "blocked_days", 0, `${sede} ${date}`),
        stmt(
          env,
          `UPDATE mediations SET state='CANCELADA_POR_ADMIN',updated_at=?,version=version+1,exported_at=NULL,export_id=NULL WHERE sede=? AND date=? AND ${adminSQL}`,
          stamp(),
          sede,
          date,
          actor,
        ),
      ];
  const [write] = await env.DB.batch(statements);
  if (!unblock && write.meta.changes !== 1)
    throw new BusinessError("No tiene permiso para bloquear el día.", 403);
}
export async function cleanup(env: Env, now = new Date()) {
  const cutoff = (await import("../lib/dates")).addDays(today(now), -7);
  await env.DB.batch([
    stmt(env, `DELETE FROM sessions WHERE expires_at<?`, stamp()),
    stmt(env, `DELETE FROM login_attempts WHERE expires_at<?`, Date.now()),
    stmt(
      env,
      `DELETE FROM mediations WHERE date<? AND exported_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mediations other WHERE other.date=mediations.date AND other.exported_at IS NULL)`,
      cutoff,
    ),
  ]);
}
