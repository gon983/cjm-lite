import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch(
    [
      "sessions",
      "blocked_days",
      "mediations",
      "audit_log",
      "news",
      "whitelist",
      "exports",
      "users",
      "login_attempts",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  const keys = await env.FILES.list();
  if (keys.objects.length)
    await env.FILES.delete(keys.objects.map((o) => o.key));
});
