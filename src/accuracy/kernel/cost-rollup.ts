import type { TokenUsage } from "./contracts";

export type RunCostInput = {
  call_kind: string;
  status: string;
  cost_usd: string | number | null;
  token_usage: unknown;
};

export type CallKindCostRollup = {
  call_kind: string;
  run_count: number;
  ok_count: number;
  error_count: number;
  abandoned_count: number;
  running_count: number;
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type AccuracyCostRollup = {
  run_count: number;
  ok_count: number;
  error_count: number;
  abandoned_count: number;
  running_count: number;
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  by_call_kind: CallKindCostRollup[];
};

export function parseCostUsd(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parseTokenUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const row = value as Record<string, unknown>;
  const prompt_tokens = Number(row.prompt_tokens) || 0;
  const completion_tokens = Number(row.completion_tokens) || 0;
  const total_tokens = Number(row.total_tokens) || prompt_tokens + completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens };
}

function emptyKind(call_kind: string): CallKindCostRollup {
  return {
    call_kind,
    run_count: 0,
    ok_count: 0,
    error_count: 0,
    abandoned_count: 0,
    running_count: 0,
    cost_usd: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

function addRun(bucket: CallKindCostRollup, run: RunCostInput) {
  const usage = parseTokenUsage(run.token_usage);
  bucket.run_count += 1;
  if (run.status === "ok") bucket.ok_count += 1;
  else if (run.status === "error") bucket.error_count += 1;
  else if (run.status === "abandoned") bucket.abandoned_count += 1;
  else if (run.status === "running") bucket.running_count += 1;
  bucket.cost_usd += parseCostUsd(run.cost_usd);
  bucket.prompt_tokens += usage.prompt_tokens;
  bucket.completion_tokens += usage.completion_tokens;
  bucket.total_tokens += usage.total_tokens;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Aggregate estimated spend and tokens for audit / runs views. */
export function rollupAccuracyRunCost(runs: RunCostInput[]): AccuracyCostRollup {
  const byKind = new Map<string, CallKindCostRollup>();
  const totals = emptyKind("all");
  for (const run of runs) {
    addRun(totals, run);
    const kind = run.call_kind || "unknown";
    const bucket = byKind.get(kind) ?? emptyKind(kind);
    addRun(bucket, run);
    byKind.set(kind, bucket);
  }
  const by_call_kind = [...byKind.values()]
    .map((row) => ({ ...row, cost_usd: roundUsd(row.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.call_kind.localeCompare(b.call_kind));
  return {
    run_count: totals.run_count,
    ok_count: totals.ok_count,
    error_count: totals.error_count,
    abandoned_count: totals.abandoned_count,
    running_count: totals.running_count,
    cost_usd: roundUsd(totals.cost_usd),
    prompt_tokens: totals.prompt_tokens,
    completion_tokens: totals.completion_tokens,
    total_tokens: totals.total_tokens,
    by_call_kind,
  };
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}
