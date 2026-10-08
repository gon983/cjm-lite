import { requestLogging, logError, log } from "./lib/logging";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { BusinessError } from "./types";
import { security, requireUser } from "./middleware/security";
import auth from "./routes/auth";
import admin from "./routes/admin";
import mediator from "./routes/mediator";
import { cleanup } from "./services/reservation-service";
import { stmt } from "./services/database";
import { layout, e, card, link } from "./views/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
const app = new Hono<AppEnv>();
app.use("*", requestLogging);
app.use(
  "*",
  bodyLimit({
    maxSize: 9 * 1024 * 1024,
    onError: (c) =>
      c.text("El archivo o formulario supera el límite permitido.", 413),
  }),
);
app.use("*", security);
app.get("/static/*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/healthz", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.text("ok");
});
app.get("/uploads/*", requireUser(), async (c) => {
  const key = decodeURIComponent(c.req.path.slice("/uploads/".length));
  if (key.includes("..") || key.length > 512)
    throw new BusinessError("Archivo no encontrado.", 404);
  const user = c.get("user")!;
  const allowed = await stmt(
    c.env,
    "SELECT 1 FROM users WHERE photo=? UNION SELECT 1 FROM news WHERE image=? AND (published=1 OR ?='ADMIN') LIMIT 1",
    key,
    key,
    user.role,
  ).first();
  if (!allowed) throw new BusinessError("Archivo no encontrado.", 404);
  const object = await c.env.FILES.get(key);
  if (!object) throw new BusinessError("Archivo no encontrado.", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
app.route("/", auth);
app.route("/admin", admin);
app.route("/", mediator);
app.notFound((c) =>
  c.html(
    layout(
      c,
      "Página no encontrada",
      card(
        "<p>La página solicitada no existe.</p>" +
          link("/", "Volver al inicio"),
      ),
    ),
    404,
  ),
);
app.onError((err, c) => {
  const known = err instanceof BusinessError;
  logError(c, err);
  const status = (known ? err.status : 500) as ContentfulStatusCode,
    message = known
      ? err.message
      : "No se pudo completar la operación. Intente nuevamente.";
  if (
    c.req.header("Content-Type")?.includes("application/json") ||
    c.req.header("Accept")?.includes("application/json")
  )
    return c.json({ error: message }, status);
  return c.html(
    layout(
      c,
      "No se pudo completar",
      card(
        `<h2>No se pudo completar</h2><p role="alert">${e(message)}</p>${link("/", "Volver")}`,
      ),
    ),
    status,
  );
});
export { app };
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: AppEnv["Bindings"],
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      cleanup(env).catch((err) => {
        log("error", "retention_cleanup_failed", {
          request_id: crypto.randomUUID(),
          route: "scheduled",
          method: "CRON",
          error_code: "CLEANUP_FAILED",
          error_type: err instanceof Error ? err.name : "Error",
        });
        throw new Error("Scheduled cleanup failed");
      }),
    );
  },
};
