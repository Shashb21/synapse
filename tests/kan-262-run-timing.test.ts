/** Reproducible virtual-time load fixtures. Only the provider response and usage store are simulated. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withModelRun } from "@/modules/kernel/model-run";
import { completionFor } from "@/modules/kernel/routing";
import type { ResolvedRoute, RunHandle } from "@/modules/kernel/contracts";

vi.mock("@/modules/kernel/db", () => ({ sharedDb: () => ({ execute: async () => [] }) }));
const route: ResolvedRoute = {
  stage: "S2", provider_id: "openai", provider_label: "Fictional fixture", model: "gpt-4.1", auth: "api_key",
  connected: true, params: { temperature: 0, max_tokens: 16 }, fallbacks: [], degraded: false, reason: null,
};
const trace: RunHandle = { id: "timing", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] };
const baseline = process.env.SYNAPSE_TIMING_BASELINE === "1";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENAI_API_KEY", "fictional-only");
  for (const key of ["SYNAPSE_RUN_CONCURRENCY", "SYNAPSE_RUN_MAX_ATTEMPTS", "SYNAPSE_RUN_TIMEOUT_MS"]) vi.stubEnv(key, "");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const scenarios = [
  // Four-slot synthetic service: excess arrivals get a 429 after one service interval.
  { name: "burst", waves: 1, width: 12, latency: 500, capacity: 4,
    original: [7_500, 24, 12, 12], bounded: [1_500, 12, 4, 12] },
  // Deliberately long but successful grouped work.
  { name: "large", waves: 40, width: 4, latency: 4_000, capacity: 4,
    original: [160_000, 160, 4, 160], bounded: [160_000, 160, 4, 160] },
  { name: "excess sends", waves: 201, width: 1, latency: 100, capacity: 4,
    original: [20_100, 201, 1, 201], bounded: [20_000, 200, 1, 200] },
  { name: "slow serial", waves: 2, width: 1, latency: 100_000, capacity: 4,
    original: [200_000, 2, 1, 2], bounded: [180_000, 2, 1, 1] },
];

it.each(scenarios)("measures the $name fictional provider workload", async scenario => {
  let active = 0, peak = 0, sends = 0, completed = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sends++;
    const excess = ++active > scenario.capacity;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal;
        const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, scenario.latency);
        signal?.addEventListener("abort", cancel, { once: true });
      });
      if (excess) return new Response("busy", { status: 429 });
      return Response.json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    } finally { active--; }
  }));
  const start = Date.now();
  const measured = withModelRun(undefined, async () => {
    const complete = completionFor(route, trace);
    for (let i = 0; i < scenario.waves; i++) {
      const results = await Promise.allSettled(Array.from({ length: scenario.width }, () =>
        complete({ purpose: "timing", system: "fictional fixture", user: "fictional request" })));
      completed += results.filter(result => result.status === "fulfilled").length;
      if (results.some(result => result.status === "rejected")) break;
    }
    return [Date.now() - start, sends, peak, completed];
  });
  await vi.runAllTimersAsync();
  const metrics = await measured;
  if (process.env.SYNAPSE_TIMING_REPORT === "1") console.info(scenario.name, metrics);
  expect(metrics).toEqual(baseline ? scenario.original : scenario.bounded);
});
