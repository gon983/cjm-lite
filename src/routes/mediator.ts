import { Hono } from "hono";
import type { AppEnv, User, Mediation, News, SQLRow } from "../types";
import { BusinessError } from "../types";
import { requireUser } from "../middleware/security";
import { stmt, MED_SELECT, USER_COLUMNS } from "../services/database";
import { reserve, cancel } from "../services/reservation-service";
import { page, card, link, query, e, sitesSelect, picker } from "../views/html";
import { reserveView, mediationCards, newsCards } from "../views/pages";
import {
  today,
  monthLimit,
  monday,
  addDays,
  dateInput,
  validDate,
  dateES,
  localNow,
} from "../lib/dates";
import { SITES, slots, site } from "../config/sites";
import { searchText, id } from "../lib/validation";
import { f } from "./auth";
const routes = new Hono<AppEnv>();
routes.use("*", requireUser());
export async function activeUsers(c: { env: AppEnv["Bindings"] }) {
  return (
    await stmt(
      c.env,
      `SELECT ${USER_COLUMNS} FROM users WHERE role='MEDIADOR' AND active=1 ORDER BY apellido,nombre`,
    ).all<User>()
  ).results;
}
routes.get("/", async (c) => {
  const u = c.get("user")!,
    news = (
      await stmt(
        c.env,
        "SELECT id,title,content,image,published,publication_date,updated_at FROM news WHERE published=1 AND publication_date<=? ORDER BY publication_date DESC,id DESC LIMIT 10",
        today(),
      ).all<News>()
    ).results;
  if (u.role === "ADMIN") {
    const [states, pending, blocked] = await c.env.DB.batch<SQLRow>([
      stmt(
        c.env,
        "SELECT state,count(*) AS count FROM mediations WHERE date=? GROUP BY state",
        today(),
      ),
      stmt(
        c.env,
        "SELECT count(DISTINCT date) AS count,min(date) AS oldest FROM mediations WHERE date<? AND exported_at IS NULL",
        today(),
      ),
      stmt(
        c.env,
        "SELECT date,reason FROM blocked_days WHERE date>=? ORDER BY date LIMIT 1",
        today(),
      ),
    ]);
    const total = states.results.reduce<number>(
        (n, r) => n + Number(r.count),
        0,
      ),
      p = pending.results[0],
      b = blocked.results[0];
    return page(
      c,
      "Dashboard",
      `${Number(p.count) ? `<aside class="warning" role="alert">Hay mediaciones de ${e(p.count)} día(s) pendientes de exportación. La más antigua es del ${e(dateES(String(p.oldest)))}. ${link("/admin/exportaciones", "Exportar mediaciones", "")}. No se eliminarán mientras estén pendientes.</aside>` : ""}<div class="stats">${card(`<span>Mediaciones hoy</span><strong>${total}</strong>`)}${states.results.map((r) => card(`<span>${e(r.state)}</span><strong>${e(r.count)}</strong>`)).join("")}</div><div class="toolbar">${link("/admin/mediaciones", "Abrir panel del día", "button") + link("/admin/exportaciones", "Exportar mediaciones", "")}</div>${b ? `<p class="notice">Próximo día bloqueado: ${e(dateES(String(b.date)))} · ${e(b.reason)}</p>` : ""}${newsCards(news)}`,
    );
  }
  const ms = (
    await stmt(
      c.env,
      MED_SELECT +
        "WHERE (m.m1=? OR m.m2=?) AND m.date>=? AND m.state<>'CANCELADA_POR_ADMIN' ORDER BY m.date,m.start LIMIT 5",
      u.id,
      u.id,
      today(),
    ).all<Mediation>()
  ).results;
  return page(
    c,
    "Inicio",
    `<div class="toolbar">${link("/calendario", "Reservar una mediación", "button") + link("/mis-mediaciones", "Ver mis mediaciones", "")}</div><h2>Próximas mediaciones</h2>${mediationCards(c, ms)}${newsCards(news)}`,
  );
});
routes.get("/calendario", async (c) => {
  const code = c.req.query("sede") ?? SITES[0].code,
    s = site(code);
  if (!s) throw new BusinessError("Sede inválida.");
  const day = dateInput(c.req.query("semana") ?? today());
  if (!validDate(day)) throw new BusinessError("Fecha inválida.");
  const week = monday(day),
    limit = monthLimit(today());
  if (week < addDays(today(), -7) || week > limit)
    throw new BusinessError("La semana está fuera del período disponible.");
  const [counts, blocked] = await c.env.DB.batch<SQLRow>([
    stmt(
      c.env,
      "SELECT date,start,count(*) AS count FROM mediations WHERE sede=? AND date BETWEEN ? AND ? AND state<>'CANCELADA_POR_ADMIN' GROUP BY date,start",
      code,
      week,
      addDays(week, 4),
    ),
    stmt(
      c.env,
      "SELECT date FROM blocked_days WHERE sede=? AND date BETWEEN ? AND ?",
      code,
      week,
      addDays(week, 4),
    ),
  ]);
  const count = new Map(
      counts.results.map((r) => [`${r.date} ${r.start}`, Number(r.count)]),
    ),
    blocks = new Set(blocked.results.map((r) => String(r.date)));
  const nav = (target: string, label: string) =>
    `<a class="button secondary" href="${e(query("/calendario", { sede: code, semana: target }))}" hx-get="${e(query("/calendario", { sede: code, semana: target }))}" hx-target="#calendar" hx-select="#calendar" hx-swap="outerHTML" hx-push-url="true">${e(label)}</a>`;
  const days = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"]
    .map((label, i) => {
      const date = addDays(week, i);
      return `<section class="day"><h2>${label} ${dateES(date)}</h2>${slots(s)
        .map((start) => {
          const free = s.rooms - (count.get(`${date} ${start}`) ?? 0),
            available =
              free > 0 &&
              !blocks.has(date) &&
              date <= limit &&
              date + " " + start > localNow().slice(0, 16),
            text = blocks.has(date)
              ? "Día bloqueado"
              : free <= 0
                ? "Completo"
                : !available
                  ? "No disponible"
                  : `${free} lugar(es) disponible(s)`;
          const content = `<strong>${start}</strong><span>${text}</span>`;
          return available && c.get("user")!.role === "MEDIADOR"
            ? `<a class="slot available" href="${e(query("/reservar", { sede: code, fecha: date, hora: start }))}">${content}</a>`
            : `<div class="slot ${available ? "available" : "unavailable"}">${content}</div>`;
        })
        .join("")}</section>`;
    })
    .join("");
  return page(
    c,
    "Calendario semanal",
    `<section id="calendar"><form class="toolbar" action="/calendario" method="get" hx-get="/calendario" hx-target="#calendar" hx-select="#calendar" hx-swap="outerHTML" hx-push-url="true">${sitesSelect(code)}<input type="hidden" name="semana" value="${week}"><button>Ver calendario</button></form><div class="toolbar">${addDays(week, -7) >= addDays(today(), -7) ? nav(addDays(week, -7), "← Anterior") : ""}<strong>Semana del ${dateES(week)}</strong>${addDays(week, 7) <= limit ? nav(addDays(week, 7), "Siguiente →") : ""}</div><p class="muted">${e(s.name)} · Reservas hasta el ${dateES(limit)} · Lunes a viernes</p><div class="calendar">${days}</div></section>`,
    "calendar",
  );
});
routes.get("/reservar", requireUser("MEDIADOR"), async (c) =>
  page(c, "Reservar mediación", reserveView(c, await activeUsers(c))),
);
routes.post("/reservar", requireUser("MEDIADOR"), async (c) => {
  await reserve(c.env, c.get("user")!.id, {
    sede: f(c, "sede"),
    date: f(c, "date"),
    start: f(c, "start"),
    m1: c.get("user")!.id,
    m2: id(f(c, "m2")),
    title: f(c, "title"),
    case_number: f(c, "case"),
  });
  return c.redirect(
    "/mis-mediaciones?mensaje=Reserva%20creada%20para%20ambos%20mediadores.",
    303,
  );
});
routes.get("/mis-mediaciones", requireUser("MEDIADOR"), async (c) => {
  const u = c.get("user")!;
  const ms = (
    await stmt(
      c.env,
      MED_SELECT +
        "WHERE (m.m1=? OR m.m2=?) AND m.date>=? ORDER BY m.date,m.start LIMIT 100",
      u.id,
      u.id,
      addDays(today(), -7),
    ).all<Mediation>()
  ).results;
  return page(c, "Mis mediaciones", mediationCards(c, ms, true));
});
routes.post("/cancelar", requireUser("MEDIADOR"), async (c) => {
  await cancel(c.env, c.get("user")!.id, id(f(c, "id")));
  return c.redirect(
    "/mis-mediaciones?mensaje=Reserva%20cancelada.%20El%20cupo%20vuelve%20a%20estar%20disponible.",
    303,
  );
});
routes.get("/mediadores/buscar", requireUser("MEDIADOR"), async (c) => {
  const terms = searchText(c.req.query("q") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (terms.join(" ").length > 254)
    throw new BusinessError("Búsqueda demasiado larga.");
  const clauses = terms.map(() => `search_text LIKE ? ESCAPE '\\'`),
    args = terms.map((t) => "%" + t.replace(/[\\%_]/g, (v) => "\\" + v) + "%");
  const users = (
    await stmt(
      c.env,
      `SELECT ${USER_COLUMNS} FROM users WHERE role='MEDIADOR' AND active=1 AND id<>? ${clauses.length ? "AND " + clauses.join(" AND ") : ""} ORDER BY apellido,nombre LIMIT 50`,
      c.get("user")!.id,
      ...args,
    ).all<User>()
  ).results;
  return page(
    c,
    "Buscar mediador",
    picker(users, c.get("user")!.id),
    "mediator-picker",
  );
});
export default routes;
