/** @vitest-environment jsdom */
/** Arrange draft state, act through controls, and assert credential/save/refresh feedback. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { RoutingPanel, type StageRouteView } from "@/components/platform/routing-panel";
import { ProviderPanel, type ProviderKeyCardView } from "@/components/platform/provider-panel";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const providers = [
  { id: "xai-grok", label: "xAI · Grok", models: ["grok-4"], default_model: "grok-4", auth: "api_key" as const, status: "missing" as const },
  { id: "anthropic-claude", label: "Anthropic · Claude", models: ["claude-sonnet"], default_model: "claude-sonnet", auth: "api_key" as const, status: "configured" as const },
];
const route: StageRouteView = {
  stage: "S2", stage_title: "S2 · Evidence gap extraction", module_id: "extract", module_version: "1", available_modules: [], agentic: true,
  provider_id: "xai-grok", model: "grok-4", temperature: 0, max_tokens: 8192, fallbacks: [], updated_by: "owner", updated_at: "initial", resolved_label: "No configured provider", degraded_reason: null,
};
const connections: ProviderKeyCardView[] = providers.map(provider => ({ ...provider, provider_id: provider.id, summary: "Cloud provider", tier: null, key_env: null }));
const mixedSnapshot = JSON.stringify([route, { ...route, stage: "S3", provider_id: "anthropic-claude" }]);
const claudeSnapshot = JSON.stringify([route, { ...route, stage: "S3" }].map(saved => ({ ...saved, provider_id: "anthropic-claude", fallbacks: ["xai-grok"], updated_at: "bulk-save" })));
let root: Root;
let container: HTMLDivElement;
function render(next = route, keys = providers) {
  act(() => root.render(createElement(RoutingPanel, { routes: [next], providers, credentials: keys, canRoute: true, canActivate: true })));
}
function selectProvider(id: string) {
  act(() => { const select = container.querySelector("select")!; select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
function renderBulk(routedTo: string | null, routingSnapshot: string | null, routingKnown = true, keys = connections) {
  act(() => root.render(createElement(ProviderPanel, { connections: keys, defaults: { primary: "xai-grok", alternate: "anthropic-claude" }, canRoute: true, routedTo, routingSnapshot, routingKnown })));
}
async function saveBulkClaude() {
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Anthropic"))!.click());
}
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); router.refresh.mockClear(); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("describes edited provider credentials adjacent to the draft", () => {
  render();
  expect(container.querySelector('[data-testid="route-credential-readiness"]')?.textContent).toContain("No configured provider");
  selectProvider("anthropic-claude");
  expect(container.querySelector('[data-testid="route-credential-readiness"]')?.textContent).toContain("Primary key configured");
});
it("describes saved preferences and missing credentials without blocking a future route", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  render();
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Save route"))!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("No configured provider");
  expect(router.refresh).toHaveBeenCalled();
});
it("updates credential feedback after refresh without discarding an unchanged draft", () => {
  render(); selectProvider("anthropic-claude");
  render({ ...route }, providers.map(provider => ({ ...provider, status: "missing" as const })));
  expect(container.querySelector("select")!.value).toBe("anthropic-claude");
  expect(container.querySelector('[data-testid="route-credential-readiness"]')?.textContent).toContain("No configured provider");
});
it("bulk actions describe the selected provider's credential consequence", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  renderBulk(null, mixedSnapshot);
  expect(container.textContent).toContain("Key presence only");
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("xAI"))!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("configured fallback Anthropic · Claude");
});

it("retires the bulk-save notice after mixed routes return following a confirmed save", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  renderBulk(null, mixedSnapshot);
  await saveBulkClaude();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences: every stage routes to Anthropic · Claude");
  renderBulk("anthropic-claude", claudeSnapshot);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences");
  renderBulk(null, mixedSnapshot);
  expect(container.querySelector('[data-testid="providers-routed-to"]')?.textContent).toContain("Stages use a mix");
  expect(container.querySelector('[role="status"]')).toBeNull();
  renderBulk("anthropic-claude", claudeSnapshot);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("permanently retires the bulk-save notice when routes return to the prior provider", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  const grokSnapshot = JSON.stringify([{ ...route }]);
  renderBulk("xai-grok", grokSnapshot);
  await saveBulkClaude();
  renderBulk("anthropic-claude", claudeSnapshot);
  renderBulk("xai-grok", grokSnapshot);
  expect(container.querySelector('[role="status"]')).toBeNull();
  renderBulk("anthropic-claude", claudeSnapshot);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it.each([false, true])("retires the bulk-save notice on an unavailable routing refresh (target observed: %s)", async targetObserved => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  renderBulk(null, mixedSnapshot);
  await saveBulkClaude();
  if (targetObserved) renderBulk("anthropic-claude", claudeSnapshot);
  renderBulk(null, null, false);
  expect(container.querySelector('[data-testid="providers-routed-to"]')?.textContent).toBe("Routing configuration unavailable.");
  expect(container.querySelector('[role="status"]')).toBeNull();
  renderBulk("anthropic-claude", claudeSnapshot);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("retires bulk feedback when saved fallbacks change while the primary provider stays the same", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  renderBulk(null, mixedSnapshot);
  await saveBulkClaude();
  renderBulk("anthropic-claude", claudeSnapshot);
  const editedSnapshot = JSON.stringify(JSON.parse(claudeSnapshot).map((saved: StageRouteView) => ({ ...saved, fallbacks: [], updated_at: "stage-save" })));
  renderBulk("anthropic-claude", editedSnapshot);
  expect(container.querySelector('[role="status"]')).toBeNull();
  renderBulk("anthropic-claude", claudeSnapshot);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("keeps immediate bulk feedback through credential-only refreshes and updates its consequence", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  renderBulk(null, mixedSnapshot);
  await saveBulkClaude();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Primary key configured");
  renderBulk(null, mixedSnapshot, true, [...connections]);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences");
  renderBulk("anthropic-claude", claudeSnapshot);
  renderBulk("anthropic-claude", claudeSnapshot, true, connections.map(connection => ({ ...connection, status: "missing" })));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("No configured provider");
});

it("keeps a primary-as-backup visible until the owner explicitly removes it", () => {
  render({ ...route, fallbacks: ["anthropic-claude"] });
  selectProvider("anthropic-claude");
  expect(container.querySelector("li")?.textContent).toContain("Anthropic · Claude");
  expect(container.textContent).toContain("This backup is also the primary provider");
  const save = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Save route"))!;
  expect(save.disabled).toBe(true);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove backup 1: Anthropic · Claude"]')!.click());
  expect(container.querySelector("li")).toBeNull();
  expect(save.disabled).toBe(false);
});

it("retires a route-save confirmation on unknown settings without losing the draft", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  render(); selectProvider("anthropic-claude");
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Save route"))!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved preferences");
  render({ ...route, config_available: false, provider_id: null, model: null, fallbacks: null });
  expect(container.querySelector("select")!.value).toBe("anthropic-claude");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved route unavailable");
  render(route);
  expect(container.querySelector("select")!.value).toBe("anthropic-claude");
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Saved preferences");
});
it("disables bulk replacement and retires its notice when a refreshed route list is incomplete", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  renderBulk(null, mixedSnapshot);
  await saveBulkClaude();
  act(() => root.render(createElement(ProviderPanel, { connections, defaults: { primary: "xai-grok", alternate: "anthropic-claude" }, canRoute: true, routedTo: "anthropic-claude", routingSnapshot: claudeSnapshot, routesAvailable: false })));
  expect([...container.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
});
