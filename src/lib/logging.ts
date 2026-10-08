import { createMiddleware } from "hono/factory";
import type { AppEnv, Ctx } from "../types";
import { BusinessError } from "../types";
export interface LogFields {
  request_id?: string;
  route?: string;
  method?: string;
  user_id?: number;
  role?: "ADMIN" | "MEDIADOR";
  entity?: string;
  entity_id?: number;
  duration_ms?: number;
  error_code?: string;
  error_type?: string;
  technical_detail?: string;
  error_location?: string[];
}
const allowedFields = [
  "request_id",
  "route",
  "method",
  "user_id",
  "role",
  "entity",
  "entity_id",
  "duration_ms",
  "error_code",
  "error_type",
  "technical_detail",
  "error_location",
] as const;
export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: LogFields = {},
) {
  const output: Record<string, unknown> = {
    level,
    event,
    timestamp: new Date().toISOString(),
  };
  for (const k of allowedFields)
    if (fields[k] !== undefined) output[k] = fields[k];
  console[level === "info" ? "log" : level](output);
}
function route(c: Ctx) {
  const p = c.req.path;
  if (p.startsWith("/uploads/")) return "/uploads/*";
  if (p.startsWith("/static/")) return "/static/*";
  if (p.startsWith("/admin/descargar/")) return "/admin/descargar/:file";
  return [
    "/",
    "/login",
    "/logout",
    "/registro",
    "/bootstrap",
    "/healthz",
    "/calendario",
    "/reservar",
    "/cancelar",
    "/mis-mediaciones",
    "/mi-perfil",
    "/mediadores/buscar",
    "/auth/password-salt",
    "/admin/mediaciones",
    "/admin/editar",
    "/admin/estado",
    "/admin/usuarios",
    "/admin/crear-admin",
    "/admin/dnis",
    "/admin/matriculas",
    "/admin/importar",
    "/admin/bloqueos",
    "/admin/noticias",
    "/admin/exportaciones",
    "/admin/exportar",
    "/admin/exportar/datos",
  ].includes(p)
    ? p
    : "unknown";
}
export function logContext(c: Ctx): LogFields {
  const u = c.get("user");
  return {
    request_id: c.get("requestId"),
    route: route(c),
    method: c.req.method,
    ...(u ? { user_id: u.id, role: u.role } : {}),
    duration_ms: Math.max(0, Date.now() - (c.get("startedAt") || Date.now())),
    ...(c.get("logEntityId") ? { entity_id: c.get("logEntityId") } : {}),
  };
}
const events: Record<string, [string, string]> = {
  "/bootstrap": ["admin_created", "users"],
  "/reservar": ["mediation_created", "mediations"],
  "/cancelar": ["mediation_cancelled", "mediations"],
  "/admin/editar": ["mediation_modified", "mediations"],
  "/admin/estado": ["mediation_state_changed", "mediations"],
  "/admin/bloqueos": ["day_calendar_changed", "blocked_days"],
  "/admin/usuarios": ["user_managed", "users"],
  "/admin/crear-admin": ["admin_created", "users"],
  "/admin/dnis": ["dni_enabled", "whitelist"],
  "/admin/importar": ["whitelist_imported", "whitelist"],
  "/admin/noticias": ["news_managed", "news"],
  "/admin/exportar": ["export_created", "exports"],
  "/mi-perfil": ["profile_updated", "users"],
  "/registro": ["mediator_registered", "users"],
};
export const requestLogging = createMiddleware<AppEnv>(async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.set("startedAt", Date.now());
  c.header("X-Request-ID", c.get("requestId"));
  await next();
  if (c.res.status >= 400 && !c.error) {
    log(c.res.status >= 500 ? "error" : "warn", "response_rejected", {
      ...logContext(c),
      error_code: `HTTP_${c.res.status}`,
    });
    return;
  }
  if (c.req.method === "POST" && c.res.status < 400) {
    const event = events[c.req.path];
    if (event) {
      const form = c.get("form");
      const id = Number(form?.id);
      const action = String(form?.action ?? "");
      const eventName =
        c.req.path === "/admin/usuarios"
          ? action === "reset"
            ? "user_password_reset"
            : "user_active_toggled"
          : c.req.path === "/admin/bloqueos"
            ? action === "unblock"
              ? "day_unblocked"
              : "day_blocked"
            : c.req.path === "/admin/noticias"
              ? action === "delete"
                ? "news_deleted"
                : "news_saved"
              : event[0];
      log("info", eventName, {
        ...logContext(c),
        entity: event[1],
        ...(Number.isSafeInteger(id) && id > 0 ? { entity_id: id } : {}),
      });
    }
  }
});
const safeErrorType = (name: string) =>
  [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "DOMException",
    "AggregateError",
    "BusinessError",
    "D1Error",
    "R2Error",
  ].includes(name)
    ? name
    : "Error";
export function logError(c: Ctx, error: Error) {
  const expected = error instanceof BusinessError;
  const event =
    c.req.path === "/login"
      ? "login_failed"
      : c.req.path === "/reservar" && expected && error.status === 409
        ? "reservation_conflict"
        : expected
          ? "operation_rejected"
          : "unexpected_failure";
  const code = expected
    ? `HTTP_${error.status}`
    : error.message.match(
        /\b(SQLITE_[A-Z_]+|D1_ERROR|R2_ERROR|ERR_[A-Z_]+)\b/,
      )?.[0] || "INTERNAL_ERROR";
  let detail = "";
  if (!expected) {
    const table = error.message.match(/no such table:\s*([a-z_]+)/i)?.[1];
    if (
      table &&
      [
        "users",
        "sessions",
        "mediations",
        "whitelist",
        "news",
        "exports",
        "blocked_days",
        "audit_log",
      ].includes(table)
    )
      detail = "Missing database table: " + table;
    else if (code.startsWith("SQLITE_"))
      detail = "Database constraint or SQLite failure";
    else if (code === "D1_ERROR") detail = "D1 operation failed";
    else if (code === "R2_ERROR") detail = "R2 operation failed";
    else detail = "Unexpected " + safeErrorType(error.name);
  }
  const locations = expected
    ? undefined
    : (
        error.stack?.match(
          /(?:src\/(?:index|types|lib\/(?:crypto|dates|r2|validation|logging)|routes\/(?:auth|admin|mediator)|services\/(?:auth-service|database|export-service|news-service|reservation-service|user-service)|middleware\/security)\.ts|index\.js|worker\.js):\d+:\d+/g,
        ) || []
      ).slice(0, 4);
  log(expected ? "warn" : "error", event, {
    ...logContext(c),
    ...(events[c.req.path] ? { entity: events[c.req.path][1] } : {}),
    error_code: code,
    ...(!expected
      ? {
          error_type: safeErrorType(error.name),
          technical_detail: detail,
          error_location: locations,
        }
      : {}),
  });
}
