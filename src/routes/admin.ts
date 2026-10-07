import { Hono } from "hono";
import type { AppEnv, Mediation, User, News } from "../types";
import { BusinessError } from "../types";
import { requireUser } from "../middleware/security";
import { stmt, MED_SELECT, USER_COLUMNS } from "../services/database";
import {
  editDetails,
  changeState,
  block,
} from "../services/reservation-service";
import {
  enableDNI,
  createAdmin,
  manageUser,
  importRows,
} from "../services/user-service";
import { saveNews } from "../services/news-service";
import { exportPage, confirmExport } from "../services/export-service";
import { saveImage } from "../lib/r2";
import {
  dateInput,
  validDate,
  today,
  addDays,
  dateES,
  timestampES,
  detailES,
} from "../lib/dates";
import { id, searchText } from "../lib/validation";
import {
  page,
  post,
  hidden,
  e,
  link,
  query,
  field,
  dateField,
  select,
  sitesSelect,
  table,
  pagination,
  card,
  STATES,
  RESULTS,
  redirect,
} from "../views/html";
import {
  editView,
  stateView,
  usersView,
  manualWhitelist,
  newsView,
} from "../views/pages";
import { f, proof } from "./auth";
import { activeUsers } from "./mediator";
const routes = new Hono<AppEnv>();
routes.use("*", requireUser("ADMIN"));
const actor = (c: { get: (key: "user") => User | null }) => c.get("user")!.id;
const pageNum = (c: { req: { query: (k: string) => string | undefined } }) =>
  Math.max(1, Math.min(100000, Number(c.req.query("page")) || 1));
const mediation = async (c: {
  env: AppEnv["Bindings"];
  req: { query: (k: string) => string | undefined };
}) => {
  const m = await stmt(
    c.env,
    MED_SELECT + "WHERE m.id=?",
    id(c.req.query("id")),
  ).first<Mediation>();
  if (!m) throw new BusinessError("Mediación no encontrada.", 404);
  return m;
};
routes.get("/mediaciones", async (c) => {
  const date = dateInput(c.req.query("date") ?? today());
  if (!validDate(date)) throw new BusinessError("Fecha inválida.");
  const state = c.req.query("state") ?? "",
    result = c.req.query("result") ?? "",
    p = pageNum(c);
  const params: (string | number)[] = [date];
  let sql = MED_SELECT + "WHERE m.date=?";
  if (state) {
    sql += " AND m.state=?";
    params.push(state);
  }
  if (result) {
    sql += " AND m.result=?";
    params.push(result);
  }
  const rows = (
    await stmt(
      c.env,
      sql + " ORDER BY m.start,m.id LIMIT 51 OFFSET ?",
      ...params,
      (p - 1) * 50,
    ).all<Mediation>()
  ).results;
  const pending = await stmt(
    c.env,
    "SELECT count(*) AS count FROM mediations WHERE date=? AND exported_at IS NULL",
    date,
  ).first<{ count: number }>();
  const body = `<section id="daily">${date < today() && pending?.count ? `<p class="warning" role="alert">Recordá exportar las mediaciones del ${dateES(date)}. Se eliminarán una vez exportadas y vencido el período operativo. ${link("/admin/exportaciones", "Exportar", "")}</p>` : ""}<form class="toolbar" method="get" action="/admin/mediaciones" hx-get="/admin/mediaciones" hx-target="#daily" hx-select="#daily" hx-swap="outerHTML" hx-push-url="true">${dateField("Fecha", "date", date) + select("Estado", "state", [["", "Todos"], ...STATES.map((s) => [s, s] as [string, string])], state) + select("Resultado", "result", [["", "Todos"], ...RESULTS.map((s) => [s, s] as [string, string])], result)}<button>Filtrar</button></form>${
    table(
      [
        "Hora / sede",
        "Expediente / carátula",
        "Mediadores",
        "Estado / resultado",
        "Acciones",
      ],
      rows
        .slice(0, 50)
        .map((m) => [
          `${e(m.start)}<br>${e(m.sede)}`,
          `${e(m.case_number)}<br>${e(m.title)}`,
          `${e(m.name1)}<br>${e(m.name2)}`,
          `${e(m.state)}<br>${e(m.result)}`,
          link(query("/admin/editar", { id: m.id }), "Editar") +
            " " +
            link(query("/admin/estado", { id: m.id }), "Estado"),
        ]),
      "Mediaciones del " + dateES(date),
    ) +
    pagination("/admin/mediaciones", p, rows.length > 50, {
      date,
      state,
      result,
    })
  }</section>`;
  return page(
    c,
    "Mediaciones del día",
    (c.req.header("HX-Request")
      ? ""
      : `<div class="toolbar">${link(query("/admin/mediaciones", { date: addDays(today(), -1) }), "Ayer") + link("/admin/mediaciones", "Hoy", "button") + link(query("/admin/mediaciones", { date: addDays(today(), 1) }), "Mañana")}</div>`) +
      body,
    "daily",
  );
});
routes.get("/editar", async (c) =>
  page(
    c,
    "Editar mediación",
    editView(c, await mediation(c), await activeUsers(c)),
  ),
);
routes.post("/editar", async (c) => {
  await editDetails(c.env, actor(c), id(f(c, "id")), {
    sede: f(c, "sede"),
    date: f(c, "date"),
    start: f(c, "start"),
    m1: id(f(c, "m1")),
    m2: id(f(c, "m2")),
    title: f(c, "title"),
    case_number: f(c, "case"),
  });
  return redirect(c, "/admin/mediaciones", "Mediación actualizada.");
});
routes.get("/estado", async (c) =>
  page(c, "Cambiar estado", stateView(c, await mediation(c))),
);
routes.post("/estado", async (c) => {
  await changeState(
    c.env,
    actor(c),
    id(f(c, "id")),
    f(c, "state"),
    f(c, "result"),
  );
  return redirect(c, "/admin/mediaciones", "Estado actualizado.");
});
routes.get("/usuarios", async (c) => {
  const role = c.req.query("role") === "ADMIN" ? "ADMIN" : "MEDIADOR",
    q = (c.req.query("q") ?? "").slice(0, 254),
    p = pageNum(c);
  const users = (
    await stmt(
      c.env,
      `SELECT ${USER_COLUMNS} FROM users WHERE role=? AND (search_text LIKE ? OR email LIKE ? OR username LIKE ?) ORDER BY apellido,nombre LIMIT 51 OFFSET ?`,
      role,
      "%" + searchText(q) + "%",
      "%" + q + "%",
      "%" + q + "%",
      (p - 1) * 50,
    ).all<User>()
  ).results;
  return page(
    c,
    "Usuarios",
    usersView(c, users.slice(0, 50), role, q, p, users.length > 50),
    "user-results",
  );
});
routes.post("/usuarios", async (c) => {
  await manageUser(c.env, actor(c), id(f(c, "id")), f(c, "action"), proof(c));
  return redirect(
    c,
    "/admin/usuarios",
    "Usuario actualizado. Sus sesiones fueron invalidadas.",
  );
});
routes.post("/crear-admin", async (c) => {
  await createAdmin(c.env, actor(c), f(c, "name"), f(c, "username"), proof(c));
  return redirect(c, "/admin/usuarios?role=ADMIN", "Administrador creado.");
});
routes.get("/dnis", async (c) => {
  const p = pageNum(c),
    rows = (
      await stmt(
        c.env,
        "SELECT dni,nombre,apellido,email FROM whitelist ORDER BY apellido,nombre LIMIT 51 OFFSET ?",
        (p - 1) * 50,
      ).all<Record<string, string>>()
    ).results;
  return page(
    c,
    "DNI pendientes",
    manualWhitelist(c, rows.slice(0, 50), p, rows.length > 50),
  );
});
routes.get("/matriculas", (c) => c.redirect("/admin/dnis", 303));
routes.post("/dnis", async (c) => {
  await enableDNI(c.env, actor(c), {
    dni: f(c, "dni"),
    nombre: f(c, "first"),
    apellido: f(c, "last"),
    email: f(c, "email"),
  });
  return redirect(
    c,
    "/admin/dnis",
    "DNI habilitado. El mediador ya puede registrarse.",
  );
});
routes.post("/importar", async (c) => {
  const data = await c.req.json<{ rows: unknown[] }>();
  return c.json(await importRows(c.env, actor(c), data.rows));
});
routes.get("/bloqueos", async (c) => {
  const rows = (
    await stmt(
      c.env,
      "SELECT sede,date,reason FROM blocked_days ORDER BY date DESC LIMIT 200",
    ).all<{ sede: string; date: string; reason: string }>()
  ).results;
  const form = card(
    post(
      c,
      "/admin/bloqueos",
      `<div class="form-grid">${sitesSelect() + dateField("Fecha", "date", "") + field("Motivo opcional", "reason", "", "text", 'maxlength="300"')}</div><p>Se cancelarán todas las mediaciones existentes para esa sede y fecha.</p><button class="danger">Bloquear día</button>`,
      'data-confirm="¿Bloquear el día y cancelar todas sus mediaciones?"',
    ),
  );
  return page(
    c,
    "Días bloqueados",
    form +
      `<div class="cards">${rows.map((r) => card(`<h2>${dateES(r.date)} · ${e(r.sede)}</h2><p>${e(r.reason)}</p>${post(c, "/admin/bloqueos", hidden("sede", r.sede) + hidden("date", r.date) + hidden("action", "unblock") + '<button class="secondary">Desbloquear sin restaurar reservas</button>')}`)).join("") || "<p>No hay días bloqueados.</p>"}</div>`,
  );
});
routes.post("/bloqueos", async (c) => {
  await block(
    c.env,
    actor(c),
    f(c, "sede"),
    f(c, "date"),
    f(c, "reason"),
    f(c, "action") === "unblock",
  );
  return redirect(
    c,
    "/admin/bloqueos",
    "Calendario actualizado. Desbloquear no restaura reservas canceladas.",
  );
});
routes.get("/noticias", async (c) => {
  const p = pageNum(c),
    ns = (
      await stmt(
        c.env,
        "SELECT id,title,content,image,published,publication_date,updated_at FROM news ORDER BY publication_date DESC,id DESC LIMIT 51 OFFSET ?",
        (p - 1) * 50,
      ).all<News>()
    ).results;
  const editID = id(c.req.query("id")),
    edit = editID
      ? await stmt(
          c.env,
          "SELECT id,title,content,image,published,publication_date,updated_at FROM news WHERE id=?",
          editID,
        ).first<News>()
      : null;
  if (editID && !edit) throw new BusinessError("Noticia no encontrada.", 404);
  return page(
    c,
    "Noticias",
    newsView(c, ns.slice(0, 50), edit, p, ns.length > 50),
  );
});
routes.post("/noticias", async (c) => {
  const file = c.get("form").image,
    key =
      file instanceof File && file.size
        ? await saveImage(c.env, file, "news")
        : "";
  const data = Object.fromEntries(
    Object.entries(c.get("form")).map(([k, v]) => [
      k,
      typeof v === "string" ? v : "",
    ]),
  );
  try {
    await saveNews(c.env, actor(c), data, key);
  } catch (e) {
    if (key && e instanceof BusinessError) await c.env.FILES.delete(key);
    throw e;
  }
  return redirect(c, "/admin/noticias", "Noticia actualizada.");
});
routes.get("/exportaciones", async (c) => {
  const p = pageNum(c),
    rows = (
      await stmt(
        c.env,
        "SELECT id,date_from,date_to,created_at,filename,count FROM exports ORDER BY id DESC LIMIT 51 OFFSET ?",
        (p - 1) * 50,
      ).all<{
        id: number;
        date_from: string;
        date_to: string;
        created_at: string;
        filename: string;
        count: number;
      }>()
    ).results;
  const pending = await stmt(
    c.env,
    "SELECT count(*) AS count,min(date) AS oldest FROM mediations WHERE exported_at IS NULL",
  ).first<{ count: number; oldest: string }>();
  return page(
    c,
    "Exportaciones",
    `${pending?.count ? `<p class="warning">${pending.count} mediaciones pendientes de exportación. Fecha más antigua: ${dateES(pending.oldest)}. Se conservarán hasta que sean exportadas.</p>` : ""}${card(`<form data-export action="/admin/exportar" method="post">${hidden("csrf", c.get("csrf"))}<div class="form-grid">${dateField("Desde", "from", pending?.oldest ?? today()) + dateField("Hasta", "to", today())}</div><button>Exportar mediaciones</button></form><p class="muted">Se genera XLSX en su navegador y se guarda en R2 antes de marcar los registros. El archivo puede descargarse nuevamente.</p><p id="export-progress" role="status"></p>`)}${
      table(
        ["Período", "Fecha de exportación", "Registros", "Archivo"],
        rows
          .slice(0, 50)
          .map((r) => [
            dateES(r.date_from) + " – " + dateES(r.date_to),
            timestampES(r.created_at),
            String(r.count),
            link("/admin/descargar/" + r.id, "Descargar XLSX", ""),
          ]),
      ) + pagination("/admin/exportaciones", p, rows.length > 50)
    }`,
  );
});
routes.get("/exportar/datos", async (c) =>
  c.json(
    await exportPage(
      c.env,
      actor(c),
      c.req.query("from") ?? "",
      c.req.query("to") ?? "",
      Number(c.req.query("cursor")) || 0,
    ),
  ),
);
routes.post("/exportar", async (c) => {
  const file = c.get("form").xlsx;
  if (!(file instanceof File))
    throw new BusinessError("Genere el archivo desde Exportaciones.");
  let manifest;
  try {
    manifest = JSON.parse(f(c, "manifest"));
  } catch {
    throw new BusinessError("Manifest de exportación inválido.");
  }
  const result = await confirmExport(
    c.env,
    actor(c),
    f(c, "from"),
    f(c, "to"),
    manifest,
    file,
  );
  return c.json({ ...result, download: "/admin/descargar/" + result.id });
});
routes.get("/descargar/:file", async (c) => {
  const file = c.req.param("file");
  const row = await stmt(
    c.env,
    "SELECT filename FROM exports WHERE id=? OR filename=?",
    id(file),
    file,
  ).first<{ filename: string }>();
  if (!row) throw new BusinessError("Exportación no encontrada.", 404);
  const object = await c.env.FILES.get(row.filename);
  if (!object) throw new BusinessError("Archivo no encontrado en R2.", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="mediaciones.xlsx"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
routes.get("/auditoria", async (c) => {
  const p = pageNum(c),
    rows = (
      await stmt(
        c.env,
        "SELECT a.created_at,coalesce(u.username,'CLI') AS actor,a.action,a.entity,a.entity_id,a.detail FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 51 OFFSET ?",
        (p - 1) * 50,
      ).all<{
        created_at: string;
        actor: string;
        action: string;
        entity: string;
        entity_id: number;
        detail: string;
      }>()
    ).results;
  return page(
    c,
    "Auditoría",
    table(
      ["Fecha", "Actor", "Acción", "Entidad", "Detalle"],
      rows
        .slice(0, 50)
        .map((r) => [
          timestampES(r.created_at),
          e(r.actor),
          e(r.action),
          e(r.entity) + " #" + r.entity_id,
          e(detailES(r.detail)),
        ]),
    ) + pagination("/admin/auditoria", p, rows.length > 50),
  );
});
export default routes;
