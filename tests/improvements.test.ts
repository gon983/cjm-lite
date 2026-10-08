import { env } from "cloudflare:test";
import { it, expect, vi } from "vitest";
import { app } from "../src/index";
import {
  createAdmin,
  enableDNI,
  register,
  updateProfile,
} from "../src/services/user-service";
import { reserve, cleanup } from "../src/services/reservation-service";
import {
  stmt,
  USER_COLUMNS,
  stamp,
  MED_SELECT,
} from "../src/services/database";
import { sha256, randomToken, hmac } from "../src/lib/crypto";
import { log, logError } from "../src/lib/logging";
import type { User, Ctx, Mediation } from "../src/types";
const pw = {
  passwordSalt: "a".repeat(64),
  passwordProof: "b".repeat(64),
  passwordBytes: "16",
};
async function fixture() {
  const admin = await createAdmin(env, null, "Admin", "admin", pw);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const dni = String(32280055 + i);
    await enableDNI(env, admin, {
      dni,
      nombre: i ? "Juan" : "María",
      apellido: i ? "García" : "Pérez",
      email: `u${i}@example.com`,
    });
    ids.push(
      await register(env, dni, "3511111111", "profiles/test" + i + ".jpg", pw),
    );
  }
  return { admin, ids };
}
async function request(
  path: string,
  actor: number,
  method = "GET",
  data: Record<string, string> = {},
) {
  const token = randomToken(),
    csrf = randomToken();
  await stmt(
    env,
    "INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    await sha256(token),
    actor,
    "2099-01-01T00:00:00Z",
    stamp(),
  ).run();
  const headers = {
    Cookie: `session=${token}; csrf=${csrf}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "http://localhost:8787",
  };
  return app.request(
    "http://localhost:8787" + path,
    {
      method,
      headers,
      ...(method === "POST"
        ? {
            body: new URLSearchParams({
              ...data,
              csrf: await hmac(env.SESSION_SECRET, csrf),
            }).toString(),
          }
        : {}),
    },
    env,
  );
}
it("mediator edits own contact/photo, never DNI/role/another account; search updates", async () => {
  const { admin, ids } = await fixture();
  const before = await stmt(
    env,
    "SELECT password FROM users WHERE id=?",
    ids[0],
  ).first<{ password: string }>();
  const r = await request("/mi-perfil", ids[0], "POST", {
    id: String(ids[1]),
    dni: "1234",
    role: "ADMIN",
    active: "0",
    nombre: "María Sol",
    apellido: "Pérez López",
    email: "NUEVO@example.com",
    telefono: "3512222222",
    password: "ignore",
  });
  expect(r.status).toBe(303);
  const user = await stmt(
    env,
    `SELECT ${USER_COLUMNS},password FROM users WHERE id=?`,
    ids[0],
  ).first<User>();
  expect(user).toMatchObject({
    dni: "32280055",
    role: "MEDIADOR",
    active: 1,
    nombre: "María Sol",
    apellido: "Pérez López",
    email: "nuevo@example.com",
    telefono: "3512222222",
    password: before?.password,
  });
  expect(
    (
      await stmt(env, "SELECT nombre FROM users WHERE id=?", ids[1]).first<{
        nombre: string;
      }>()
    )?.nombre,
  ).toBe("Juan");
  await updateProfile(
    env,
    ids[0],
    {
      nombre: "María Sol",
      apellido: "Pérez López",
      email: "nuevo@example.com",
      telefono: "3512222222",
    },
    "profiles/new.jpg",
  );
  expect(
    (
      await stmt(env, "SELECT photo FROM users WHERE id=?", ids[0]).first<{
        photo: string;
      }>()
    )?.photo,
  ).toBe("profiles/new.jpg");
  expect((await request("/mi-perfil", admin)).status).toBe(403);
  const search = await request(
    "/mediadores/buscar?field=m1&q_m1=lopez+maria",
    admin,
  );
  expect(await search.text()).toContain("Pérez López María Sol");
});
it("profile invalid inputs/inactive role cannot write", async () => {
  const { ids } = await fixture();
  await expect(
    updateProfile(env, ids[0], {
      nombre: "María",
      apellido: "Perez",
      email: "invalid",
      telefono: "111",
    }),
  ).rejects.toThrow();
  await stmt(env, "UPDATE users SET active=0 WHERE id=?", ids[0]).run();
  await expect(
    updateProfile(env, ids[0], {
      nombre: "Other",
      apellido: "Perez",
      email: "ok@example.com",
      telefono: "111",
    }),
  ).rejects.toThrow();
});
it("live search supports accented text, partial/formatted DNI and both admin fields", async () => {
  const { admin, ids } = await fixture();
  for (const path of [
    "/mediadores/buscar?field=m1&q_m1=garcia+juan",
    "/mediadores/buscar?field=m2&q_m2=32.280.056",
    "/mediadores/buscar?field=m2&q_m2=32+280+056",
  ]) {
    const r = await request(path, admin);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("García Juan");
  }
  expect(
    (await request("/mediadores/buscar?field=m1&q_m1=perez", ids[0])).status,
  ).toBe(403);
  const own = await request("/mediadores/buscar?q=32280055", ids[0]);
  expect(await own.text()).toContain("No se encontraron");
});
it("seven-day retention deletes unexported records at boundary but preserves six-day/future records", async () => {
  const { ids } = await fixture();
  const base = {
    sede: "COSQUIN",
    date: "2026-10-08",
    start: "08:30",
    m1: ids[0],
    m2: ids[1],
    title: "Test",
    case_number: "123",
  };
  const old = await reserve(
    env,
    ids[0],
    base,
    new Date("2026-10-07T10:00:00Z"),
  );
  await reserve(
    env,
    ids[0],
    { ...base, date: "2026-10-09" },
    new Date("2026-10-07T10:00:00Z"),
  );
  await reserve(
    env,
    ids[0],
    { ...base, date: "2026-10-20" },
    new Date("2026-10-07T10:00:00Z"),
  );
  await cleanup(env, new Date("2026-10-15T12:00:00Z"));
  expect(
    await stmt(env, MED_SELECT + "WHERE m.id=?", old).first<Mediation>(),
  ).toBeNull();
  expect(
    (
      await stmt(env, "SELECT count(*) AS count FROM mediations").first<{
        count: number;
      }>()
    )?.count,
  ).toBe(2);
  expect(
    (
      await stmt(
        env,
        "SELECT count(*) AS count FROM audit_log WHERE action='RESERVE'",
      ).first<{ count: number }>()
    )?.count,
  ).toBe(3);
});
it("audit UI removed while functional audit remains transactionally stored", async () => {
  const { admin, ids } = await fixture();
  const r = await request("/admin/auditoria", admin);
  expect(r.status).toBe(404);
  const home = await request("/", admin);
  expect(await home.text()).not.toContain('href="/admin/auditoria"');
  expect(
    (await stmt(env, "SELECT count(*) AS count FROM audit_log").first<{
      count: number;
    }>())!.count,
  ).toBeGreaterThan(0);
});
it("technical logger only emits allowlisted structured fields and no sensitive error payload", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  log("info", "test", {
    user_id: 1,
    role: "ADMIN",
    password: "secret",
    csrf: "token",
    email: "a@example.com",
  } as never);
  expect(spy.mock.calls[0][0]).toMatchObject({
    level: "info",
    event: "test",
    user_id: 1,
    role: "ADMIN",
  });
  expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  expect(JSON.stringify(spy.mock.calls)).not.toContain("token");
  spy.mockRestore();
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = {
    req: { path: "/healthz", method: "GET" },
    get: (key: string) =>
      ({ requestId: "request-test", startedAt: Date.now(), user: null })[
        key as "user"
      ],
  } as unknown as Ctx;
  logError(
    ctx,
    new Error(
      "D1_ERROR password=secret email=private@example.com cookie=token hash=" +
        "a".repeat(64),
    ),
  );
  const serialized = JSON.stringify(errSpy.mock.calls);
  expect(serialized).toContain("D1_ERROR");
  expect(serialized).toContain("D1 operation failed");
  for (const value of [
    "secret",
    "private@example.com",
    "cookie=token",
    "a".repeat(64),
  ])
    expect(serialized).not.toContain(value);
  errSpy.mockRestore();
});
it("successful GET/HTMX is silent, useful mutation logged with actor/entity/request metadata", async () => {
  const { ids } = await fixture();
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  await request("/calendario", ids[0]);
  await request("/mediadores/buscar?q=garcia", ids[0]);
  expect(info).not.toHaveBeenCalled();
  await request("/mi-perfil", ids[0], "POST", {
    nombre: "María",
    apellido: "Pérez",
    email: "contact@example.com",
    telefono: "3511234567",
  });
  expect(info.mock.calls[0][0]).toMatchObject({
    level: "info",
    event: "profile_updated",
    route: "/mi-perfil",
    method: "POST",
    user_id: ids[0],
    role: "MEDIADOR",
    entity: "users",
    entity_id: ids[0],
  });
  expect(info.mock.calls[0][0]).toHaveProperty("request_id");
  expect(info.mock.calls[0][0]).toHaveProperty("duration_ms");
  expect(JSON.stringify(info.mock.calls)).not.toContain("contact@example.com");
  info.mockRestore();
});
it("unexpected backend failure logs safe technical detail and shows no stack/password to user", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const db = vi.spyOn(env.DB, "prepare").mockImplementationOnce(() => {
    throw new Error("D1_ERROR no such table: users password=supersecret");
  });
  try {
    const response = await app.request(
      "http://localhost:8787/healthz",
      {},
      env,
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("supersecret");
    expect(body).not.toContain("D1_ERROR");
    expect(spy.mock.calls[0][0]).toMatchObject({
      level: "error",
      event: "unexpected_failure",
      error_code: "D1_ERROR",
      technical_detail: "Missing database table: users",
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("supersecret");
  } finally {
    db.mockRestore();
    spy.mockRestore();
  }
});
