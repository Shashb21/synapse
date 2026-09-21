let counter = 0;

/** Sortable, readable id: `run_20260921T110500_001`. */
export function newId(prefix: string, at: Date = new Date()): string {
  counter = (counter + 1) % 100000;
  const stamp = at.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `${prefix}_${stamp}_${String(counter).padStart(4, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
