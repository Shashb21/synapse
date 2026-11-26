/** Runtime and owner previews share credential selection, ordering and model policy. */
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/demo/mode", () => ({ replaysDemo: async () => false }));
import { resolveRoute, type RouteConfig } from "@/modules/kernel/routing";
import { selectCredentialRoute, stageHasRoute } from "@/modules/kernel/credential-route";
import { findProvider } from "@/modules/llm/provider";
const config: RouteConfig = { stage: "S2", provider_id: "xai-grok", model: "saved-model", params: { temperature: 0, max_tokens: 8192 }, fallbacks: ["anthropic-claude", "openai"], updated_by: "owner", updated_at: "now" };
afterEach(() => vi.unstubAllEnvs());
it("uses the configured primary and its saved model ahead of configured fallbacks", async () => {
  vi.stubEnv("XAI_API_KEY", "test-primary"); vi.stubEnv("ANTHROPIC_API_KEY", "test-alternate");
  const route = await resolveRoute("S2", config);
  expect(route.provider_id).toBe("xai-grok");
  expect(route.model).toBe("saved-model");
  expect(route.degraded).toBe(false);
});
it("uses the first permitted configured fallback and its default model", async () => {
  vi.stubEnv("XAI_API_KEY", ""); vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "test-alternate");
  vi.stubEnv("SYNAPSE_APPROVED_FALLBACK_PAIRS", "xai-grok>openai");
  const route = await resolveRoute("S2", config);
  expect(route.provider_id).toBe("openai");
  expect(route.model).toBe(findProvider("openai")!.default_model);
  expect(route.degraded).toBe(true);
  expect(route.reason).toContain("XAI_API_KEY");
});
it("does not invent a fallback just because another provider has a key", async () => {
  vi.stubEnv("XAI_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "test-unlisted");
  await expect(resolveRoute("S2", { ...config, fallbacks: [] })).rejects.toThrow("XAI_API_KEY");
});
it("excludes legacy, unknown and non-model providers from credential selection", () => {
  const result = selectCredentialRoute({ provider_id: "unknown", model: "unused", fallbacks: ["deterministic-local", "local", "cloud"] }, [
    { id: "local", label: "Local", default_model: "none", auth: "none", status: "configured" },
    { id: "cloud", label: "Cloud", default_model: "default-model", auth: "api_key", status: "configured" },
  ]);
  expect(result.selected).toBeNull();
  expect(result.rejected).toEqual([{ id: "unknown", reason: "unknown" }]);
});
it("requires routes for model stages and never for ingestion or human stages", () => {
  expect(stageHasRoute("S2")).toBe(true);
  expect(stageHasRoute("S0")).toBe(false);
  expect(stageHasRoute("S1")).toBe(false);
  expect(stageHasRoute("S5")).toBe(false);
});

it("requires current approval to resume a previously frozen Development fallback", async () => {
  const { freezeRoute, frozenRouteAllowed } = await import("@/modules/development/routes");
  vi.stubEnv("XAI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "fictional");
  vi.stubEnv("SYNAPSE_APPROVED_FALLBACK_PAIRS", "");
  const requested = { provider_id: "xai-grok", model: "grok-4", temperature: 0, max_tokens: 100, fallbacks: ["openai"] };
  expect(() => freezeRoute("gap_extraction", requested)).toThrow();
  vi.stubEnv("SYNAPSE_APPROVED_FALLBACK_PAIRS", "xai-grok>openai");
  const frozen = freezeRoute("gap_extraction", requested);
  expect(frozen.actual.provider_id).toBe("openai");
  expect(frozenRouteAllowed(frozen)).toBe(true);
  vi.stubEnv("SYNAPSE_APPROVED_FALLBACK_PAIRS", "openai>xai-grok");
  expect(frozenRouteAllowed(frozen)).toBe(false);
});
