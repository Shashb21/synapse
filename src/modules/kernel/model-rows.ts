/** Validates the identifiers of model answers before stage-specific parsing. */

/** Collect one answer per requested identifier and retain reasons for failed rows. */
export function modelRows(args: {
  payload: unknown;
  field: string;
  idField: string;
  ids: string[];
  problems: Map<string, string>;
  report: (details: { field: string; id?: string; problem: string }) => void;
}): Map<string, Record<string, unknown>> {
  const { payload, field, idField, ids, problems, report } = args;
  const rows = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[field] : undefined;
  const found = new Map<string, Record<string, unknown>>();
  const duplicates = new Set<string>();
  for (const id of ids) problems.set(id, `${field} must contain one answer for ${id}.`);
  if (!Array.isArray(rows)) {
    for (const id of ids) problems.set(id, `${field} must be a list.`);
    report({ field, problem: `${field} must be a list.` });
    return found;
  }
  const expected = new Set(ids);
  for (const row of rows) {
    const value = row && typeof row === "object" ? (row as Record<string, unknown>)[idField] : undefined;
    const id = typeof value === "string" ? value.trim() : "";
    if (!expected.has(id)) {
      report({ field, id: id || undefined, problem: id ? "identifier was not requested" : `missing ${idField}` });
      continue;
    }
    if (found.has(id) || duplicates.has(id)) {
      found.delete(id);
      duplicates.add(id);
      problems.set(id, `Duplicate ${idField} ${id}; return exactly one answer.`);
      continue;
    }
    found.set(id, row);
    problems.delete(id);
  }
  return found;
}
