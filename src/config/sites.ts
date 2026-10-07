export interface Site {
  code: string;
  name: string;
  start: string;
  end: string;
  slotMinutes: number;
  rooms: number;
}
export const SITES: Site[] = [
  {
    code: "COSQUIN",
    name: "Cosquín",
    start: "08:00",
    end: "15:30",
    slotMinutes: 90,
    rooms: 1,
  },
];
export const minute = (h: string) =>
  Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
export function slots(s: Site) {
  const out: string[] = [];
  for (
    let n = minute(s.start);
    n + s.slotMinutes <= minute(s.end);
    n += s.slotMinutes
  )
    out.push(
      `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`,
    );
  return out;
}
export function site(code: string) {
  return SITES.find((s) => s.code === code);
}
// Trusted code-generated VALUES CTE; never interpolate user input into SQL.
export function siteCTE() {
  return `sites(code,open,close,duration,rooms) AS (VALUES ${SITES.map((s) => `('${s.code.replaceAll("'", "''")}',${minute(s.start)},${minute(s.end)},${s.slotMinutes},${s.rooms})`).join(",")})`;
}

export function validateSites() {
  const codes = new Set<string>();
  if (!SITES.length) throw Error("Configure al menos una sede.");
  for (const s of SITES) {
    const time = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (
      !s.code ||
      !s.name ||
      codes.has(s.code) ||
      !time.test(s.start) ||
      !time.test(s.end) ||
      !Number.isSafeInteger(s.slotMinutes) ||
      s.slotMinutes <= 0 ||
      s.slotMinutes > 1440 ||
      !Number.isSafeInteger(s.rooms) ||
      s.rooms < 1 ||
      minute(s.start) + s.slotMinutes > minute(s.end)
    )
      throw Error(`Configuración inválida de sede: ${s.code}`);
    codes.add(s.code);
  }
}
validateSites();
