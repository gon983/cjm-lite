import type { Ctx, Mediation, News, User } from "../types";
import {
  e,
  card,
  post,
  field,
  dateField,
  sitesSelect,
  select,
  hidden,
  passwordField,
  link,
  query,
  table,
  pagination,
  picker,
  STATES,
  RESULTS,
} from "./html";
import { dateES, timestampES, today, localNow, detailES } from "../lib/dates";
export const newsCards = (ns: News[]) =>
  `<h2>Noticias recientes</h2><div class="cards">${ns.map((n) => `<article class="card">${n.image ? `<img class="news-image" src="/uploads/${e(n.image)}" alt="" loading="lazy">` : ""}<p class="muted">${e(dateES(n.publication_date))}</p><h3>${e(n.title)}</h3><p class="prewrap">${e(n.content)}</p></article>`).join("") || "<p>No hay noticias publicadas.</p>"}</div>`;
export function loginView(c: Ctx) {
  return card(
    `<p>Ingrese con su DNI o usuario administrativo.</p>${post(c, "/login", field("DNI / usuario", "username", "", "text", 'required autocomplete="username" maxlength="254"') + passwordField() + "<button>Ingresar</button>", 'data-password-mode="login"')}<p>${link("/registro", "Registrar DNI habilitado", "")}</p><p class="muted">Si olvidó su contraseña, comuníquese con un funcionario.</p><noscript><p class="warning">Active JavaScript para procesar su contraseña de forma segura.</p></noscript>`,
    "narrow",
  );
}
export function registerView(
  c: Ctx,
  dni: string,
  row: Record<string, string> | null,
) {
  return card(
    `<form method="get" action="/registro">${field("DNI", "dni", dni, "text", 'required inputmode="numeric" maxlength="12"')}<button>Consultar DNI</button></form>${dni && !row ? '<p class="notice" role="alert">El DNI no está habilitado o ya fue registrado.</p>' : ""}${row ? `<h2>${e(row.nombre)} ${e(row.apellido)}</h2><p>${e(row.email)}</p>${post(c, "/registro", hidden("dni", dni) + field("Teléfono", "phone", "", "tel", 'required maxlength="60" autocomplete="tel"') + passwordField() + field("Confirmar contraseña", "confirm", "", "password", 'required minlength="12" maxlength="72" autocomplete="new-password"') + '<label>Foto (JPEG o PNG, máximo 5 MB)<input type="file" name="photo" accept="image/jpeg,image/png" required></label><button>Completar registro</button>', 'enctype="multipart/form-data" data-password-mode="new"')}` : ""}`,
    "narrow",
  );
}
export function reserveView(c: Ctx, users: User[]) {
  return card(
    `<p>Usted será el mediador 1. Ambos participantes verán la reserva.</p>${post(c, "/reservar", sitesSelect(c.req.query("sede")) + dateField("Fecha", "date", c.req.query("fecha") ?? "") + field("Hora", "start", c.req.query("hora"), "time", "required") + `<label>Buscar mediador 2<input type="search" name="q" autocomplete="off" placeholder="Nombre, apellido o DNI" hx-get="/mediadores/buscar" hx-trigger="input changed delay:150ms, search" hx-target="#mediator-picker" hx-select="#mediator-picker" hx-swap="outerHTML" hx-sync="this:replace"></label>` + picker(users, c.get("user")!.id) + field("Carátula", "title", "", "text", 'required maxlength="300"') + field("Número de expediente", "case", "", "text", 'required maxlength="120"') + "<button>Confirmar reserva</button>")}`,
    "narrow",
  );
}
export function mediationCards(c: Ctx, ms: Mediation[], cancel = false) {
  return `<div class="cards">${ms.map((m) => `<article class="card"><h2>${e(dateES(m.date))} · ${e(m.start)}</h2><p>${e(m.sede)} · <span class="badge">${e(m.state)}</span></p><h3>${e(m.title)}</h3><p>Expediente ${e(m.case_number)}</p><p>${e(m.name1)} / ${e(m.name2)}</p>${m.result ? `<p>Resultado: ${e(m.result)}</p>` : ""}${cancel && m.state !== "CANCELADA_POR_ADMIN" && m.date + " " + m.start > localNow().slice(0, 16) ? post(c, "/cancelar", hidden("id", m.id) + '<button class="danger">Cancelar reserva</button>', 'data-confirm="¿Cancelar esta reserva para ambos mediadores?"') : ""}</article>`).join("") || "<p>No tiene mediaciones en este período.</p>"}</div>`;
}
export function editView(c: Ctx, m: Mediation, users: User[]) {
  const opts = users.map(
    (u) =>
      [String(u.id), `${u.apellido} ${u.nombre} · ${u.dni}`] as [
        string,
        string,
      ],
  );
  for (const [id, name, dni] of [
    [m.m1, m.name1, m.dni1],
    [m.m2, m.name2, m.dni2],
  ] as [number, string, string][])
    if (!users.some((u) => u.id === id))
      opts.push([String(id), `${name} · ${dni}`]);
  return card(
    post(
      c,
      "/admin/editar",
      hidden("id", m.id) +
        `<div class="form-grid">${sitesSelect(m.sede) + dateField("Fecha", "date", m.date) + field("Hora", "start", m.start, "time", "required") + select("Mediador 1", "m1", opts, String(m.m1)) + select("Mediador 2", "m2", opts, String(m.m2)) + field("Carátula", "title", m.title, "text", 'required maxlength="300"') + field("Expediente", "case", m.case_number, "text", 'required maxlength="120"')}</div><p class="muted">Cambiar sede, fecha, hora o mediadores vuelve a validar disponibilidad y conflictos. Cada cambio exige una nueva exportación.</p><button>Guardar cambios</button>`,
    ),
  );
}
export function stateView(c: Ctx, m: Mediation) {
  return card(
    `<h2>${e(m.title)}</h2><p>${e(dateES(m.date))} · ${e(m.start)} · ${e(m.sede)}</p><p>Expediente ${e(m.case_number)}</p>${post(
      c,
      "/admin/estado",
      hidden("id", m.id) +
        select(
          "Estado",
          "state",
          (m.state === "CANCELADA_POR_ADMIN"
            ? ["CANCELADA_POR_ADMIN"]
            : STATES.slice(0, 4)
          ).map((s) => [s, s]),
          m.state,
        ) +
        select(
          "Resultado",
          "result",
          [
            ["", "Sin resultado"],
            ...RESULTS.map((s) => [s, s] as [string, string]),
          ],
          m.result,
        ) +
        "<button>Guardar estado</button>",
    )}`,
    "narrow",
  );
}
export function manualWhitelist(
  c: Ctx,
  users: Record<string, string>[],
  p: number,
  more: boolean,
) {
  return (
    card(
      "<h2>Habilitar DNI manualmente</h2>" +
        post(
          c,
          "/admin/dnis",
          `<div class="form-grid">${field("DNI", "dni", "", "text", 'inputmode="numeric" maxlength="12" required') + field("Nombre", "first", "", "text", 'maxlength="100" required') + field("Apellido", "last", "", "text", 'maxlength="100" required') + field("Email", "email", "", "email", 'maxlength="254" required')}</div><button>Habilitar DNI</button>`,
        ),
    ) +
    card(
      `<h2>Importar Excel o CSV</h2><p>XLSX o CSV. Se reconocen apellido, nombre, DNI y email por encabezado; sin encabezado: A apellido, B nombre, C DNI, H email.</p><form data-import action="/admin/importar" method="post"><input type="hidden" name="csrf" value="${e(c.get("csrf"))}"><label>Archivo XLSX o CSV<input type="file" name="xlsx" accept=".xlsx,.csv,.txt" required></label><button>Preparar importación</button></form><div id="import-preview" aria-live="polite"></div>`,
    ) +
    table(
      ["DNI", "Nombre", "Email"],
      users.map((u) => [e(u.dni), e(u.apellido + " " + u.nombre), e(u.email)]),
    ) +
    pagination("/admin/dnis", p, more)
  );
}
export function usersView(
  c: Ctx,
  users: User[],
  role: string,
  q: string,
  p: number,
  more: boolean,
) {
  return `<form class="toolbar" action="/admin/usuarios" method="get" hx-get="/admin/usuarios" hx-target="#user-results" hx-select="#user-results" hx-swap="outerHTML">${hidden("role", role) + field("Buscar nombre, DNI o email", "q", q, "search")}<button>Buscar</button></form>${role === "ADMIN" ? `<details class="card"><summary>Crear administrador</summary>${post(c, "/admin/crear-admin", field("Nombre", "name", "", "text", 'required maxlength="100"') + field("Usuario / email", "username", "", "text", 'required maxlength="254"') + passwordField() + "<button>Crear administrador</button>", 'data-password-mode="new"')}</details>` : ""}<section id="user-results">${
    table(
      ["Persona", "Contacto", "Estado", "Acciones"],
      users.map((u) => [
        `${u.photo ? `<img class="avatar" src="/uploads/${e(u.photo)}" alt="Foto de ${e(u.nombre)}" loading="lazy">` : ""}${e(u.apellido + " " + u.nombre)}<br>${e(u.dni ?? u.username)}`,
        `${e(u.email)}<br>${e(u.telefono)}`,
        u.active ? "Activo" : "Inactivo",
        post(
          c,
          "/admin/usuarios",
          hidden("id", u.id) +
            hidden("action", "toggle") +
            `<button class="secondary">${u.active ? "Desactivar" : "Reactivar"}</button>`,
        ) +
          `<details><summary>Restablecer contraseña</summary>${post(c, "/admin/usuarios", hidden("id", u.id) + hidden("action", "reset") + passwordField("Nueva contraseña") + "<button>Restablecer</button>", 'data-password-mode="new"')}</details>`,
      ]),
    ) + pagination("/admin/usuarios", p, more, { role, q })
  }</section>`;
}
export function newsView(
  c: Ctx,
  ns: News[],
  edit: News | null,
  p: number,
  more: boolean,
) {
  return (
    card(
      `<h2>${edit ? "Editar noticia" : "Crear noticia"}</h2>${post(c, "/admin/noticias", hidden("id", edit?.id ?? 0) + field("Título", "title", edit?.title, "text", 'required maxlength="200"') + `<label>Contenido<textarea name="content" rows="6" maxlength="20000" required>${e(edit?.content)}</textarea></label>` + dateField("Fecha de publicación", "date", edit?.publication_date ?? today()) + '<label>Imagen opcional (JPEG/PNG, 5 MB)<input type="file" name="image" accept="image/jpeg,image/png"></label>' + `<label class="checkbox"><input type="checkbox" name="published" value="1" ${edit?.published ? "checked" : ""}>Publicar</label><button>Guardar noticia</button>`, 'enctype="multipart/form-data"')}`,
    ) +
    `<div class="cards">${ns.map((n) => `<article class="card"><h2>${e(n.title)}</h2><p>${e(dateES(n.publication_date))} · ${n.published ? "Publicada" : "Borrador"}</p>${link(query("/admin/noticias", { id: n.id }), "Editar")}${post(c, "/admin/noticias", hidden("id", n.id) + hidden("action", "delete") + '<button class="danger">Eliminar</button>', 'data-confirm="¿Eliminar la noticia?"')}</article>`).join("")}</div>` +
    pagination("/admin/noticias", p, more)
  );
}
