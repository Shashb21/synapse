/** @vitest-environment jsdom */
/** Retry feedback and editable drafts survive unavailable server refreshes. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { ConfigurationRecovery } from "@/components/platform/configuration-recovery";
import { RoutingPanel, type StageRouteView } from "@/components/platform/routing-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const providers = [
  { id: "xai-grok", label: "Grok", models: ["grok-4"], default_model: "grok-4", auth: "api_key" as const },
  { id: "openai", label: "OpenAI", models: ["gpt-4.1"], default_model: "gpt-4.1", auth: "api_key" as const },
];
const route: StageRouteView = {
  stage: "S2", stage_title: "Extraction", module_id: "v1", module_version: "1", available_modules: [
    { id: "v1", version: "1", title: "One" }, { id: "v2", version: "2", title: "Two" },
  ], agentic: true, provider_id: "xai-grok", model: "grok-4", temperature: 0, max_tokens: 16000,
  fallbacks: [], updated_by: "owner", updated_at: "first", resolved_label: "Grok", degraded_reason: null,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  router.refresh.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function recovery(loadId: string, unavailable: string[]) {
  act(() => root.render(createElement(ConfigurationRecovery, { loadId, unavailable })));
}
function routes(next = route, masterEnabled: boolean | null = null) {
  act(() => root.render(createElement(RoutingPanel, { routes: [next], providers, masterEnabled, canRoute: true, canActivate: true })));
}
function button(name: string) { return [...container.querySelectorAll("button")].find(button => button.textContent?.includes(name))!; }
function provider() { return container.querySelector("select")!; }
function changeProvider() { act(() => { provider().value = "openai"; provider().dispatchEvent(new Event("change", { bubbles: true })); }); }

describe("KAN-192 refresh", () => {
  it("announces pending, disables repeated retry, and confirms a new successful server response", async () => {
    let finish!: () => void;
    router.refresh.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    recovery("first", ["master"]);
    await act(async () => button("Retry configuration").click());
    expect(button("Retrying").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Reloading");
    recovery("confirmed", []);
    await act(async () => finish());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved settings are available");
    expect(button("Refresh configuration").disabled).toBe(false);
  });
  it("announces an explicit repeat failure on a new response and permits another retry", async () => {
    let finish!: () => void;
    router.refresh.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    recovery("first", ["routes"]);
    await act(async () => button("Retry configuration").click());
    recovery("still-failed", ["routes"]);
    await act(async () => finish());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("still unavailable");
    expect(button("Retry configuration").disabled).toBe(false);
  });
  it("never claims success when refresh finishes without a server response", async () => {
    recovery("first", ["routes"]);
    await act(async () => button("Retry configuration").click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("still unavailable");
    expect(container.textContent).not.toContain("Configuration refreshed");
  });
});

describe("KAN-192 independent safe edits", () => {
  it("retains a route draft through a failed read, disables save, and reconciles changed persisted settings on recovery", () => {
    routes(); changeProvider();
    routes({ ...route, config_available: false, provider_id: null, model: null, temperature: null, max_tokens: null, fallbacks: null, updated_by: null, updated_at: null });
    expect(provider().value).toBe("openai");
    expect(provider().disabled).toBe(true);
    expect(button("Save route").disabled).toBe(true);
    routes({ ...route, updated_at: "recovered" });
    expect(provider().value).toBe("xai-grok");
    expect(provider().disabled).toBe(false);
  });
  it("keeps routing usable when module wiring and the master state are unavailable", () => {
    routes({ ...route, wiring_available: false });
    expect(provider().disabled).toBe(false);
    expect(button("Save route").disabled).toBe(false);
    expect((container.querySelector('select[aria-label="Active implementation"]') as HTMLSelectElement).disabled).toBe(true);
    expect(container.textContent).not.toContain("AI is off,");
    expect(container.textContent).toContain("Master AI state unavailable");
  });
  it("does not display a provider default when no saved route was confirmed", () => {
    routes({ ...route, config_available: false, provider_id: null, model: null, temperature: null, max_tokens: null, fallbacks: null });
    expect(provider().value).toBe("");
    expect(provider().selectedOptions[0]?.textContent).toContain("Unavailable");
  });
  it("keeps activation usable when routing is unavailable", () => {
    routes({ ...route, config_available: false, provider_id: null, model: null, temperature: null, max_tokens: null, fallbacks: null });
    expect(button("Save route").disabled).toBe(true);
    expect((container.querySelector('select[aria-label="Active implementation"]') as HTMLSelectElement).disabled).toBe(false);
  });
  it("retains drafts across an unrelated unavailable refresh", () => {
    routes(); changeProvider(); routes({ ...route, wiring_available: false });
    expect(provider().value).toBe("openai");
  });
});
