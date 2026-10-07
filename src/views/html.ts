import type { Ctx, User } from "../types";
import { SITES } from "../config/sites";
import { dateES, today } from "../lib/dates";
export const e = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const query = (path: string, p: Record<string, unknown>) =>
  path +
  (path.includes("?") ? "&" : "?") +
  new URLSearchParams(
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v ?? "")])),
  );
export const link = (url: string, label: string, cls = "button secondary") =>
  `<a class="${e(cls)}" href="${e(url)}">${e(label)}</a>`;
export const hidden = (name: string, value: unknown) =>
  `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export const field = (
  label: string,
  name: string,
  value: unknown = "",
  type = "text",
  attrs = "",
) =>
  `<label>${e(label)}<input type="${type}" name="${e(name)}" value="${e(value)}" ${attrs}></label>`;
export const dateField = (label: string, name: string, value: string) =>
  field(
    label,
    name,
    dateES(value),
    "text",
    'inputmode="numeric" placeholder="dd/mm/aaaa" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" maxlength="10" required',
  );
export const select = (
  label: string,
  name: string,
  values: [string, string][],
  chosen = "",
  attrs = "",
) =>
  `<label>${e(label)}<select name="${e(name)}" ${attrs}>${values.map(([v, l]) => `<option value="${e(v)}" ${v === chosen ? "selected" : ""}>${e(l)}</option>`).join("")}</select></label>`;
export const sitesSelect = (chosen = SITES[0].code) =>
  select(
    "Sede",
    "sede",
    SITES.map((s) => [s.code, s.name]),
    chosen,
  );
export const STATES = [
  "RESERVADA",
  "INICIADA",
  "FINALIZADA",
  "FIRMADA",
  "CANCELADA_POR_ADMIN",
];
export const RESULTS = ["CON_ACUERDO", "SIN_ACUERDO", "INCOMPARECENCIA"];
export const csrf = (c: Ctx) => hidden("csrf", c.get("csrf"));
export const passwordField = (label = "Contraseña") =>
  `<label>${e(label)}<input name="password" type="password" minlength="12" maxlength="72" required autocomplete="new-password"></label>`;
export const post = (c: Ctx, path: string, body: string, attrs = "") =>
  `<form action="${e(path)}" method="post" ${attrs}>${csrf(c)}${body}</form>`;
export const card = (body: string, cls = "") =>
  `<section class="card ${e(cls)}">${body}</section>`;
export const table = (heads: string[], rows: string[][], caption = "") =>
  `<div class="table-wrap"><table>${caption ? `<caption>${e(caption)}</caption>` : ""}<thead><tr>${heads.map((x) => `<th>${e(x)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}">No hay registros.</td></tr>`}</tbody></table></div>`;
export const pagination = (
  path: string,
  page: number,
  more: boolean,
  params: Record<string, unknown> = {},
) =>
  `<div class="toolbar">${page > 1 ? link(query(path, { ...params, page: page - 1 }), "Anterior", "") : ""}<span>Página ${page}</span>${more ? link(query(path, { ...params, page: page + 1 }), "Siguiente", "") : ""}</div>`;
export function layout(c: Ctx, title: string, body: string) {
  const u = c.get("user");
  const links = u
    ? [
        ["/", "Inicio"],
        ["/calendario", "Calendario"],
        ...(u.role === "ADMIN"
          ? [
              ["/admin/mediaciones", "Mediaciones"],
              ["/admin/usuarios", "Mediadores"],
              ["/admin/noticias", "Noticias"],
              ["/admin/dnis", "DNI habilitados"],
              ["/admin/exportaciones", "Exportaciones"],
              ["/admin/bloqueos", "Días bloqueados"],
              ["/admin/usuarios?role=ADMIN", "Administradores"],
              ["/admin/auditoria", "Auditoría"],
            ]
          : [["/mis-mediaciones", "Mis mediaciones"]]),
      ]
    : [];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · CJM</title><link rel="stylesheet" href="/static/app.css"><meta name="htmx-config" content='{"includeIndicatorStyles":false,"allowEval":false,"allowScriptTags":false}'><script src="/static/htmx.min.js" defer></script><script src="/static/app.js" defer></script><script src="/static/forms.js" defer></script>${c.req.path.startsWith("/admin/dnis") || c.req.path.startsWith("/admin/exportaciones") ? '<script src="/static/spreadsheets.js" defer></script>' : ""}</head><body hx-history="false"><a class="skip" href="#main">Ir al contenido</a><header><a class="brand" href="/">CJM <span>Centro Judicial de Mediación</span></a>${u ? `<div class="identity">${e(u.nombre)} · ${e(u.role)}${post(c, "/logout", '<button class="secondary">Salir</button>')}</div>` : ""}</header>${u ? `<nav aria-label="Navegación principal">${links.map(([url, label]) => link(url, label, "")).join("")}</nav>` : ""}<main id="main"><h1>${e(title)}</h1>${c.req.query("mensaje") ? `<p class="notice" role="status">${e(c.req.query("mensaje"))}</p>` : ""}${body}</main><footer>CJM · Córdoba · Horarios de Argentina</footer></body></html>`;
}
export function page(c: Ctx, title: string, body: string, fragmentID?: string) {
  if (fragmentID && c.req.header("HX-Request") === "true") return c.html(body);
  return c.html(layout(c, title, body));
}
export const redirect = (c: Ctx, path: string, message: string) =>
  c.redirect(query(path, { mensaje: message }), 303);
export function mediatorOptions(users: User[], chosen: number, exclude = 0) {
  return users
    .filter((u) => u.id !== exclude)
    .map(
      (u) =>
        [String(u.id), `${u.apellido} ${u.nombre} · ${u.dni}`] as [
          string,
          string,
        ],
    );
}
export function picker(users: User[], exclude = 0) {
  return `<div id="mediator-picker">${select("Mediador 2", "m2", [["", "Seleccione un mediador"], ...mediatorOptions(users, 0, exclude)], "", 'id="mediator2" required size="6"')}${users.length ? "" : '<p role="status">No se encontraron mediadores activos.</p>'}</div>`;
}
