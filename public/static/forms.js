(function () {
  const encoder = new TextEncoder();
  const hex = (b) =>
    Array.from(new Uint8Array(b))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
  async function derive(password, salt) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    return hex(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: encoder.encode(salt),
          iterations: 600000,
          hash: "SHA-256",
        },
        key,
        256,
      ),
    );
  }
  function error(form, message) {
    let p = form.querySelector(".form-error");
    if (!p) {
      p = document.createElement("p");
      p.className = "warning form-error";
      p.setAttribute("role", "alert");
      form.prepend(p);
    }
    p.textContent = message;
  }
  async function image(file) {
    if (file.size > 5 * 1024 * 1024) throw Error("La imagen supera 5 MB.");
    if (!["image/jpeg", "image/png"].includes(file.type))
      throw Error("Use una imagen JPEG o PNG.");
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 20000000)
      throw Error("La imagen supera 20 megapíxeles.");
    const scale = Math.min(1, 800 / bitmap.width, 800 / bitmap.height),
      canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
    if (!blob || blob.size > 512 * 1024)
      throw Error(
        "No se pudo optimizar la imagen. Elija una imagen más pequeña.",
      );
    return new File([blob], "image.jpg", { type: "image/jpeg" });
  }
  document.addEventListener("submit", async function (event) {
    const form = event.target;
    if (event.defaultPrevented || form.matches("[data-import],[data-export]"))
      return;
    const mode = form.dataset.passwordMode;
    const images = [...form.querySelectorAll("input[type=file]")].filter(
      (i) => ["photo", "image"].includes(i.name) && i.files.length,
    );
    if (!mode && !images.length) return;
    event.preventDefault();
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const data = new FormData(form);
      if (mode) {
        const password = data.get("password"),
          bytes = encoder.encode(password).length;
        if (bytes < 12 || bytes > 72)
          throw Error("La contraseña debe tener entre 12 y 72 bytes.");
        if (form.elements.confirm && data.get("confirm") !== password)
          throw Error("Las contraseñas no coinciden.");
        const salt =
          mode === "login"
            ? (
                await (
                  await fetch(
                    "/auth/password-salt?" +
                      new URLSearchParams({ username: data.get("username") }),
                  )
                ).json()
              ).salt
            : random();
        const proof = await derive(password, salt);
        data.delete("password");
        data.delete("confirm");
        data.set("passwordProof", proof);
        data.set("passwordSalt", salt);
        data.set("passwordBytes", String(bytes));
        if (form.elements.confirm) data.set("confirmProof", proof);
      }
      for (const input of images)
        data.set(input.name, await image(input.files[0]));
      const response = await fetch(form.action, { method: "POST", body: data });
      if (!response.ok) {
        const doc = new DOMParser().parseFromString(
          await response.text(),
          "text/html",
        );
        throw Error(
          doc.querySelector("[role=alert]")?.textContent ||
            "No se pudo completar la operación.",
        );
      }
      window.location.assign(response.url);
    } catch (e) {
      error(form, e.message);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      event.target.matches("input[type=search][name=q]")
    )
      event.preventDefault();
  });
  window.CJM = { derive, image, error };
})();
