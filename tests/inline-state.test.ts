import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { createAdmin, enableDNI, register } from "../src/services/user-service";
import { reserve } from "../src/services/reservation-service";
import { app } from "../src/index";
import { stmt, stamp } from "../src/services/database";
import { randomToken, sha256, hmac } from "../src/lib/crypto";
const pw = {
  passwordSalt: "a".repeat(64),
  passwordProof: "b".repeat(64),
  passwordBytes: "16",
};
it("daily table edits state inline, enforces result and preserves mediation details", async () => {
  const admin = await createAdmin(env, null, "Admin", "admin", pw);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const dni = String(32285000 + i);
    await enableDNI(env, admin, {
      dni,
      nombre: "Nombre",
      apellido: "Apellido",
      email: "user@example.com",
    });
    ids.push(await register(env, dni, "123", "profiles/x.jpg", pw));
  }
  const id = await reserve(
    env,
    ids[0],
    {
      sede: "COSQUIN",
      date: "2026-10-08",
      start: "08:30",
      m1: ids[0],
      m2: ids[1],
      title: "Case",
      case_number: "123",
    },
    new Date("2026-10-07T10:00:00Z"),
  );
  const token = randomToken(),
    csrf = randomToken();
  await stmt(
    env,
    "INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    await sha256(token),
    admin,
    "2099-01-01T00:00:00Z",
    stamp(),
  ).run();
  const cookie = `session=${token}; csrf=${csrf}`;
  const page = await app.request(
    "http://localhost:8787/admin/mediaciones?date=2026-10-08",
    { headers: { Cookie: cookie } },
    env,
  );
  const html = await page.text();
  expect(html).toContain("data-inline-state");
  expect(html).toContain('name="state"');
  expect(html).not.toContain('href="/admin/estado');
  const post = async (state: string, result: string) =>
    app.request(
      "http://localhost:8787/admin/estado",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "http://localhost:8787",
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          csrf: await hmac(env.SESSION_SECRET, csrf),
          id: String(id),
          inline: "1",
          state,
          result,
        }).toString(),
      },
      env,
    );
  expect((await post("FINALIZADA", "")).status).toBe(400);
  const response = await post("FINALIZADA", "CON_ACUERDO");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    state: "FINALIZADA",
    result: "CON_ACUERDO",
  });
  expect(
    await stmt(
      env,
      "SELECT state,result,title,case_number FROM mediations WHERE id=?",
      id,
    ).first(),
  ).toMatchObject({
    state: "FINALIZADA",
    result: "CON_ACUERDO",
    title: "Case",
    case_number: "123",
  });
});
