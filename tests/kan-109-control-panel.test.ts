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
  { id: "openai", label: "OpenAI · ChatGPT", models: ["gpt-4.1"], default_model: "gpt-4.1", auth: "api_key" as const },
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
    render({ ...route, fallbacks: [] }); selectProvider("anthropic-claude"); await act(async () => saveButton().click());
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
    expect([...container.querySelectorAll("input")].map(input => input.value)).toEqual(["0.4", "2048"]);
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
    render({ ...route, fallbacks: [] }); selectProvider("anthropic-claude"); await act(async () => saveButton().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Choose an available model.");
    await act(async () => saveButton().click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
    expect(JSON.parse(fetch.mock.calls[1][1].body).provider_id).toBe("anthropic-claude");
  });
});


function namedButton(name: string) { return [...container.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === name || button.textContent === name)!; }
function changeSelect(label: string, value: string) {
  act(() => {
    const control = container.querySelector(`select[aria-label="${label}"]`)! as HTMLSelectElement;
    control.value = value; control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("KAN-194 ordered backups", () => {
  it("adds named providers and saves explicit empty arrays after removal", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch); render({ ...route, fallbacks: [] });
    expect(container.textContent).toContain("No backup provider; the stage fails if the chosen provider cannot run");
    changeSelect("Backup provider to add", "anthropic-claude");
    act(() => namedButton("Add backup").click());
    await act(async () => saveButton().click());
    expect(JSON.parse(fetch.mock.calls[0][1].body).fallbacks).toEqual(["anthropic-claude"]);
    act(() => namedButton("Remove backup 1: Anthropic · Claude").click());
    await act(async () => saveButton().click());
    expect(JSON.parse(fetch.mock.calls[1][1].body).fallbacks).toEqual([]);
  });
  it("preserves invalid stored choices visibly until explicitly corrected", () => {
    render({ ...route, provider_id: "retired", model: "retired-model", fallbacks: ["unknown", "anthropic-claude", "anthropic-claude"] });
    expect(container.querySelector("select")!.value).toBe("retired");
    expect(container.querySelectorAll("select")[1].value).toBe("retired-model");
    expect(container.textContent).toContain("Unknown or disallowed provider");
    expect(container.textContent).toContain("Duplicate backup");
    expect(container.textContent).toContain("Backup configuration needs correction");
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelectorAll("ol li")).toHaveLength(3);
  });
  it("never drops a backup when it becomes the primary provider", () => {
    render(); selectProvider("anthropic-claude");
    expect(container.querySelectorAll("ol li")).toHaveLength(1);
    expect(container.textContent).toContain("also the primary provider");
    expect(saveButton().disabled).toBe(true);
  });
  it("keeps ordered backup drafts across unchanged and unavailable refreshes", () => {
    render(); act(() => namedButton("Remove backup 1: Anthropic · Claude").click());
    render({ ...route }); expect(container.querySelectorAll("ol li")).toHaveLength(0);
    render({ ...route, config_available: false, fallbacks: null });
    expect(container.querySelectorAll("ol li")).toHaveLength(0);
    expect(saveButton().disabled).toBe(true);
  });
  it("leads with the business stage and omits non-model route authorship and module metadata", () => {
    render({ ...route, agentic: false });
    expect(container.querySelector("h3")?.textContent).toBe("Evidence gap extraction");
    expect(container.textContent).not.toContain("Last set by");
    expect(container.textContent).not.toContain("extract · v1");
  });
});


describe("KAN-194 ordering and locks", () => {
  it("moves backups in both directions and sends their displayed order", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch); render();
    changeSelect("Backup provider to add", "openai"); act(() => namedButton("Add backup").click());
    act(() => namedButton("Move backup 2: OpenAI · ChatGPT up").click());
    expect([...container.querySelectorAll("ol li > span")].map(row => row.textContent)).toEqual(["1. OpenAI · ChatGPT", "2. Anthropic · Claude"]);
    await act(async () => saveButton().click());
    expect(JSON.parse(fetch.mock.calls[0][1].body).fallbacks).toEqual(["openai", "anthropic-claude"]);
    act(() => namedButton("Move backup 1: OpenAI · ChatGPT down").click());
    await act(async () => saveButton().click());
    expect(JSON.parse(fetch.mock.calls[1][1].body).fallbacks).toEqual(["anthropic-claude", "openai"]);
  });
  it("locks every backup action while saving", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(done => { resolve = done; })));
    render(); await act(async () => saveButton().click());
    expect([...container.querySelectorAll("fieldset button, fieldset select")].every(control => (control as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => resolve({ ok: true, json: async () => ({ ok: true }) }));
    expect(namedButton("Remove backup 1: Anthropic · Claude").disabled).toBe(false);
  });
  it("shows invalid model and disallowed backups without selecting a replacement", () => {
    render({ ...route, model: "removed-model", fallbacks: ["deterministic-local"] });
    expect(container.querySelectorAll("select")[1].value).toBe("removed-model");
    expect(container.textContent).toContain("Saved model is unavailable");
    expect(container.textContent).toContain("deterministic-local");
    expect(saveButton().disabled).toBe(true);
  });
});


describe("KAN-194 setting explanations", () => {
  it("explains answer variation, output tokens and actual adapter support", () => {
    const withSupport = providers.map(provider => ({ ...provider, temperature_unsupported_models: provider.models }));
    act(() => root.render(createElement(RoutingPanel, { routes: [route], providers: withSupport, canRoute: true, canActivate: true })));
    expect(container.textContent).toContain("Answer variation");
    expect(container.textContent).toContain("tokens are small pieces of text, not words");
    expect(container.textContent).toContain("adapter omits it from requests");
  });
});
