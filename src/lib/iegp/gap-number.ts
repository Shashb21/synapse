/** A gap's number as people read it (KAN-56): 001, 002… 1000. The gap id stays the key. */
export function gapNumberLabel(number: number | null | undefined): string {
  return number ? String(number).padStart(3, "0") : "—";
}
