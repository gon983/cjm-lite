import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env, Ctx } from "../types";
import { BusinessError } from "../types";
import { page, redirect } from "../views/html";
import { loginView, registerView } from "../views/pages";
import { login, loginSalt } from "../services/auth-service";
import { register, createAdmin } from "../services/user-service";
import { stmt } from "../services/database";
import { normalizeDNI } from "../lib/validation";
import { saveImage } from "../lib/r2";
import { sha256, randomToken, equal } from "../lib/crypto";
export const f = (c: Ctx, key: string) => String(c.get("form")?.[key] ?? "");
export const proof = (c: Ctx) => ({
  passwordSalt: f(c, "passwordSalt"),
  passwordProof: f(c, "passwordProof"),
  passwordBytes: f(c, "passwordBytes"),
});
const routes = new Hono<AppEnv>();
routes.get("/login", (c) => page(c, "Ingresar", loginView(c)));
routes.get("/auth/password-salt", async (c) => {
  const username = c.req.query("username") ?? "";
  if (username.length > 254) throw new BusinessError("Usuario inválido.");
  return c.json(await loginSalt(c.env, username));
});
routes.post("/login", async (c) => {
  const token = await login(
    c.env,
    f(c, "username"),
    f(c, "passwordProof"),
    getCookie(c, "session"),
    c.req.header("CF-Connecting-IP") ?? "local",
  );
  setCookie(c, "session", token, {
    path: "/",
    httpOnly: true,
    secure: c.env.APP_ENV === "production",
    sameSite: "Lax",
    maxAge: Number(c.env.SESSION_TTL) || 43200,
  });
  setCookie(c, "csrf", randomToken(), {
    path: "/",
    httpOnly: true,
    secure: c.env.APP_ENV === "production",
    sameSite: "Lax",
    maxAge: 86400,
  });
  return c.redirect("/", 303);
});
routes.post("/logout", async (c) => {
  await stmt(
    c.env,
    "DELETE FROM sessions WHERE token=?",
    await sha256(getCookie(c, "session") ?? ""),
  ).run();
  setCookie(c, "session", "", {
    path: "/",
    httpOnly: true,
    secure: c.env.APP_ENV === "production",
    sameSite: "Lax",
    maxAge: 0,
  });
  return c.redirect("/login", 303);
});
routes.get("/registro", async (c) => {
  const dni = normalizeDNI(c.req.query("dni") ?? "");
  const row = dni
    ? await stmt(
        c.env,
        "SELECT nombre,apellido,email FROM whitelist WHERE dni=?",
        dni,
      ).first<Record<string, string>>()
    : null;
  return page(c, "Registro de mediador", registerView(c, dni, row));
});
routes.post("/registro", async (c) => {
  if (f(c, "confirmProof") !== f(c, "passwordProof"))
    throw new BusinessError("Las contraseñas no coinciden.");
  const dni = normalizeDNI(f(c, "dni"));
  const exists = await stmt(
    c.env,
    "SELECT dni FROM whitelist WHERE dni=?",
    dni,
  ).first();
  if (!exists)
    throw new BusinessError("El DNI no está habilitado o ya fue registrado.");
  const file = c.get("form").photo;
  if (!(file instanceof File))
    throw new BusinessError("Seleccione una foto JPEG o PNG.");
  const key = await saveImage(c.env, file, "profiles");
  try {
    await register(c.env, dni, f(c, "phone"), key, proof(c));
  } catch (e) {
    if (e instanceof BusinessError) await c.env.FILES.delete(key);
    throw e;
  }
  return redirect(c, "/login", "Registro completado. Ya puede ingresar.");
});
routes.post("/bootstrap", async (c) => {
  if (
    !c.env.BOOTSTRAP_SECRET ||
    !equal(c.req.header("X-Bootstrap-Secret") ?? "", c.env.BOOTSTRAP_SECRET)
  )
    throw new BusinessError("Bootstrap no autorizado.", 403);
  const data = await c.req.json<Record<string, string>>();
  await createAdmin(
    c.env,
    null,
    data.name,
    data.username,
    data as unknown as ReturnType<typeof proof>,
  );
  return c.json({ ok: true }, 201);
});
export default routes;
