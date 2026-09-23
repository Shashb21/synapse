import { describe, expect, it } from "vitest";
import { accuracyCompletionFor } from "@/accuracy/kernel/routing";
import type { ResolvedAccuracyRoute, RunHandle } from "@/accuracy/kernel/contracts";

describe("accuracyCompletionFor api_key auth", () => {
  it("rejects disconnected or none auth", async () => {
    const run: RunHandle = {
      id: "arun-test",
      note: () => {},
      step: async (_n, fn) => await fn(),
      steps: () => [],
    };
    const base = {
      call_kind: "need_extract" as const,
      role: "proposer" as const,
      provider_id: "anthropic-claude",
      provider_label: "Claude",
      model: "claude-sonnet-4-5",
      params: { temperature: 0, max_tokens: 100 },
      fallbacks: [],
      degraded: false,
      reason: null,
    };

    const none = accuracyCompletionFor({
      route: { ...base, auth: "none", connected: false } satisfies ResolvedAccuracyRoute,
      run,
      onUsage: () => {},
    });
    await expect(none({ system: "s", user: "u", purpose: "t" })).rejects.toThrow(/No LLM route/);

    const disconnected = accuracyCompletionFor({
      route: { ...base, auth: "api_key", connected: false } satisfies ResolvedAccuracyRoute,
      run,
      onUsage: () => {},
    });
    await expect(disconnected({ system: "s", user: "u", purpose: "t" })).rejects.toThrow(
      /No LLM route/,
    );
  });
});
