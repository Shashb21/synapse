/** Raw owner edits and runtime previews share one confirmed stored snapshot. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { noAiSections } from "@/modules/kernel/ai-sections";
const database = vi.hoisted(() => ({ rows: [] as unknown[], from: vi.fn() }));
vi.mock("@/modules/kernel/db", () => ({
  ensurePlatformSchema: async () => undefined,
  sharedDb: () => ({ select: () => ({ from: database.from }) }),
}));
vi.mock("@/modules/kernel/ai-switch", () => ({ aiSwitch: async () => ({ enabled: true }), storedAiSections: async () => ({ sections: { ...noAiSections(), gap_extraction: true } }) }));
vi.mock("@/modules/kernel/registry", () => ({ stageWiring: async () => [] }));
vi.mock("@/modules/auth/session", () => ({ sessionContext: async () => ({ signed_in: true, role: "medical_affairs", actor: { name: "Owner", function: "medical_affairs" }, demo: false }), loginOptions: () => ({ providers: [] }) }));
vi.mock("@/modules/auth/owner", () => ({ ownerAccess: async () => ({ owner: true }) }));
vi.mock("@/lib/demo/mode", () => ({ replaysDemo: async () => false }));
vi.mock("@/components/platform/session-panel", () => ({ SessionPanel: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { ControlPanelView } from "@/components/platform/control-panel-view";
import { loadControlPanel } from "@/components/platform/control-panel-load";
import { resolveRoute, routeConfig } from "@/modules/kernel/routing";
import { findProvider } from "@/modules/llm/provider";
beforeEach(() => {
  database.from.mockReset().mockImplementation(async () => database.rows);
  vi.stubEnv("XAI_API_KEY", "test-configured-primary");
});
afterEach(() => vi.unstubAllEnvs());
it.each(["xai-grok", "deterministic-local"])("preserves raw %s values but previews the same normalized route as execution", async providerId => {
  const stored = { stage: "S2", provider_id: providerId, model: "removed-model", params: { temperature: 0, max_tokens: 8192 }, fallbacks: ["deterministic-local", "openai"], updated_by: "owner", updated_at: "now" };
  database.rows = [stored];
  const loaded = await loadControlPanel();
  expect(database.from).toHaveBeenCalledTimes(1);
  expect(loaded.configs.status).toBe("ready");
  if (loaded.configs.status !== "ready") throw new Error("Expected confirmed editor configuration");
  expect(loaded.configs.value.find(row => row.stage === "S2")).toMatchObject(stored);
  const execution = await resolveRoute("S2", await routeConfig("S2"));
  expect(execution.model).toBe(findProvider("xai-grok")!.default_model);
  expect(loaded.resolutions.S2).toEqual({ status: "ready", value: { state: "resolved", label: `${execution.provider_label} · ${execution.model}`, message: null } });
  expect(stored.model).toBe("removed-model");
  expect(stored.provider_id).toBe(providerId);
  expect(stored.fallbacks).toEqual(["deterministic-local", "openai"]);
});

it.each(["xai-grok", "deterministic-local"])("renders raw saved %s routing while summary credentials agree with runtime", async providerId => {
  const stored = { stage: "S2", provider_id: providerId, model: "removed-model", params: { temperature: 0, max_tokens: 8192 }, fallbacks: [], updated_by: "owner", updated_at: "now" };
  database.rows = [stored];
  const html = renderToStaticMarkup(await ControlPanelView({ params: {} }));
  expect(database.from).toHaveBeenCalledTimes(1);
  const summary = html.match(/<section[^>]*data-testid="ai-availability-summary"[^>]*>[\s\S]*?<\/section>/)?.[0];
  expect(summary).toBeDefined();
  expect(summary).toContain("All enabled model stages have configured primary keys.");
  expect(summary).not.toContain("no configured provider");
  expect(summary).not.toContain("Review provider credentials");
  expect(summary).toContain("Review AI sections");
  // Saved routing still describes the stored mismatch, rather than claiming the runtime default was saved.
  expect(summary).toContain(providerId === "deterministic-local" ? "Mixed providers and models" : "Mixed models");
  expect(html).toContain("removed-model — unavailable");
  expect(html).toContain(providerId === "deterministic-local"
    ? "Unknown or disallowed provider. Choose an available provider."
    : "Saved model is unavailable for this provider. Choose an available model.");
  const execution = await resolveRoute("S2", await routeConfig("S2"));
  expect(html).toContain(`${execution.provider_label} · ${execution.model}`);
  expect(execution.provider_id).toBe("xai-grok");
  expect(stored).toMatchObject({ provider_id: providerId, model: "removed-model", fallbacks: [] });
});
