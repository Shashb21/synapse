/** @vitest-environment jsdom */
/** Configuration availability is independent, honest, and safe to serialize. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STAGE_IDS } from "@/modules/kernel/contracts";
import { noAiSections } from "@/modules/kernel/ai-sections";

const reads = vi.hoisted(() => ({
  master: vi.fn(), sections: vi.fn(), routes: vi.fn(), wiring: vi.fn(), identity: vi.fn(), owner: vi.fn(), resolve: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/kernel/ai-switch", () => ({ aiSwitch: reads.master, storedAiSections: reads.sections }));
vi.mock("@/modules/kernel/routing", async importOriginal => ({
  ...await importOriginal<typeof import("@/modules/kernel/routing")>(), routeConfigs: reads.routes, resolveRoute: reads.resolve, previewRoute: reads.resolve }));
vi.mock("@/modules/kernel/registry", () => ({ stageWiring: reads.wiring }));
vi.mock("@/modules/auth/session", () => ({ sessionContext: reads.identity, loginOptions: () => ({ providers: [] }) }));
vi.mock("@/modules/auth/owner", () => ({ ownerAccess: reads.owner }));
vi.mock("@/components/platform/session-panel", () => ({ SessionPanel: () => createElement("p", null, "Session") }));
import { ControlPanelView } from "@/components/platform/control-panel-view";
import { NoRouteError } from "@/modules/llm/provider";

const configs = STAGE_IDS.map(stage => ({ stage, provider_id: "xai-grok", model: "grok-4", params: { temperature: 0, max_tokens: 16000 }, fallbacks: ["anthropic-claude", "openai"], updated_by: "confirmed-default", updated_at: "—" }));
const wiring = STAGE_IDS.map(stage => ({ stage, active: null, available: [], activated_by: null, activated_at: null, has_evals: false }));
async function html() { return renderToStaticMarkup(await ControlPanelView({ params: {} })); }
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  reads.master.mockReset().mockResolvedValue({ enabled: true, updated_by: null, updated_at: null, rationale: null });
  reads.sections.mockReset().mockResolvedValue({ sections: noAiSections() });
  reads.routes.mockReset().mockResolvedValue(configs);
  reads.wiring.mockReset().mockResolvedValue(wiring);
  reads.identity.mockReset().mockResolvedValue({ session: null, actor: { name: "Owner", function: "medical_affairs" }, role: "medical_affairs", signed_in: true, demo: false });
  reads.owner.mockReset().mockResolvedValue({ owner: true });
  reads.resolve.mockReset().mockImplementation(async stage => ({ stage, provider_label: "xAI · Grok", model: "grok-4", connected: true, degraded: false }));
});

afterEach(() => vi.restoreAllMocks());

describe("KAN-192 server reads", () => {
  it.each(["master", "sections", "routes", "wiring", "identity", "owner"] as const)("keeps independent confirmed configuration when %s is unavailable", async operation => {
    // Arrange: only one source fails, carrying sensitive infrastructure text.
    reads[operation].mockRejectedValue(new Error("select password from secret_table; token=private"));
    // Act: render the actual server view and its client panels.
    const result = await html();
    // Assert: failure is explicit; confirmed key presence and sibling values survive.
    expect(result).toContain("unavailable");
    expect(result).toContain("Retry configuration");
    expect(result).toContain('role="status"');
    expect(result).toContain("XAI_API_KEY");
    expect(result).not.toContain("secret_table");
    if (operation !== "routes") expect(result).toContain("confirmed-default");
    if (operation === "master") {
      expect(result).not.toContain("AI is on");
      expect(result).not.toContain("AI is off,");
    }
    if (operation === "identity" || operation === "owner") {
      const document = new DOMParser().parseFromString(result, "text/html");
      expect([...document.querySelectorAll("button")].filter(button => button.textContent?.includes("Save route")).every(button => button.disabled)).toBe(true);
    }
  });
  it("uses the real successful loader defaults", async () => {
    const result = await html();
    expect(result).toContain('value="16000"');
    expect(result).toContain("Remove backup 1: Anthropic · Claude");
    expect(result).toContain("Remove backup 2: OpenAI · ChatGPT");
    expect(reads.routes).toHaveBeenCalledWith({ preserveStored: true });
    expect(reads.identity).toHaveBeenCalledTimes(1);
  });
  it("does not invent defaults or crash when successful lists omit a stage", async () => {
    reads.routes.mockResolvedValue(configs.filter(row => row.stage !== "S2"));
    reads.wiring.mockResolvedValue(wiring.filter(row => row.stage !== "S3"));
    const result = await html();
    expect(result).toContain("Evidence gap extraction");
    expect(result).toContain("Saved route unavailable");
    expect(result).toContain("Module configuration unavailable");
  });
  it("sanitizes unexpected route resolution errors", async () => {
    reads.resolve.mockRejectedValue(new Error("query select secret from private_table"));
    const result = await html();
    expect(result).toContain("Route preview unavailable");
    expect(result).not.toContain("private_table");
  });
  it("distinguishes missing credentials from unexpected resolution failures", async () => {
    reads.resolve.mockRejectedValue(new NoRouteError("unsafe provider detail"));
    const result = await html();
    expect(result).toContain("No provider is ready. Add a provider credential and select a compatible model here.");
    expect(result).not.toContain("unsafe provider detail");
  });
  it("shows a known fallback without copying resolver diagnostic text", async () => {
    reads.resolve.mockResolvedValue({ provider_label: "OpenAI", model: "gpt-4.1", degraded: true, reason: "raw select query private_table" });
    const result = await html();
    expect(result).toContain("The preferred provider is unavailable. Check its credentials and model here before restoring it.");
    expect(result).not.toContain("private_table");
  });
  it("keeps a stage preview available when a different stage fails resolution", async () => {
    reads.resolve.mockImplementation(async stage => {
      if (stage === "S2") throw new Error("private_table");
      return { provider_label: "Confirmed provider", model: "confirmed-model", degraded: false };
    });
    const result = await html();
    expect(result).toContain("Route preview unavailable");
    expect(result).toContain("Confirmed provider");
  });
  it("shows intentional master-off without attempting resolution", async () => {
    reads.master.mockResolvedValue({ enabled: false, updated_by: null, updated_at: null, rationale: null });
    const result = await html();
    expect(result).toContain("AI is off for this task. Enable it here when you are ready to use AI.");
    expect(reads.resolve).not.toHaveBeenCalled();
  });
});
