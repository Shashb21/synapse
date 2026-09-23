import { describe, expect, it } from "vitest";
import { formatUsd, rollupAccuracyRunCost } from "@/accuracy/kernel/cost-rollup";

describe("accuracy cost rollup", () => {
  it("aggregates USD, tokens, and status by call kind", () => {
    const rollup = rollupAccuracyRunCost([
      {
        call_kind: "need_extract",
        status: "ok",
        cost_usd: "0.12",
        token_usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      },
      {
        call_kind: "need_extract",
        status: "error",
        cost_usd: 0.03,
        token_usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
      {
        call_kind: "coverage_decide",
        status: "ok",
        cost_usd: "0.05",
        token_usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
      },
      {
        call_kind: "parse",
        status: "abandoned",
        cost_usd: null,
        token_usage: null,
      },
    ]);

    expect(rollup.run_count).toBe(4);
    expect(rollup.ok_count).toBe(2);
    expect(rollup.error_count).toBe(1);
    expect(rollup.abandoned_count).toBe(1);
    expect(rollup.cost_usd).toBeCloseTo(0.2, 6);
    expect(rollup.total_tokens).toBe(1410);
    expect(rollup.by_call_kind.map((row) => row.call_kind)).toEqual([
      "need_extract",
      "coverage_decide",
      "parse",
    ]);
    expect(rollup.by_call_kind[0]?.cost_usd).toBeCloseTo(0.15, 6);
    expect(rollup.by_call_kind[0]?.run_count).toBe(2);
  });

  it("treats unknown numeric strings as zero", () => {
    const rollup = rollupAccuracyRunCost([
      { call_kind: "ideate", status: "ok", cost_usd: "n/a", token_usage: { prompt_tokens: "x" } },
    ]);
    expect(rollup.cost_usd).toBe(0);
    expect(rollup.prompt_tokens).toBe(0);
  });

  it("formats small USD amounts without rounding to zero", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0004)).toBe("$0.000400");
    expect(formatUsd(0.1234)).toBe("$0.1234");
  });
});
