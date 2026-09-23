import { describe, expect, it } from "vitest";
import { estimateCostUsd, usageFromMessages } from "@/accuracy/kernel/cost";

describe("accuracy cost estimates", () => {
  it("computes non-zero USD for known models", () => {
    const usage = usageFromMessages("system", "user prompt", "completion text");
    const { cost_usd } = estimateCostUsd({
      provider_id: "xai",
      model: "grok-4",
      usage,
    });
    expect(cost_usd).toBeGreaterThan(0);
  });
});
