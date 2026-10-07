(function () {
  let library;
  function load() {
    if (window.XLSX) return Promise.resolve();
    if (!library)
      library = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/static/xlsx.full.min.js";
        script.onload = resolve;
        script.onerror = () =>
          reject(Error("No se pudo cargar el lector de Excel."));
        document.head.append(script);
      });
    return library;
  }
  const header = (s) =>
    String(s || "")
      .trim()
      .replace(/^\uFEFF/, "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/\./g, "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ");
  function normalizeRows(rows) {
    let columns = { last: 0, first: 1, dni: 2, email: 7 },
      skipped = 0,
      values = [];
    for (const row of rows) {
      if (!row.some((v) => String(v ?? "").trim())) continue;
      const map = {};
      row.forEach((v, i) => {
        const name = header(v);
        if (["apellido", "apellidos"].includes(name)) map.last = i;
        if (["nombre", "nombres"].includes(name)) map.first = i;
        if (
          [
            "dni",
            "documento",
            "nro documento",
            "numero de documento",
            "matricula",
          ].includes(name)
        )
          map.dni = i;
        if (
          [
            "email",
            "e-mail",
            "e mail",
            "mail",
            "correo",
            "correo electronico",
          ].includes(name)
        )
          map.email = i;
      });
      if (map.first !== undefined && map.last !== undefined) {
        skipped++;
        if (map.dni !== undefined && map.email !== undefined) columns = map;
        continue;
      }
      values.push({
        apellido: String(row[columns.last] ?? ""),
        nombre: String(row[columns.first] ?? ""),
        dni: String(row[columns.dni] ?? ""),
        email: String(row[columns.email] ?? ""),
      });
    }
    return { values, skipped };
  }
  function csvText(bytes) {
    const b = new Uint8Array(bytes);
    let endian;
    if (b[0] === 255 && b[1] === 254) endian = "utf-16le";
    else if (b[0] === 254 && b[1] === 255) endian = "utf-16be";
    else {
      let odd = 0,
        even = 0,
        pairs = Math.min(Math.floor(b.length / 2), 2048);
      for (let i = 0; i < pairs * 2; i += 2) {
        if (!b[i]) even++;
        if (!b[i + 1]) odd++;
      }
      if (odd > pairs / 2 && even * 4 < odd) endian = "utf-16le";
      else if (even > pairs / 2 && odd * 4 < even) endian = "utf-16be";
    }
    if (
      (b[0] === 255 && b[1] === 254 && b[2] === 0 && b[3] === 0) ||
      (b[0] === 0 && b[1] === 0 && b[2] === 254 && b[3] === 255) ||
      (!b[1] && !b[2] && !b[3]) ||
      (!b[0] && !b[1] && !b[2])
    ) {
      const big = b[0] === 0,
        view = new DataView(bytes);
      let out = "";
      for (let i = 0; i + 3 < b.length; i += 4) {
        const point = view.getUint32(i, !big);
        if (point !== 0xfeff) out += String.fromCodePoint(point);
      }
      return out;
    }
    if (endian)
      return new TextDecoder(endian).decode(bytes).replace(/^\uFEFF/, "");
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, "");
    } catch {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("[data-import],[data-export]")) return;
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await load();
      const csrf = form.elements.csrf.value;
      if (form.matches("[data-import]")) {
        const file = form.elements.xlsx.files[0];
        if (!file || file.size > 6 * 1024 * 1024)
          throw Error("Seleccione un archivo XLSX o CSV de hasta 6 MB.");
        const bytes = await file.arrayBuffer(),
          b = new Uint8Array(bytes);
        let book;
        if (b[0] === 80 && b[1] === 75)
          book = XLSX.read(bytes, { type: "array", sheetRows: 20002 });
        else
          book = XLSX.read(csvText(bytes), {
            type: "string",
            sheetRows: 20002,
          });
        const raw = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
          header: 1,
          defval: "",
          raw: false,
        });
        if (raw.length > 20000) throw Error("El archivo supera 20.000 filas.");
        const normalized = normalizeRows(raw),
          preview = document.getElementById("import-preview");
        preview.replaceChildren();
        const summary = document.createElement("p");
        summary.textContent = `Vista previa: ${normalized.values.length} filas; ${normalized.skipped} encabezados omitidos.`;
        preview.append(summary);
        const list = document.createElement("ul");
        normalized.values.slice(0, 8).forEach((r) => {
          const li = document.createElement("li");
          li.textContent = `${r.apellido} ${r.nombre} · ${r.dni} · ${r.email}`;
          list.append(li);
        });
        preview.append(list);
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.textContent = "Confirmar importación";
        preview.append(confirm);
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          const total = { imported: 0, duplicates: 0, invalid: 0 };
          try {
            for (let i = 0; i < normalized.values.length; i += 40) {
              const response = await fetch("/admin/importar", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf,
                },
                body: JSON.stringify({
                  rows: normalized.values.slice(i, i + 40),
                }),
              });
              const result = await response.json();
              if (!response.ok) throw Error(result.error);
              for (const k of Object.keys(total)) total[k] += result[k];
              for (const err of result.errors || []) {
                const p = document.createElement("p");
                p.textContent = err;
                preview.append(p);
              }
            }
            summary.textContent = `Importadas: ${total.imported} · Duplicadas: ${total.duplicates} · Inválidas: ${total.invalid}. Recargue para ver los DNI habilitados.`;
          } catch (e) {
            CJM.error(form, e.message);
          } finally {
            confirm.disabled = false;
          }
        });
      } else {
        const values = new FormData(form),
          status = document.getElementById("export-progress"),
          all = [],
          manifest = [];
        let cursor = 0,
          headers;
        do {
          const response = await fetch(
            "/admin/exportar/datos?" +
              new URLSearchParams({
                from: values.get("from"),
                to: values.get("to"),
                cursor: String(cursor),
              }),
          );
          const result = await response.json();
          if (!response.ok) throw Error(result.error);
          headers = result.headers;
          for (const row of result.rows) all.push(row.values);
          manifest.push({
            rows: result.rows.map((r) => ({ id: r.id, version: r.version })),
            signature: result.signature,
          });
          if (all.length > 5000)
            throw Error(
              "Exporte rangos menores: máximo 5.000 registros por archivo.",
            );
          cursor = result.next;
          status.textContent = `Preparando ${all.length} registros…`;
        } while (cursor);
        const book = XLSX.utils.book_new(),
          sheet = XLSX.utils.aoa_to_sheet([headers, ...all]);
        XLSX.utils.book_append_sheet(book, sheet, "Mediaciones");
        const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" }),
          data = new FormData();
        data.set("csrf", csrf);
        data.set("from", values.get("from"));
        data.set("to", values.get("to"));
        data.set("manifest", JSON.stringify(manifest));
        data.set(
          "xlsx",
          new File([bytes], "mediaciones.xlsx", {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        );
        const response = await fetch("/admin/exportar", {
          method: "POST",
          body: data,
          headers: { Accept: "application/json" },
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        status.textContent = `Archivo guardado: ${result.count} registros, ${result.marked} versiones actuales marcadas. Las modificadas durante la exportación siguen pendientes.`;
        window.location.assign(result.download);
      }
    } catch (e) {
      CJM.error(form, e.message);
    } finally {
      button.disabled = false;
    }
  });
})();
