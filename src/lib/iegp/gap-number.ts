/** A gap's number as people read it (KAN-56): 001, 002… 1000. The gap id stays the key. */
export function gapNumberLabel(number: number | null | undefined): string {
  return number ? String(number).padStart(3, "0") : "—";
}

/** Numeric display order; missing (dash) numbers stay last in either direction.
 * Equal numbers, including missing numbers, use the internal ID ascending so
 * ordering is deterministic regardless of incoming review rank or input order.
 */
export function compareGapNumbers(
  a: { number?: number | null; gap_id: string },
  b: { number?: number | null; gap_id: string },
  direction: "asc" | "desc",
): number {
  const aMissing = !a.number;
  const bMissing = !b.number;
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  if (!aMissing && !bMissing && a.number !== b.number) {
    return (a.number! - b.number!) * (direction === "asc" ? 1 : -1);
  }
  return a.gap_id < b.gap_id ? -1 : a.gap_id > b.gap_id ? 1 : 0;
}
