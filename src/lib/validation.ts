import { BusinessError } from "../types";
export const normalizeDNI = (s: string) =>
  s.replace(/[.\s]/g, "").replace(/^0+/, "");
export const validDNI = (s: string) => /^[1-9][0-9]{0,7}$/.test(s);
export const normalizeText = (s: string) => s.trim().replace(/\s+/g, " ");
export const searchText = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es");
export const validEmail = (s: string) =>
  s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export function whitelistRow(row: Record<string, unknown>) {
  const dni = normalizeDNI(String(row.dni ?? "")),
    nombre = normalizeText(String(row.nombre ?? row.first ?? "")),
    apellido = normalizeText(String(row.apellido ?? row.last ?? "")),
    email = String(row.email ?? "")
      .trim()
      .toLowerCase();
  if (
    !validDNI(dni) ||
    !nombre ||
    !apellido ||
    nombre.length > 100 ||
    apellido.length > 100 ||
    !validEmail(email)
  )
    throw new BusinessError(
      "Complete DNI numérico, nombre, apellido y email válidos.",
    );
  return { dni, nombre, apellido, email };
}
export const id = (s: unknown) => {
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
export function passwordValid(p: string) {
  const n = new TextEncoder().encode(p).length;
  if (n < 12 || n > 72)
    throw new BusinessError("La contraseña debe tener entre 12 y 72 bytes.");
}
export function resultValid(state: string, result: string, old = state) {
  if (
    !["RESERVADA", "INICIADA", "FINALIZADA", "FIRMADA"].includes(state) &&
    !(state === "CANCELADA_POR_ADMIN" && old === state)
  )
    throw new BusinessError("Estado inválido.");
  if (old === "CANCELADA_POR_ADMIN" && state !== old)
    throw new BusinessError(
      "La mediación fue cancelada por un bloqueo. Cree una nueva reserva.",
    );
  if (
    ["FINALIZADA", "FIRMADA"].includes(state) &&
    !["CON_ACUERDO", "SIN_ACUERDO", "INCOMPARECENCIA"].includes(result)
  )
    throw new BusinessError("Indique un resultado válido al finalizar.");
  if (["RESERVADA", "INICIADA"].includes(state) && result)
    throw new BusinessError(
      "El resultado corresponde a una mediación finalizada.",
    );
}
