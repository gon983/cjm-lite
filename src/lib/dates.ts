export const TZ = "America/Argentina/Cordoba";
export function localNow(now = new Date()) {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}
export const today = (now = new Date()) => localNow(now).slice(0, 10);
export function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Translate the named business timezone into an explicit D1 clock modifier.
export function sqliteLocalModifier(now = new Date()) {
  const wall = Date.parse(localNow(now).replace(" ", "T") + "Z");
  return `${Math.round((wall - now.getTime()) / 60000)} minutes`;
}
export const clockCTE =
  "clock(local_now) AS (SELECT COALESCE(?,datetime('now',?)))";
export function clockArgs(override?: Date): [string | null, string] {
  return [
    override ? localNow(override) : null,
    sqliteLocalModifier(override ?? new Date()),
  ];
}
export const sqlMonthLimit =
  "(SELECT date(substr(local_now,1,10),'start of month','+1 month',printf('+%d days',min(CAST(substr(local_now,9,2) AS INTEGER),CAST(strftime('%d',date(substr(local_now,1,10),'start of month','+2 months','-1 day')) AS INTEGER))-1)) FROM clock)";
export function dateInput(s: string) {
  s = s.trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.split("/").reverse().join("-");
  return s;
}
export function dateES(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split("-").reverse().join("/") : s;
}
export function timestampES(s: string) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : localNow(d)
        .slice(0, 16)
        .replace(/^(\d{4})-(\d{2})-(\d{2})/, "$3/$2/$1");
}
export function addDays(s: string, n: number) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function monthLimit(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last), 12))
    .toISOString()
    .slice(0, 10);
}
export const weekday = (day: string) =>
  new Date(`${day}T12:00:00Z`).getUTCDay();
export const monday = (day: string) => addDays(day, -((weekday(day) + 6) % 7));
export const detailES = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}/g, dateES);
