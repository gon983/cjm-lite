import type { Ctx, Mediation } from "../types";
import { post, hidden, select, STATES, RESULTS, e } from "./html";
export function inlineState(
  c: Ctx,
  m: Mediation,
  filterState = "",
  filterResult = "",
) {
  const cancelled = m.state === "CANCELADA_POR_ADMIN",
    finished = ["FINALIZADA", "FIRMADA"].includes(m.state);
  return post(
    c,
    "/admin/estado",
    hidden("id", m.id) +
      hidden("inline", "1") +
      select(
        "Estado",
        "state",
        (cancelled ? ["CANCELADA_POR_ADMIN"] : STATES.slice(0, 4)).map((v) => [
          v,
          v,
        ]),
        m.state,
        cancelled ? "disabled" : "",
      ) +
      `<div data-state-result ${finished ? "" : "hidden"}>${select("Resultado", "result", [["", "Seleccione resultado"], ...RESULTS.map((v) => [v, v] as [string, string])], m.result, finished ? "required" : "")}</div>${cancelled && m.result ? `<span>${e(m.result)}</span>` : ""}<p class="inline-state-status muted" role="status" aria-live="polite"></p><noscript><button>Guardar estado</button></noscript>`,
    `class="inline-state" data-inline-state data-saved-state="${e(m.state)}" data-saved-result="${e(m.result)}" data-filter-state="${e(filterState)}" data-filter-result="${e(filterResult)}"`,
  );
}
