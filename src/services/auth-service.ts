import { BusinessError, type Env, type User, type SQLRow } from "../types";
import { normalizeDNI } from "../lib/validation";
import {
  verifyProof,
  passwordText,
  randomToken,
  sha256,
  hmac,
} from "../lib/crypto";
import { stmt, USER_COLUMNS, stamp } from "./database";
export async function loginSalt(env: Env, username: string) {
  const raw = username.trim().toLowerCase();
  const row = await stmt(
    env,
    `SELECT password FROM users WHERE username=? OR (role='MEDIADOR' AND dni=?) ORDER BY CASE WHEN username=? THEN 0 ELSE 1 END LIMIT 1`,
    raw,
    normalizeDNI(raw),
    raw,
  ).first<{ password: unknown }>();
  const p = passwordText(row?.password).split("$");
  return {
    salt:
      p[0] === "client-pbkdf2-sha256"
        ? p[2]
        : await hmac(env.SESSION_SECRET, `missing:${raw}`),
    iterations: 600000,
  };
}
export async function throttle(env: Env, username: string, ip: string) {
  if (username.length > 254) throw new BusinessError("Credenciales inválidas.");
  const now = Date.now(),
    ttl = now + 15 * 60 * 1000;
  const keys = [
    await hmac(env.SESSION_SECRET, `login-ip:${ip}`),
    await hmac(
      env.SESSION_SECRET,
      `login-user:${normalizeDNI(username) || username.toLowerCase().trim()}`,
    ),
  ];
  const rows = await env.DB.batch<SQLRow>(
    keys.map((k) =>
      stmt(
        env,
        `INSERT INTO login_attempts(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<? THEN ? ELSE expires_at END RETURNING count`,
        k,
        ttl,
        now,
        now,
        ttl,
      ),
    ),
  );
  if (
    Number(rows[0].results[0].count) > 120 ||
    Number(rows[1].results[0].count) > 15
  )
    throw new BusinessError("Demasiados intentos. Espere 15 minutos.", 429);
}
export async function login(
  env: Env,
  username: string,
  proof: string,
  oldToken: string | undefined,
  ip: string,
) {
  await throttle(env, username, ip);
  const raw = username.trim().toLowerCase();
  const user = await stmt(
    env,
    `SELECT ${USER_COLUMNS},password FROM users WHERE username=? OR (role='MEDIADOR' AND dni=?) ORDER BY CASE WHEN username=? THEN 0 ELSE 1 END LIMIT 1`,
    raw,
    normalizeDNI(raw),
    raw,
  ).first<User>();
  if (
    !user ||
    !user.active ||
    !(await verifyProof(env.SESSION_SECRET, proof, user.password))
  ) {
    throw new BusinessError("Credenciales inválidas o cuenta inactiva.");
  }
  const token = randomToken(),
    hashed = await sha256(token),
    expires = new Date(
      Date.now() +
        Math.max(60, Math.min(Number(env.SESSION_TTL) || 43200, 86400)) * 1000,
    ).toISOString();
  const [write] = await env.DB.batch<SQLRow>([
    stmt(
      env,
      `INSERT INTO sessions(token,user_id,expires_at,created_at) SELECT ?,id,?,? FROM users WHERE id=? AND active=1 AND password=?`,
      hashed,
      expires,
      stamp(),
      user.id,
      passwordText(user.password),
    ),
    stmt(
      env,
      "DELETE FROM sessions WHERE token=?",
      await sha256(oldToken ?? ""),
    ),
  ]);
  if (write.meta.changes !== 1)
    throw new BusinessError(
      "La cuenta cambió durante el ingreso. Vuelva a intentar.",
    );
  return token;
}
