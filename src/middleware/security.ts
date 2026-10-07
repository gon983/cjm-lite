import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, User } from "../types";
import { BusinessError } from "../types";
import { hmac, sha256, randomToken, equal } from "../lib/crypto";
import { stmt, USER_COLUMNS, stamp } from "../services/database";
import { dateInput } from "../lib/dates";
export const security = createMiddleware<AppEnv>(async (c, next) => {
  c.set("requestId", randomToken().slice(0, 16));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  c.header("Cache-Control", "no-store");
  if (c.env.APP_ENV === "production")
    c.header("Strict-Transport-Security", "max-age=31536000");
  if (c.req.path.startsWith("/static/")) {
    await next();
    return;
  }
  if (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32)
    throw new BusinessError(
      "Configure SESSION_SECRET con al menos 32 caracteres.",
      503,
    );
  if (c.env.APP_ENV === "production" && !c.env.APP_URL.startsWith("https://"))
    throw new BusinessError("APP_URL debe usar HTTPS en producción.", 503);
  const base = getCookie(c, "csrf") ?? randomToken();
  if (!getCookie(c, "csrf"))
    setCookie(c, "csrf", base, {
      path: "/",
      httpOnly: true,
      secure: c.env.APP_ENV === "production",
      sameSite: "Lax",
      maxAge: 86400,
    });
  c.set("csrf", await hmac(c.env.SESSION_SECRET, base));
  c.set("user", null);
  const token = getCookie(c, "session");
  if (token) {
    const user = await stmt(
      c.env,
      `SELECT ${USER_COLUMNS.split(",")
        .map((x) => "u." + x)
        .join(
          ",",
        )} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1`,
      await sha256(token),
      stamp(),
    ).first<User>();
    c.set("user", user);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const length = Number(c.req.header("Content-Length") ?? 0);
    if (length > 8 * 1024 * 1024)
      throw new BusinessError(
        "El archivo o formulario supera el límite permitido.",
        413,
      );
    const type = c.req.header("Content-Type") ?? "";
    let form: Record<string, string | File>;
    if (type.includes("application/json")) {
      c.set("form", {});
      form = {};
    } else {
      form = await c.req.parseBody();
      c.set("form", form);
    }
    const supplied = c.req.header("X-CSRF-Token") ?? String(form.csrf ?? "");
    if (c.req.path !== "/bootstrap" && !equal(supplied, c.get("csrf")))
      throw new BusinessError("El formulario venció. Recargue la página.", 403);
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.env.APP_URL).origin)
      throw new BusinessError("Origen inválido.", 403);
    for (const k of ["date", "from", "to"])
      if (typeof form[k] === "string") form[k] = dateInput(form[k] as string);
  }
  await next();
});
export const requireUser = (role?: "ADMIN" | "MEDIADOR") =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      if (
        c.req.header("HX-Request") ||
        c.req.header("Accept")?.includes("application/json")
      )
        return c.json({ error: "Inicie sesión." }, 401);
      return c.redirect("/login", 303);
    }
    if (role && user.role !== role)
      throw new BusinessError("No tiene permiso para acceder.", 403);
    await next();
  });
