const { chromium } = require("playwright");
const fs = require("fs");
const { randomBytes, webcrypto } = require("crypto");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.CJM_SMOKE_URL || "http://localhost:8790";
(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/healthz")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const password = randomBytes(20).toString("base64url"),
    salt = randomBytes(32).toString("hex"),
    key = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
  const proof = Buffer.from(
    await webcrypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(salt),
        iterations: 600000,
      },
      key,
      256,
    ),
  ).toString("hex");
  const env = Object.fromEntries(
    fs
      .readFileSync(path.join(ROOT, ".dev.vars"), "utf8")
      .trim()
      .split("\n")
      .map((x) => x.split("=")),
  );
  const boot = await fetch(BASE + "/bootstrap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bootstrap-Secret": env.BOOTSTRAP_SECRET,
    },
    body: JSON.stringify({
      name: "Smoke Admin",
      username: "smoke-admin",
      passwordSalt: salt,
      passwordProof: proof,
      passwordBytes: String(password.length),
    }),
  });
  if (boot.status !== 201)
    throw Error("bootstrap " + boot.status + " " + (await boot.text()));
  const systemChrome =
    process.env.CJM_CHROME_PATH ||
    (fs.existsSync("/usr/bin/google-chrome")
      ? "/usr/bin/google-chrome"
      : undefined);
  const browser = await chromium.launch({
    executablePath: systemChrome,
    headless: true,
    args: process.env.CJM_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const admin = await ctx.newPage();
  admin.on("pageerror", (e) => errors.push(e.message));
  await admin.goto(BASE + "/login");
  await admin.locator("[name=username]").fill("smoke-admin");
  await admin.locator("[name=password]").fill(password);
  await admin.getByRole("button", { name: "Ingresar", exact: true }).click();
  await admin.waitForURL(BASE + "/");
  await admin
    .getByRole("heading", { name: "Dashboard", exact: true })
    .waitFor();
  for (const [dni, first, last] of [
    ["32281234", "María", "Pérez"],
    ["32285678", "Juan", "García"],
  ]) {
    await admin.goto(BASE + "/admin/dnis");
    await admin.locator("[name=dni]").fill(dni);
    await admin.locator("[name=first]").fill(first);
    await admin.locator("[name=last]").fill(last);
    await admin.locator("[name=email]").fill(dni + "@example.com");
    await admin
      .getByRole("button", { name: "Habilitar DNI", exact: true })
      .click();
    await admin
      .getByText("DNI habilitado. El mediador ya puede registrarse.")
      .waitFor();
  }
  const buffer = Buffer.from(
    "Apellido;Nombre;DNI;Email\nCSV;Persona;32289999;csv@example.com\nApellido;Nombre;DNI;Email\n",
  );
  await admin
    .locator("[name=xlsx]")
    .setInputFiles({ name: "csv-renamed.xlsx", mimeType: "text/csv", buffer });
  await admin.getByRole("button", { name: "Preparar importación" }).click();
  await admin.getByRole("button", { name: "Confirmar importación" }).waitFor();
  await admin.getByRole("button", { name: "Confirmar importación" }).click();
  await admin.getByText(/Importadas: 1/).waitFor();
  for (const [name, buffer] of [
    [
      "utf16-no-bom.csv",
      Buffer.from(
        "Apellido\tNombre\tD.N.I.\tEmail\r\nUTF16\tMaría\t32289777\tunicode@example.com\r\n",
        "utf16le",
      ),
    ],
    [
      "windows1252.csv",
      Buffer.from(
        "Apellido;Nombre;DNI;Email\nPérez;Ana;32289666;latin@example.com\n",
        "latin1",
      ),
    ],
  ]) {
    await admin.goto(BASE + "/admin/dnis");
    await admin
      .locator("[name=xlsx]")
      .setInputFiles({ name, mimeType: "text/csv", buffer });
    await admin.getByRole("button", { name: "Preparar importación" }).click();
    await admin.getByRole("button", { name: "Confirmar importación" }).click();
    await admin.getByText(/Importadas: 1/).waitFor();
  }
  const box = { console, Uint8Array, ArrayBuffer, TextDecoder, TextEncoder };
  vm.createContext(box);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "public/static/xlsx.full.min.js"), "utf8"),
    box,
  );
  const XLSX = box.XLSX;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Apellido", "Nombre", "DNI", "Email"],
      ["Excel", "Persona", "32289888", "xlsx@example.com"],
    ]),
    "Mediadores",
  );
  const xlsx = Buffer.from(
    XLSX.write(workbook, { type: "array", bookType: "xlsx" }),
  );
  await admin.goto(BASE + "/admin/dnis");
  await admin.locator("[name=xlsx]").setInputFiles({
    name: "original.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: xlsx,
  });
  await admin.getByRole("button", { name: "Preparar importación" }).click();
  await admin.getByRole("button", { name: "Confirmar importación" }).click();
  await admin.getByText(/Importadas: 1/).waitFor();
  // Browser-created PNG: real, compressible 1200x600 image exercises the new client-side optimizer.
  const png = await admin.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 600;
    const c = canvas.getContext("2d");
    c.fillStyle = "#155867";
    c.fillRect(0, 0, 1200, 600);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const photo = Buffer.from(png, "base64"),
    mediators = [];
  for (const dni of ["32281234", "32285678"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE + "/registro?dni=" + dni);
    await p.locator("[name=phone]").fill("3511234567");
    await p.locator("[name=password]").fill(password);
    await p.locator("[name=confirm]").fill(password);
    await p.locator("[name=photo]").setInputFiles({
      name: "photo.png",
      mimeType: "image/png",
      buffer: photo,
    });
    await p.getByRole("button", { name: "Completar registro" }).click();
    await p.waitForURL(/\/login/);
    await p.locator("[name=username]").fill(dni);
    await p.locator("[name=password]").fill(password);
    await p.getByRole("button", { name: "Ingresar", exact: true }).click();
    await p.waitForURL(BASE + "/");
    mediators.push(p);
  }
  const [first, second] = mediators;
  await first.goto(BASE + "/mi-perfil");
  if (await first.locator("[name=dni]").isEditable())
    throw Error("DNI editable");
  await first.locator("[name=nombre]").fill("María Sol");
  await first.locator("[name=email]").fill("profile@example.com");
  await first.locator("[name=telefono]").fill("3519876543");
  await first.locator("[name=photo]").setInputFiles({
    name: "updated.png",
    mimeType: "image/png",
    buffer: photo,
  });
  await first.getByRole("button", { name: "Guardar mis datos" }).click();
  await first.waitForURL(/mensaje=Datos/);
  if ((await first.locator("[name=nombre]").inputValue()) !== "María Sol")
    throw Error("Profile edit failed");

  await first.goto(BASE + "/calendario");
  if (
    !(await first.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ))
  )
    throw Error("mobile overflow");
  const slot = await first
    .locator("a.slot.available")
    .first()
    .getAttribute("href");
  const day = new URL(slot, BASE).searchParams.get("fecha");
  await first.goto(BASE + slot);
  await first.locator("[data-mediator-search]").fill("garcia juan");
  await first
    .getByRole("option", { name: "García Juan · 32285678", exact: true })
    .click();
  await first.locator("[name=title]").fill("Smoke Cloudflare");
  await first.locator("[name=case]").fill("EXP-CF-123");
  await first.getByRole("button", { name: "Confirmar reserva" }).click();
  await first.waitForURL(/mis-mediaciones/);
  await second.goto(BASE + "/mis-mediaciones");
  await second.getByText("Smoke Cloudflare").waitFor();
  if ((await first.request.get(BASE + "/admin/dnis")).status() !== 403)
    throw Error("role bypass");
  await admin.goto(BASE + "/admin/mediaciones?date=" + day);
  await admin
    .getByRole("link", { name: "Editar", exact: true })
    .first()
    .click();
  if (await admin.locator("[name=state]").count())
    throw Error("combined edit/state");
  await admin
    .locator('[data-mediator-widget="m1"] [data-mediator-search]')
    .fill("32.281.234");
  await admin
    .getByRole("option", { name: "Pérez María Sol · 32281234", exact: true })
    .click();
  await admin
    .locator('[data-mediator-widget="m2"] [data-mediator-search]')
    .fill("garcia juan");
  await admin
    .getByRole("option", { name: "García Juan · 32285678", exact: true })
    .click();
  await admin.locator("[name=title]").fill("Corrected Cloudflare");
  await admin.getByRole("button", { name: "Guardar cambios" }).click();
  await admin.goto(BASE + "/admin/mediaciones?date=" + day);
  const rowState = admin.locator("[data-inline-state]").first();
  await rowState.locator("[name=state]").selectOption("FINALIZADA");
  await rowState.locator("[name=result]").selectOption("CON_ACUERDO");
  await rowState.getByText("Estado actualizado.").waitFor();
  if (!admin.url().includes("/admin/mediaciones"))
    throw Error("Inline state navigated away");
  await admin.goto(BASE + "/admin/exportaciones");
  await admin.locator("[name=from]").fill(day.split("-").reverse().join("/"));
  await admin.locator("[name=to]").fill(day.split("-").reverse().join("/"));
  const download = admin.waitForEvent("download");
  await admin.getByRole("button", { name: "Exportar mediaciones" }).click();
  const file = await download;
  const downloadedPath = await file.path();
  const exported = XLSX.read(fs.readFileSync(downloadedPath), {
    type: "buffer",
  });
  const exportedRows = XLSX.utils.sheet_to_json(
    exported.Sheets[exported.SheetNames[0]],
    { header: 1 },
  );
  if (!exportedRows.flat().includes("Corrected Cloudflare"))
    throw Error("empty XLSX export");
  await admin.goto(BASE + "/admin/noticias");
  await admin.locator("[name=title]").fill("Noticia Cloudflare");
  await admin
    .locator("[name=content]")
    .fill("Texto seguro <script>alert(1)</script>");
  await admin
    .locator("[name=image]")
    .setInputFiles({ name: "news.png", mimeType: "image/png", buffer: photo });
  await admin.locator("[name=published]").check();
  await admin.getByRole("button", { name: "Guardar noticia" }).click();
  await admin.waitForURL(/mensaje=/);
  await first.goto(BASE + "/");
  await first.getByText("Noticia Cloudflare").waitFor();
  const image = first.locator(".news-image");
  await image.waitFor();
  if (!(await image.evaluate((i) => i.complete && i.naturalWidth === 800)))
    throw Error("R2 image/optimization failed");
  await admin.goto(BASE + "/admin/bloqueos");
  await admin.locator("[name=date]").fill(day.split("-").reverse().join("/"));
  await admin.locator("[name=reason]").fill("Smoke closure");
  admin.once("dialog", (d) => d.accept());
  await admin
    .getByRole("button", { name: "Bloquear día", exact: true })
    .click();
  await first.goto(BASE + "/mis-mediaciones");
  await first.getByText("CANCELADA_POR_ADMIN").waitFor();
  await admin.goto(BASE + "/admin/bloqueos");
  await admin
    .getByRole("button", { name: "Desbloquear sin restaurar reservas" })
    .first()
    .click();
  await first.reload();
  await first.getByText("CANCELADA_POR_ADMIN").waitFor();
  for (const url of [
    "/admin/usuarios",
    "/admin/usuarios?role=ADMIN",
    "/admin/dnis",
    "/admin/exportaciones",
    "/admin/noticias",
  ]) {
    const response = await admin.goto(BASE + url);
    if (response.status() !== 200)
      throw Error("page " + url + " " + response.status());
  }
  await first.goto(BASE + "/calendario");
  await first.screenshot({
    path: path.join(
      process.env.CJM_SMOKE_OUTPUT || require("os").tmpdir(),
      "cloudflare-mobile.png",
    ),
  });
  await admin.goto(BASE + "/");
  await admin.screenshot({
    path: path.join(
      process.env.CJM_SMOKE_OUTPUT || require("os").tmpdir(),
      "cloudflare-admin.png",
    ),
    fullPage: true,
  });
  if (errors.length) throw Error("Browser errors " + errors.join(";"));
  console.log(
    "Cloudflare browser smoke OK: PBKDF2 login, manual DNI, CSV/XLSX preview, profile R2, live search, reservation shared, admin edit/state, durable XLSX download, news/R2, block/unblock, mobile and roles.",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
