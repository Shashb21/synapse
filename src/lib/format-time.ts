/**
 * A stored ISO time for the admin console, with its zone named: "2 Oct 2026,
 * 14:05 UTC". Always UTC, so the server render and the browser agree.
 */
const FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function formatUtc(iso: string | null | undefined, empty = "never"): string {
  if (!iso) return empty;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${FORMAT.format(at)} UTC`;
}
