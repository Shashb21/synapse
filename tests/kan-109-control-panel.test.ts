/** @vitest-environment jsdom */
/** Routing regressions: persisted values, drafts, and accessible operation feedback. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { RoutingPanel, type StageRouteView } from "@/components/platform/routing-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const providers = [
  { id: "xai-grok", label: "xAI · Grok", models: ["grok-4"], default_model: "grok-4", auth: "api_key" as const },
  { id: "anthropic-claude", label: "Anthropic · Claude", models: ["claude-sonnet"], default_model: "claude-sonnet", auth: "api_key" as const },
];
const route: StageRouteView = {
  stage: "S2", stage_title: "S2 · Evidence gap extraction", module_id: "extract", module_version: "1",
  available_modules: [], agentic: true, provider_id: "xai-grok", model: "grok-4", temperature: 0,
  max_tokens: 8192, fallbacks: ["anthropic-claude"], updated_by: "owner", updated_at: "initial",
  resolved_label: "xAI · Grok · grok-4", degraded_reason: null,
};
let root: Root;
let container: HTMLDivElement;
function render(next = route) {
  act(() => root.render(createElement(RoutingPanel, { routes: [next], providers, canRoute: true, canActivate: true })));
}
function selectProvider(value: string) {
  act(() => {
    const select = container.querySelector("select")!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function saveButton() { return [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Save route"))!; }
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  router.refresh.mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("KAN-109 route forms", () => {
  it("replaces a stale draft when a bulk action supplies persisted routing", () => {
    render();
    selectProvider("anthropic-claude");
    // Bulk action saved Grok again: even an unchanged provider must reset the draft.
    render({ ...route, updated_at: "bulk-change" });
    expect(container.querySelector("select")!.value).toBe("xai-grok");
    expect(container.querySelectorAll("select")[1].value).toBe("grok-4");
  });
  it("preserves unsaved edits across a refresh with unchanged persisted settings", () => {
    render(); selectProvider("anthropic-claude"); render({ ...route });
    expect(container.querySelector("select")!.value).toBe("anthropic-claude");
  });
  it("preserves a routing draft when the active implementation changes", () => {
    render(); selectProvider("anthropic-claude");
    render({ ...route, module_id: "extract-v2", module_version: "2" });
    expect(container.querySelector("select")!.value).toBe("anthropic-claude");
    expect(container.querySelectorAll("select")[1].value).toBe("claude-sonnet");
  });
  it("announces a successful save and clears it on the next edit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    render(); await act(async () => saveButton().click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
    selectProvider("anthropic-claude");
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Saved");
  });
  it("announces errors, retains the draft, and allows retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(); selectProvider("anthropic-claude"); await act(async () => saveButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Check your connection");
    expect(container.querySelector("select")!.value).toBe("anthropic-claude");
    expect(saveButton().disabled).toBe(false);
  });
  it("locks route fields while saving so the response cannot overwrite newer typing", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(done => { resolve = done; })));
    render(); await act(async () => saveButton().click());
    expect(container.querySelector("select")!.disabled).toBe(true);
    await act(async () => resolve({ ok: true, json: async () => ({ ok: true }) }));
    expect(container.querySelector("select")!.disabled).toBe(false);
  });
  it("does not claim a model route for a stage that does not use AI", () => {
    render({ ...route, agentic: false });
    expect(container.textContent).not.toContain("Resolves to");
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("Does not use AI");
  });
});

describe("KAN-109 server results and permissions", () => {
  it("shows server-normalized numbers and fallbacks after saving", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      config: { params: { temperature: 0.4, max_tokens: 2048 }, fallbacks: [] },
    }) }));
    render(); await act(async () => saveButton().click());
    expect([...container.querySelectorAll("input")].map(input => input.value)).toEqual(["0.4", "2048", ""]);
  });
  it("keeps controls read-only without routing permission", () => {
    act(() => root.render(createElement(RoutingPanel, { routes: [route], providers, canRoute: false, canActivate: false })));
    expect([...container.querySelectorAll("select, input, button")].every(control => (control as HTMLInputElement).disabled)).toBe(true);
  });
  it("announces validation failure and succeeds on retry without losing the draft", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ safe_error: true, request_outcome: "rejected", error: "Choose an available model." }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(); selectProvider("anthropic-claude"); await act(async () => saveButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Choose an available model.");
    await act(async () => saveButton().click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
    expect(JSON.parse(fetch.mock.calls[1][1].body).provider_id).toBe("anthropic-claude");
  });
});
