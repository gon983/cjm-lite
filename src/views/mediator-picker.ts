import type { User } from "../types";
import { e, hidden, select, mediatorOptions } from "./html";
export type MediatorField = "m1" | "m2";
export const resultsId = (field: MediatorField) =>
  field === "m2" ? "mediator-picker" : "mediator-picker-m1";
export function pickerResults(
  users: User[],
  field: MediatorField = "m2",
  visible = true,
) {
  return `<div id="${resultsId(field)}" class="mediator-results" ${visible ? "" : "hidden"} data-mediator-results role="listbox" aria-label="Resultados de búsqueda">${
    users
      .map((u) => {
        const label = `${u.apellido} ${u.nombre} · ${u.dni}`;
        return `<button type="button" role="option" class="mediator-option" data-mediator-select="${u.id}" data-mediator-label="${e(label)}" aria-selected="false">${e(label)}</button>`;
      })
      .join("") || '<p role="status">No se encontraron mediadores activos.</p>'
  }</div>`;
}
export function mediatorWidget(
  users: User[],
  field: MediatorField,
  chosen = 0,
  label = "",
) {
  const selected = users.find((u) => u.id === chosen);
  const text =
    label ||
    (selected
      ? `${selected.apellido} ${selected.nombre} · ${selected.dni}`
      : "");
  const number = field === "m1" ? "1" : "2";
  const inputId = "mediator-search-" + field;
  return `<div class="mediator-widget" data-mediator-widget="${field}">${hidden(field, chosen || "").replace("<input ", "<input disabled data-mediator-value ")}<label for="${inputId}">Mediador ${number}<input id="${inputId}" type="search" name="q_${field}" value="${e(text)}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${resultsId(field)}" autocomplete="off" placeholder="Escribí nombre, apellido o DNI" data-mediator-search hx-get="/mediadores/buscar?field=${field}" hx-trigger="input changed delay:150ms, search" hx-target="#${resultsId(field)}" hx-select="#${resultsId(field)}" hx-swap="outerHTML" hx-sync="this:replace" hx-params="q_${field},field,exclude" hx-vals='${e(JSON.stringify({ field }))}' data-selected="${chosen || ""}"></label>${pickerResults([], field, false)}<noscript>${select("Seleccione mediador " + number, field, [["", "Seleccione un mediador"], ...mediatorOptions(users, chosen)], String(chosen), "required")}</noscript></div>`;
}
