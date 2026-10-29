/** Server rendering preserves independent unknown reads and never exposes failed-read details. */
import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STAGE_IDS } from "@/modules/kernel/contracts";
import { noAiSections } from "@/modules/kernel/ai-sections";
const reads = vi.hoisted(() => ({ ai: vi.fn(), sections: vi.fn(), routes: vi.fn(), wiring: vi.fn(), keys: vi.fn() }));
vi.mock("@/modules/kernel/ai-switch", () => ({ aiSwitch: reads.ai, storedAiSections: reads.sections }));
vi.mock("@/modules/kernel/routing", () => ({ routeConfigs: reads.routes }));
vi.mock("@/modules/kernel/registry", () => ({ stageWiring: reads.wiring }));
vi.mock("@/modules/llm/api-keys", () => ({ listProviderKeys: reads.keys }));
vi.mock("@/modules/auth/owner", () => ({ ownerAccess: async () => ({ owner: true }) }));
vi.mock("@/modules/auth/session", () => ({ sessionContext: async () => ({ role: "medical_affairs", actor: { name: "Owner", function: "medical_affairs" }, signed_in: true }), loginOptions: () => ({ providers: [] }) }));
vi.mock("@/components/platform/ai-switch-panel", () => ({ AiSwitchPanel: () => createElement("div", null, "Known AI controls") }));
vi.mock("@/components/platform/session-panel", () => ({ SessionPanel: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { ControlPanelView } from "@/components/platform/control-panel-view";
const configs = STAGE_IDS.map(stage => ({ stage, provider_id: "xai-grok", model: "grok-4", params: { temperature: 0, max_tokens: 8192 }, fallbacks: [], updated_by: "owner", updated_at: "now" }));
beforeEach(() => {
  reads.ai.mockResolvedValue({ enabled: true, updated_by: null, updated_at: null, rationale: null });
  reads.sections.mockResolvedValue({ sections: { ...noAiSections(), gap_extraction: true } });
  reads.routes.mockResolvedValue(configs);
  reads.wiring.mockResolvedValue(STAGE_IDS.map(stage => ({ stage, active: null, available: [] })));
  reads.keys.mockReturnValue([{ provider_id: "xai-grok", label: "xAI · Grok", summary: "Cloud model", tier: "default", auth: "api_key", status: "missing", models: ["grok-4"], default_model: "grok-4", key_env: "XAI_API_KEY" }]);
});
async function markup() { return renderToStaticMarkup(await ControlPanelView({ params: {} })); }
it("retains successful master and section reads when routing fails, with no raw error or invented route", async () => {
  reads.routes.mockRejectedValue(new Error("postgres://user:sk-secret@host/private failed"));
  const html = await markup();
  expect(html).toContain("1 of 8 enabled");
  expect(html).toContain("Known AI controls");
  expect(html).toContain("Routing configuration unavailable");
  expect(html).not.toContain("sk-secret");
  expect(html).not.toContain("Mixed providers");
});
it("does not invent an enabled master switch after its read fails", async () => {
  reads.ai.mockRejectedValue(new Error("private failure sk-secret"));
  const html = await markup();
  expect(html).toContain("Status unavailable");
  expect(html).toContain("Customer permission unavailable");
  expect(html).not.toContain("Known AI controls");
  expect(html).not.toContain("AI is off");
  expect(html).toContain("provider use is unknown");
  expect(html).not.toContain("sk-secret");
});
it("updates summary on the next server render after saved preferences change", async () => {
  expect(await markup()).toContain("1 of 8 enabled");
  reads.sections.mockResolvedValue({ sections: noAiSections() });
  expect(await markup()).toContain("No customer AI sections enabled");
});
it("reports unavailable key reads without their secret-bearing exception", async () => {
  reads.keys.mockImplementation(() => { throw new Error("credential read failed sk-secret"); });
  const html = await markup();
  expect(html).toContain("Credential readiness unavailable");
  expect(html).not.toContain("No configured provider");
  expect(html).not.toContain("sk-secret");
});
it("retains confirmed missing-provider copy when credential metadata loads successfully", async () => {
  const html = await markup();
  expect(html).toContain("No configured provider");
});
