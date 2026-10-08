/** UTC agreement series for distinct captured human decisions; invalid records fail explicitly. */
import type { StageId } from "./contracts";
import type { DecisionExample } from "./decision-examples";

export type AgreementBucket = {
  stage: StageId; period: string; total: number; accepted: number; edited: number; rejected: number;
  accepted_share: number | null; edited_share: number | null; rejected_share: number | null;
};

/** Count each example ID once, fill intervening empty periods and separate stages. */
export function agreementSeries(examples: DecisionExample[], bucket: "day" | "week"): AgreementBucket[] {
  const seen = new Set<string>();
  const byStage = new Map<StageId, Map<string, AgreementBucket>>();
  for (const example of examples) {
    if (seen.has(example.id)) continue;
    seen.add(example.id);
    const date = new Date(example.created_at);
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid decision timestamp for ${example.id}.`);
    if (!["accepted", "edited", "rejected"].includes(example.outcome)) throw new Error(`Invalid decision outcome for ${example.id}.`);
    date.setUTCHours(0, 0, 0, 0);
    if (bucket === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const period = date.toISOString().slice(0, 10);
    const periods = byStage.get(example.stage) ?? new Map<string, AgreementBucket>();
    const row = periods.get(period) ?? emptyBucket(example.stage, period);
    row.total++; row[example.outcome]++;
    periods.set(period, row); byStage.set(example.stage, periods);
  }
  const result: AgreementBucket[] = [];
  for (const [stage, periods] of byStage) {
    const keys = [...periods.keys()].sort();
    const date = new Date(`${keys[0]}T00:00:00Z`);
    const last = keys[keys.length - 1];
    while (date.toISOString().slice(0, 10) <= last) {
      const period = date.toISOString().slice(0, 10);
      const row = periods.get(period) ?? emptyBucket(stage, period);
      for (const outcome of ["accepted", "edited", "rejected"] as const) row[`${outcome}_share`] = row.total ? row[outcome] / row.total : null;
      result.push(row);
      date.setUTCDate(date.getUTCDate() + (bucket === "week" ? 7 : 1));
    }
  }
  return result.sort((a, b) => a.period.localeCompare(b.period) || a.stage.localeCompare(b.stage));
}

/** Create an observed-range period with no decisions. */
function emptyBucket(stage: StageId, period: string): AgreementBucket {
  return { stage, period, total: 0, accepted: 0, edited: 0, rejected: 0, accepted_share: null, edited_share: null, rejected_share: null };
}
