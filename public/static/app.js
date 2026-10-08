document.addEventListener("submit", function (event) {
  const message = event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});
document.addEventListener("change", function (event) {
  if (event.target.name !== "state") return;
  const result = event.target.form.querySelector('[name="result"]');
  if (
    result &&
    (event.target.value === "RESERVADA" || event.target.value === "INICIADA")
  )
    result.value = "";
});
(function () {
  function initialize(root = document) {
    root.querySelectorAll("[data-mediator-widget]").forEach((w) => {
      w.querySelector("[data-mediator-value]").disabled = false;
      w.querySelector("[data-mediator-search]").required = true;
    });
  }
  function close(w) {
    const list = w.querySelector("[data-mediator-results]");
    if (list) list.hidden = true;
    w.querySelector("[data-mediator-search]").setAttribute(
      "aria-expanded",
      "false",
    );
  }
  function choose(button) {
    const w = button.closest("[data-mediator-widget]"),
      input = w.querySelector("[data-mediator-search]");
    w.querySelector("[data-mediator-value]").value =
      button.dataset.mediatorSelect;
    input.value = button.dataset.mediatorLabel;
    input.dataset.selected = button.dataset.mediatorSelect;
    input.setCustomValidity("");
    if (window.htmx) htmx.trigger(input, "htmx:abort");
    close(w);
    input.focus();
  }
  document.addEventListener("DOMContentLoaded", () => initialize());
  document.addEventListener("input", (event) => {
    if (!event.target.matches("[data-mediator-search]")) return;
    const input = event.target,
      w = input.closest("[data-mediator-widget]");
    w.querySelector("[data-mediator-value]").value = "";
    input.dataset.selected = "";
    input.setCustomValidity("Elegí un mediador de los resultados de búsqueda.");
    close(w);
  });
  document.addEventListener("click", (event) => {
    const option = event.target.closest("[data-mediator-select]");
    if (option) {
      choose(option);
      return;
    }
    document.querySelectorAll("[data-mediator-widget]").forEach((w) => {
      if (!w.contains(event.target)) close(w);
    });
  });
  document.addEventListener("htmx:configRequest", (event) => {
    const w = event.target.closest("[data-mediator-widget]");
    if (!w) return;
    const other = w.dataset.mediatorWidget === "m1" ? "m2" : "m1";
    event.detail.parameters.exclude =
      w
        .closest("form")
        .querySelector('[data-mediator-value][name="' + other + '"]')?.value ||
      "";
  });
  document.addEventListener("htmx:afterSwap", (event) => {
    const w = event.target.closest("[data-mediator-widget]");
    if (!w) return;
    initialize();
    const input = w.querySelector("[data-mediator-search]"),
      list = w.querySelector("[data-mediator-results]");
    list.hidden = !!w.querySelector("[data-mediator-value]").value;
    input.setAttribute("aria-expanded", String(!list.hidden));
    w.dataset.activeIndex = "-1";
  });
  document.addEventListener("keydown", (event) => {
    if (!event.target.matches("[data-mediator-search]")) return;
    const w = event.target.closest("[data-mediator-widget]"),
      list = w.querySelector("[data-mediator-results]");
    const options = [...list.querySelectorAll("[data-mediator-select]")];
    if (event.key === "Escape") {
      close(w);
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
      event.preventDefault();
      list.hidden = false;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const index =
        (Number(w.dataset.activeIndex || -1) + delta + options.length) %
        options.length;
      w.dataset.activeIndex = String(index);
      options.forEach((o, i) => o.classList.toggle("is-active", i === index));
      options[index].scrollIntoView({ block: "nearest" });
      event.target.setAttribute("aria-expanded", "true");
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const index = Number(w.dataset.activeIndex ?? -1);
      if (!list.hidden && options[index]) choose(options[index]);
    }
  });
  document.addEventListener("submit", (event) => {
    event.target.querySelectorAll("[data-mediator-widget]").forEach((w) => {
      if (!w.querySelector("[data-mediator-value]").value) {
        event.preventDefault();
        const input = w.querySelector("[data-mediator-search]");
        input.setCustomValidity(
          "Elegí un mediador de los resultados de búsqueda.",
        );
        input.reportValidity();
      }
    });
  });
})();
(function () {
  function sync(form) {
    const state = form.elements.state.value,
      needs = ["FINALIZADA", "FIRMADA"].includes(state);
    form.querySelector("[data-state-result]").hidden = !needs;
    form.elements.result.required = needs;
    if (!needs) form.elements.result.value = "";
    return needs;
  }
  async function save(form) {
    if (form.dataset.saving === "true") return;
    const needs = sync(form),
      status = form.querySelector(".inline-state-status");
    if (needs && !form.elements.result.value) {
      status.textContent = "Seleccioná el resultado para guardar.";
      return;
    }
    form.dataset.saving = "true";
    const data = new FormData(form);
    form.querySelectorAll("select").forEach((s) => (s.disabled = true));
    status.textContent = "Guardando…";
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "No se pudo cambiar el estado.");
      form.dataset.savedState = result.state;
      form.dataset.savedResult = result.result;
      status.textContent = "Estado actualizado.";
      if (
        (form.dataset.filterState &&
          form.dataset.filterState !== result.state) ||
        (form.dataset.filterResult &&
          form.dataset.filterResult !== result.result)
      ) {
        const row = form.closest("tr");
        const message = document.createElement("p");
        message.className = "notice";
        message.setAttribute("role", "status");
        message.textContent =
          "Estado actualizado. La mediación ya no coincide con el filtro.";
        document.querySelector("#daily").prepend(message);
        row.remove();
      }
    } catch (error) {
      form.elements.state.value = form.dataset.savedState;
      form.elements.result.value = form.dataset.savedResult;
      sync(form);
      status.textContent = error.message;
    } finally {
      form.dataset.saving = "false";
      form.querySelectorAll("select").forEach((s) => (s.disabled = false));
    }
  }
  document.addEventListener("change", (event) => {
    const form = event.target.closest("[data-inline-state]");
    if (form && ["state", "result"].includes(event.target.name)) save(form);
  });
  document.addEventListener("submit", (event) => {
    if (event.target.matches("[data-inline-state]")) {
      event.preventDefault();
      save(event.target);
    }
  });
})();
