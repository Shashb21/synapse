import { describe, expect, it } from "vitest";
import { accuracyRouteConfigs, registerAccuracyStack } from "@/accuracy";
import { ensureAccuracySchema } from "@/accuracy/store/db";

describe("accuracy default LLM routing chain", () => {
  it("defaults agentic kinds to Grok with Claude then OpenAI fallbacks", async () => {
    registerAccuracyStack();
    await ensureAccuracySchema();
    const configs = await accuracyRouteConfigs();
    const agentic = configs.filter((c) => c.agent_role !== "none");
    expect(agentic.length).toBeGreaterThan(0);
    for (const config of agentic) {
      // Fresh defaults when no DB override was written for this kind/role.
      if (config.updated_at !== "—") continue;
      expect(config.provider_id).toBe("xai-grok");
      expect(config.fallbacks).toEqual(["anthropic-claude", "openai"]);
    }
    // At least one default row should exist for need_extract-style kinds.
    const defaults = agentic.filter((c) => c.updated_at === "—");
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults[0]?.fallbacks).toContain("openai");
  });
});
