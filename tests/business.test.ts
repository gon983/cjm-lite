import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import {
  createAdmin,
  enableDNI,
  register,
  manageUser,
  importRows,
} from "../src/services/user-service";
import {
  reserve,
  editDetails,
  cancel,
  block,
  changeState,
  cleanup,
  type Booking,
} from "../src/services/reservation-service";
import { login, loginSalt } from "../src/services/auth-service";
import { stmt, stamp, MED_SELECT } from "../src/services/database";
import { exportPage, confirmExport } from "../src/services/export-service";
import { saveNews } from "../src/services/news-service";
import { saveImage } from "../src/lib/r2";
import { randomToken, sha256, hmac, hashProof } from "../src/lib/crypto";
import {
  addDays,
  weekday,
  monthLimit,
  localNow,
  dateES,
  timestampES,
  today,
} from "../src/lib/dates";
import { SITES } from "../src/config/sites";
import { app } from "../src/index";
import type { Mediation, User } from "../src/types";
const pw = {
  passwordSalt: "a".repeat(64),
  passwordProof: "b".repeat(64),
  passwordBytes: "16",
};
const now = new Date("2026-10-07T10:00:00Z");
async function fixture() {
  const admin = await createAdmin(env, null, "Admin", "admin", pw);
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    const dni = String(32280000 + i);
    await enableDNI(env, admin, {
      dni,
      nombre: "Nombre " + i,
      apellido: "Pérez",
      email: `u${i}@example.com`,
    });
    ids.push(await register(env, dni, "3511111111", `profiles/${i}.jpg`, pw));
  }
  return { admin, ids };
}
const booking = (ids: number[]): Booking => ({
  sede: "COSQUIN",
  date: "2026-10-08",
  start: "08:30",
  m1: ids[0],
  m2: ids[1],
  title: "Carátula",
  case_number: "EXP-123",
});
async function mediation(id: number) {
  return (await stmt(env, MED_SELECT + "WHERE m.id=?", id).first<Mediation>())!;
}
async function session(id: number) {
  const token = randomToken();
  await stmt(
    env,
    "INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    await sha256(token),
    id,
    "2099-01-01T00:00:00Z",
    stamp(),
  ).run();
  return token;
}
async function req(
  path: string,
  actor: number | null,
  method = "GET",
  data?: Record<string, string>,
  json?: unknown,
) {
  const csrf = randomToken(),
    headers: Record<string, string> = {
      Cookie: `csrf=${csrf}${actor ? " ;session=" + (await session(actor)) : ""}`,
      Origin: "http://localhost:8787",
    };
  let body: string | undefined;
  if (method !== "GET") {
    headers["X-CSRF-Token"] = await hmac(env.SESSION_SECRET, csrf);
    headers["Content-Type"] = json
      ? "application/json"
      : "application/x-www-form-urlencoded";
    body = json
      ? JSON.stringify(json)
      : new URLSearchParams({
          ...data,
          csrf: headers["X-CSRF-Token"],
        }).toString();
  }
  return app.request(
    "http://localhost:8787" + path,
    { method, headers, body },
    env,
  );
}
describe("D1 reservation rules", () => {
  it("one winner for two simultaneous requests for the last room", async () => {
    const { ids } = await fixture();
    const rs = await Promise.allSettled([
      reserve(env, ids[0], booking(ids), now),
      reserve(env, ids[2], booking(ids.slice(2)), now),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await stmt(env, "SELECT count(*) AS count FROM mediations").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await stmt(
          env,
          "SELECT count(*) AS count FROM audit_log WHERE action='RESERVE'",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });
  it("simultaneous reservations cannot share either mediator in another site", async () => {
    const { ids } = await fixture();
    SITES.push({
      code: "OTHER",
      name: "Otra",
      start: "08:30",
      end: "17:30",
      slotMinutes: 90,
      rooms: 2,
    });
    try {
      const m = { ...booking([ids[2], ids[0]]), sede: "OTHER", start: "08:30" };
      const rs = await Promise.allSettled([
        reserve(env, ids[0], booking(ids), now),
        reserve(env, ids[2], m, now),
      ]);
      expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    } finally {
      SITES.pop();
    }
  });
  it("both roles, crossed assignment and overlapping intervals conflict", async () => {
    const { ids } = await fixture();
    await reserve(env, ids[0], booking(ids), now);
    SITES.push({
      code: "OTHER",
      name: "Otra",
      start: "08:30",
      end: "17:30",
      slotMinutes: 90,
      rooms: 2,
    });
    try {
      for (const pair of [
        [ids[0], ids[2]],
        [ids[2], ids[1]],
        [ids[1], ids[2]],
      ])
        await expect(
          reserve(
            env,
            pair[0],
            { ...booking(pair), sede: "OTHER", start: "08:30" },
            now,
          ),
        ).rejects.toThrow();
      await expect(
        reserve(
          env,
          ids[2],
          { ...booking(ids.slice(2)), sede: "OTHER", start: "10:00" },
          now,
        ),
      ).resolves.toBeTypeOf("number");
    } finally {
      SITES.pop();
    }
  });
  it("month boundary, weekend, elapsed slot, missing site and inactive mediators", async () => {
    const { admin, ids } = await fixture();
    for (const m of [
      { ...booking(ids), date: "2026-11-09" },
      { ...booking(ids), date: "2026-10-10" },
      { ...booking(ids), date: "2026-10-06" },
      { ...booking(ids), sede: "NO" },
      { ...booking(ids), start: "08:00" },
      { ...booking(ids), m2: ids[0] },
    ])
      await expect(reserve(env, ids[0], m, now)).rejects.toThrow();
    await manageUser(env, admin, ids[1], "toggle");
    await expect(reserve(env, ids[0], booking(ids), now)).rejects.toThrow();
    expect(monthLimit("2027-01-31")).toBe("2027-02-28");
    expect(monthLimit("2026-10-07")).toBe("2026-11-07");
    await manageUser(env, admin, ids[1], "toggle");
    await expect(
      reserve(
        env,
        ids[0],
        { ...booking(ids), date: "2026-11-09" },
        new Date("2026-10-09T10:00:00Z"),
      ),
    ).resolves.toBeTypeOf("number");
  });
  it("cancel before start frees capacity; exact start rejects; admin status does not prevent early cancellation", async () => {
    const { admin, ids } = await fixture();
    const id = await reserve(env, ids[0], booking(ids), now);
    await expect(cancel(env, ids[2], id, now)).rejects.toThrow();
    await changeState(env, admin, id, "INICIADA", "");
    await cancel(env, ids[1], id, now);
    const again = await reserve(env, ids[2], booking(ids.slice(2)), now);
    await expect(
      cancel(env, ids[2], again, new Date("2026-10-08T11:30:00Z")),
    ).rejects.toThrow();
    expect((await mediation(again)).state).toBe("RESERVADA");
  });
  it("block cancels all, prevents inserts; unblock does not restore", async () => {
    const { admin, ids } = await fixture();
    const id = await reserve(env, ids[0], booking(ids), now);
    await block(env, admin, "COSQUIN", "08/10/2026", "Feriado", false);
    expect((await mediation(id)).state).toBe("CANCELADA_POR_ADMIN");
    await expect(
      reserve(env, ids[2], booking(ids.slice(2)), now),
    ).rejects.toThrow();
    await block(env, admin, "COSQUIN", "2026-10-08", "", true);
    expect((await mediation(id)).state).toBe("CANCELADA_POR_ADMIN");
    await expect(
      reserve(env, ids[2], booking(ids.slice(2)), now),
    ).resolves.toBeTypeOf("number");
  });
  it("admin rescheduling checks conflicts atomically and data edits preserve state", async () => {
    const { admin, ids } = await fixture();
    const id = await reserve(env, ids[0], booking(ids), now);
    const id2 = await reserve(
      env,
      ids[2],
      { ...booking(ids.slice(2)), start: "10:00" },
      now,
    );
    await expect(
      editDetails(
        env,
        admin,
        id2,
        { ...booking(ids.slice(2)), start: "08:30" },
        now,
      ),
    ).rejects.toThrow();
    await expect(
      editDetails(env, ids[0], id, { ...booking(ids), title: "No" }, now),
    ).rejects.toThrow();
    await changeState(env, admin, id, "FINALIZADA", "CON_ACUERDO");
    await editDetails(
      env,
      admin,
      id,
      { ...booking(ids), title: "Corrected" },
      new Date("2026-11-15T12:00:00Z"),
    );
    expect((await mediation(id)).state).toBe("FINALIZADA");
    expect((await mediation(id)).title).toBe("Corrected");
  });
  it("only admin updates state; final and signed require result; canceled cannot resurrect", async () => {
    const { admin, ids } = await fixture();
    const id = await reserve(env, ids[0], booking(ids), now);
    await expect(
      changeState(env, ids[0], id, "INICIADA", ""),
    ).rejects.toThrow();
    await expect(
      changeState(env, admin, id, "FINALIZADA", ""),
    ).rejects.toThrow();
    await changeState(env, admin, id, "FINALIZADA", "INCOMPARECENCIA");
    await changeState(env, admin, id, "FIRMADA", "INCOMPARECENCIA");
    await block(env, admin, "COSQUIN", "2026-10-08", "", false);
    await expect(
      changeState(env, admin, id, "RESERVADA", ""),
    ).rejects.toThrow();
  });
});
describe("users, auth and permissions", () => {
  it("whitelist consumed once; invalid and duplicate DNI reject", async () => {
    const { admin } = await fixture();
    await expect(
      register(env, "9999", "phone", "profiles/x.jpg", pw),
    ).rejects.toThrow();
    await enableDNI(env, admin, {
      dni: "32.280.099",
      nombre: "Ana",
      apellido: "Perez",
      email: "ana@example.com",
    });
    const id = await register(env, "32280099", "phone", "profiles/x.jpg", pw);
    expect(
      (
        await stmt(
          env,
          "SELECT count(*) AS count FROM whitelist WHERE dni=?",
          "32280099",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    await expect(
      register(env, "32280099", "phone", "profiles/y.jpg", pw),
    ).rejects.toThrow();
    expect(id).toBeGreaterThan(0);
  });
  it("login stores hashed session, inactive rejects and reset invalidates sessions", async () => {
    const { admin, ids } = await fixture();
    const token = await login(
      env,
      "32.280.000",
      pw.passwordProof,
      undefined,
      "test-ip",
    );
    expect(
      (await stmt(env, "SELECT token FROM sessions").first<{ token: string }>())
        ?.token,
    ).toBe(await sha256(token));
    expect((await loginSalt(env, "32280000")).salt).toBe(pw.passwordSalt);
    await manageUser(env, admin, ids[0], "toggle");
    await expect(
      login(env, "32280000", pw.passwordProof, undefined, "test-ip"),
    ).rejects.toThrow();
    await manageUser(env, admin, ids[0], "toggle");
    await login(env, "32280000", pw.passwordProof, undefined, "test-ip");
    await manageUser(env, admin, ids[0], "reset", {
      ...pw,
      passwordProof: "c".repeat(64),
    });
    expect(
      (
        await stmt(
          env,
          "SELECT count(*) AS count FROM sessions WHERE user_id=?",
          ids[0],
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    await expect(
      login(env, "32280000", pw.passwordProof, undefined, "test-ip"),
    ).rejects.toThrow();
  });
  it("HTTP admin/mediator authorization and CSRF", async () => {
    const { admin, ids } = await fixture();
    expect((await req("/admin/dnis", ids[0])).status).toBe(403);
    expect((await req("/reservar", admin)).status).toBe(403);
    expect(
      (
        await app.request(
          "http://localhost:8787/admin/dnis",
          {
            method: "POST",
            body: "dni=123",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await req("/admin/dnis", admin, "POST", {
          dni: "32280088",
          first: "Ana",
          last: "Perez",
          email: "ana@example.com",
        })
      ).status,
    ).toBe(303);
    expect(
      (
        await req("/admin/importar", admin, "POST", undefined, {
          rows: [
            {
              dni: "32280089",
              nombre: "Juan",
              apellido: "Lopez",
              email: "j@example.com",
            },
          ],
        })
      ).status,
    ).toBe(200);
  });
  it("batch import validates every row, skips registered/duplicates and audits", async () => {
    const { admin, ids } = await fixture();
    await expect(importRows(env, admin, Array(41).fill({}))).rejects.toThrow();
    const result = await importRows(env, admin, [
      {
        dni: "32280088",
        nombre: "Ana",
        apellido: "Pérez",
        email: "ANA@example.com",
      },
      {
        dni: "32280088",
        nombre: "Ana",
        apellido: "Pérez",
        email: "ana@example.com",
      },
      {
        dni: "32280000",
        nombre: "Old",
        apellido: "Old",
        email: "old@example.com",
      },
      { dni: "bad", nombre: "X", apellido: "X", email: "x@example.com" },
    ]);
    expect(result).toMatchObject({ imported: 1, duplicates: 2, invalid: 1 });
    await expect(
      enableDNI(env, ids[0], {
        dni: "32280087",
        nombre: "X",
        apellido: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });
});
describe("files, exports and retention", () => {
  it("images validate real headers and dimensions; objects stored privately in R2", async () => {
    await expect(
      saveImage(
        env,
        new File(["<svg>bad</svg>"], "x.jpg", { type: "image/jpeg" }),
        "profiles",
      ),
    ).rejects.toThrow();
    const bytes = new Uint8Array(32);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const v = new DataView(bytes.buffer);
    v.setUint32(16, 1);
    v.setUint32(20, 1);
    const key = await saveImage(
      env,
      new File([bytes], "user.png", { type: "image/png" }),
      "profiles",
    );
    expect((await env.FILES.get(key))?.httpMetadata?.contentType).toBe(
      "image/png",
    );
    v.setUint32(16, 801);
    await expect(
      saveImage(env, new File([bytes], "x.png"), "news"),
    ).rejects.toThrow();
    expect((await req("/uploads/" + key, null)).status).toBe(303);
  });
  it("optional export stores the file before marks and preserves version checks", async () => {
    const { admin, ids } = await fixture();
    const id = await reserve(env, ids[0], booking(ids), now);
    await cleanup(env, new Date("2026-10-14T12:00:00Z"));
    expect(await mediation(id)).not.toBeNull();
    const dataset = await exportPage(env, admin, "08/10/2026", "08/10/2026", 0);
    expect(dataset.rows[0].values[1]).toBe("08/10/2026");
    const manifest = [
      {
        rows: dataset.rows.map((r) => ({ id: r.id, version: r.version })),
        signature: dataset.signature,
      },
    ];
    await expect(
      confirmExport(
        env,
        admin,
        "2026-10-08",
        "2026-10-08",
        manifest,
        new File(["bad"], "bad.xlsx"),
      ),
    ).rejects.toThrow();
    expect((await mediation(id)).exported_at).toBeNull();
    const bytes = new Uint8Array(120);
    bytes.set([80, 75, 3, 4]);
    const file = new File([bytes], "valid.xlsx");
    const exp = await confirmExport(
      env,
      admin,
      "2026-10-08",
      "2026-10-08",
      manifest,
      file,
    );
    expect(await env.FILES.get(exp.key)).not.toBeNull();
    expect((await mediation(id)).exported_at).not.toBeNull();
    await editDetails(
      env,
      admin,
      id,
      { ...booking(ids), title: "Changed" },
      now,
    );
    expect((await mediation(id)).exported_at).toBeNull();
    const stale = await confirmExport(
      env,
      admin,
      "2026-10-08",
      "2026-10-08",
      manifest,
      file,
    );
    expect(stale.marked).toBe(0);
    await cleanup(env, new Date("2026-10-14T12:00:00Z"));
    expect(await mediation(id)).not.toBeNull();
    const fresh = await exportPage(env, admin, "2026-10-08", "2026-10-08", 0);
    await confirmExport(
      env,
      admin,
      "2026-10-08",
      "2026-10-08",
      [
        {
          rows: fresh.rows.map((r) => ({ id: r.id, version: r.version })),
          signature: fresh.signature,
        },
      ],
      file,
    );
    await cleanup(env, new Date("2026-10-30T12:00:00Z"));
    expect(await mediation(id)).toBeNull();
  });
  it("news CRUD/publication and XSS escape; HTMX returns fragment only", async () => {
    const { admin, ids } = await fixture();
    await saveNews(
      env,
      admin,
      {
        title: "<script>alert(1)</script>",
        content: "News",
        date: today(),
        published: "1",
      },
      "",
    );
    const response = await req("/", ids[0]);
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    const token = await session(ids[0]);
    const fragment = await app.request(
      "http://localhost:8787/mediadores/buscar?q=perez",
      { headers: { Cookie: "session=" + token, "HX-Request": "true" } },
      env,
    );
    const text = await fragment.text();
    expect(text).toContain('id="mediator-picker"');
    expect(text).not.toContain("<html");
    const row = await stmt(env, "SELECT id FROM news").first<{ id: number }>();
    await saveNews(env, admin, { action: "delete", id: String(row!.id) }, "");
    expect(
      (
        await stmt(env, "SELECT count(*) AS count FROM news").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });
});

describe("atomicity and HTTP races", () => {
  it("two simultaneous HTTP reservations yield one redirect and one conflict", async () => {
    const { ids } = await fixture();
    let day = addDays(today(), 1);
    while ([0, 6].includes(weekday(day))) day = addDays(day, 1);
    const payload = (m2: number) => ({
      sede: "COSQUIN",
      date: dateES(day),
      start: "08:30",
      m2: String(m2),
      title: "HTTP race",
      case: "EXP-RACE",
    });
    const rs = await Promise.all([
      req("/reservar", ids[0], "POST", payload(ids[1])),
      req("/reservar", ids[2], "POST", payload(ids[3])),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([303, 409]);
    expect(
      (
        await stmt(env, "SELECT count(*) AS count FROM mediations").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(1);
  });
  it("audit failure rolls the reservation back", async () => {
    const { ids } = await fixture();
    await env.DB.exec(
      "CREATE TRIGGER fail_reserve_audit BEFORE INSERT ON audit_log WHEN NEW.action='RESERVE' BEGIN SELECT RAISE(ABORT,'audit intentionally rejected'); END",
    );
    try {
      await expect(reserve(env, ids[0], booking(ids), now)).rejects.toThrow();
      expect(
        (
          await stmt(env, "SELECT count(*) AS count FROM mediations").first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_reserve_audit");
    }
  });
  it("two admin moves to the same last cup remain atomic", async () => {
    const { admin, ids } = await fixture();
    const first = await reserve(env, ids[0], booking(ids), now),
      second = await reserve(
        env,
        ids[2],
        { ...booking(ids.slice(2)), start: "10:00" },
        now,
      );
    const rs = await Promise.allSettled([
      editDetails(env, admin, first, { ...booking(ids), start: "14:30" }, now),
      editDetails(
        env,
        admin,
        second,
        { ...booking(ids.slice(2)), start: "14:30" },
        now,
      ),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await stmt(
          env,
          "SELECT count(*) AS count FROM mediations WHERE start='14:30'",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });
  it("self deactivation invalidates sessions and last admin cannot deactivate", async () => {
    const { admin } = await fixture();
    await expect(manageUser(env, admin, admin, "toggle")).rejects.toThrow();
    const another = await createAdmin(env, admin, "Other", "other-admin", pw);
    await session(admin);
    await manageUser(env, admin, admin, "toggle");
    expect(
      (
        await stmt(
          env,
          "SELECT count(*) AS count FROM sessions WHERE user_id=?",
          admin,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    await manageUser(env, another, admin, "toggle");
    expect(
      (
        await stmt(
          env,
          "SELECT count(*) AS count FROM sessions WHERE user_id=?",
          admin,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });
  it("tampered export proof cannot mark or save anything", async () => {
    const { admin, ids } = await fixture();
    const id = await reserve(env, ids[0], booking(ids), now);
    const dataset = await exportPage(env, admin, "2026-10-08", "2026-10-08", 0);
    const bytes = new Uint8Array(120);
    bytes.set([80, 75, 3, 4]);
    await expect(
      confirmExport(
        env,
        admin,
        "2026-10-08",
        "2026-10-08",
        [{ rows: [{ id, version: 99 }], signature: dataset.signature }],
        new File([bytes], "x.xlsx"),
      ),
    ).rejects.toThrow();
    expect((await mediation(id)).exported_at).toBeNull();
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });
});

it("administrators remain searchable by display name independently of username", async () => {
  const { admin } = await fixture();
  await createAdmin(env, admin, "Juana Pérez", "office-account", pw);
  const response = await req("/admin/usuarios?role=ADMIN&q=juana", admin);
  expect(await response.text()).toContain("Juana Pérez");
});

it("preserves durable export objects after ambiguous D1 transport failure", async () => {
  const { admin, ids } = await fixture();
  await reserve(env, ids[0], booking(ids), now);
  const dataset = await exportPage(env, admin, "2026-10-08", "2026-10-08", 0);
  const bytes = new Uint8Array(120);
  bytes.set([80, 75, 3, 4]);
  const manifest = [
    {
      rows: dataset.rows.map((r) => ({ id: r.id, version: r.version })),
      signature: dataset.signature,
    },
  ];
  const failure = vi
    .spyOn(env.DB, "batch")
    .mockRejectedValueOnce(new Error("ambiguous transport failure"));
  try {
    await expect(
      confirmExport(
        env,
        admin,
        "2026-10-08",
        "2026-10-08",
        manifest,
        new File([bytes], "x.xlsx"),
      ),
    ).rejects.toThrow("ambiguous");
    expect((await env.FILES.list()).objects).toHaveLength(1);
  } finally {
    failure.mockRestore();
  }
});
