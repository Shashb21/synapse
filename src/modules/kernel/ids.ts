let counter = 0;

/** Sortable, readable id: `run_20260921T110500_001_a3f9`. Random suffix avoids vitest worker collisions. */
export function newId(prefix: string, at: Date = new Date()): string {
  counter = (counter + 1) % 100000;
  const stamp = at.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const salt = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${stamp}_${String(counter).padStart(4, "0")}_${salt}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
