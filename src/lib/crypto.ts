import { BusinessError } from "../types";
const enc = new TextEncoder();
export const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export const randomToken = () =>
  hex(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export async function hmac(secret: string, s: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(s)));
}
export function equal(a: string, b: string) {
  let v = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    v |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return v === 0;
}
export function passwordText(p: unknown) {
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return new TextDecoder().decode(new Uint8Array(p));
  if (p instanceof ArrayBuffer) return new TextDecoder().decode(p);
  return "";
}
export function proofValid(salt: string, proof: string) {
  if (!/^[0-9a-f]{64}$/.test(salt) || !/^[0-9a-f]{64}$/.test(proof))
    throw new BusinessError(
      "La contraseña debe procesarse desde el formulario seguro. Active JavaScript y vuelva a intentar.",
    );
}
// PBKDF2-HMAC-SHA256, 600k, random 256-bit salt runs in browser. Only the peppered HMAC verifier persists.
export async function hashProof(secret: string, salt: string, proof: string) {
  proofValid(salt, proof);
  return `client-pbkdf2-sha256$600000$${salt}$${await hmac(secret, `password:${salt}:${proof}`)}`;
}
export async function verifyProof(
  secret: string,
  proof: string,
  stored: unknown,
) {
  const h = passwordText(stored),
    [algo, cost, salt, digest] = h.split("$");
  if (algo !== "client-pbkdf2-sha256" || cost !== "600000") return false;
  proofValid(salt, proof);
  return equal(await hmac(secret, `password:${salt}:${proof}`), digest ?? "");
}
