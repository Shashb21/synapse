/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PriorityReviewControls } from "@/components/accuracy/priority-review-controls";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/platform/ai-status", () => ({ useAiEnabled: () => true }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const axes = [
  { id: "decision_impact", label: "Impact", higher_is_priority: true },
  { id: "time_pressure", label: "Urgency", higher_is_priority: true },
  { id: "effort_cost", label: "Effort", higher_is_priority: false },
  { id: "payer_value", label: "Payer value", higher_is_priority: true },
];
const config = { revision: "global", catalog: { axes, x_axis: "decision_impact", y_axis: "time_pressure" }, scopes: {
  all: { x_axis: "decision_impact", y_axis: "time_pressure" }, nsclc: { x_axis: "effort_cost", y_axis: "payer_value" },
} };
function read(x = "decision_impact", y = "time_pressure", setting = "all") {
  return { eligible: true, config, expected_input_revision: `facts-${setting}`, expected_config_revision: `pair-${x}-${y}`,
    axes: axes.filter(axis => [x, y].includes(axis.id)), x_axis: x, y_axis: y, pair_chosen: true,
    context: {}, considerations: {}, references: [], limitations: [], placements: [{ gap_id: "gap", band: "high", suggested_band: "high", human_revision: "human", history: [], axis_scores: {},
      selection: { setting: "all", x_axis: "decision_impact", y_axis: "time_pressure" } }] };
}
async function click(name: string) {
  const button = [...host.querySelectorAll("button")].find(row => row.textContent === name)!;
  expect(button, name).toBeDefined(); expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
async function enter(label: string, value: string) {
  const field = [...host.querySelectorAll("label")].find(row => row.textContent?.startsWith(label))!.querySelector("input,textarea,select") as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function open() { await act(async () => root.render(createElement(PriorityReviewControls, { workspaceId: "ws", gapId: "gap" }))); await click("Review S8 priority"); }

it("switches only Setting to its saved pair despite the stored placement's prior axes, then suggests and validates on that pair", async () => {
  const posted: Record<string, unknown>[] = [];
  const reads: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options) { posted.push(JSON.parse(String(options.body))); return { ok: true, json: async () => ({ ok: true, suggestions: [], skipped: [] }) }; }
    const query = new URL(url, "http://localhost"); reads.push(query);
    return { ok: true, json: async () => query.searchParams.has("gap_id") ? read(query.searchParams.get("x_axis") ?? undefined, query.searchParams.get("y_axis") ?? undefined, query.searchParams.get("setting") ?? "all") : { config } };
  }));
  await open();
  await enter("Setting", "nsclc"); await click("Reload current priority inputs");
  expect(host.textContent).toContain("Effort (lower is higher priority)");
  const gapRead = reads.filter(url => url.searchParams.get("setting") === "nsclc" && url.searchParams.has("gap_id")).at(-1)!;
  expect(gapRead.searchParams.get("x_axis")).toBe("effort_cost");
  expect(gapRead.searchParams.get("y_axis")).toBe("payer_value");
  await click("Suggest S8 priority");
  await enter("S8 rationale", "Use this setting's saved effort and payer priorities");
  await click("Validate working priority");
  expect(posted.find(row => row.action === "suggest")).toMatchObject({ setting: "nsclc", x_axis: "effort_cost", y_axis: "payer_value" });
  expect(posted.find(row => row.action === "validate")).toMatchObject({ setting: "nsclc", x_axis: "effort_cost", y_axis: "payer_value", expected_input_revision: "facts-nsclc", expected_config_revision: "pair-effort_cost-payer_value" });
});

it("labels a deliberate custom pair as unsaved until the human saves that setting's configuration", async () => {
  let currentConfig = { ...config, scopes: { ...config.scopes } };
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options) {
      const body = JSON.parse(String(options.body)); posted.push(body);
      if (body.action === "configure") currentConfig = { ...currentConfig, revision: "updated-global", scopes: { ...currentConfig.scopes, all: { x_axis: body.x_axis, y_axis: body.y_axis } } };
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const query = new URL(url, "http://localhost");
    return { ok: true, json: async () => ({ ...read(query.searchParams.get("x_axis") ?? undefined, query.searchParams.get("y_axis") ?? undefined), config: currentConfig }) };
  }));
  await open(); expect(host.textContent).toContain("Saved axis pair");
  await enter("Horizontal axis", "effort_cost"); await click("Reload current priority inputs");
  expect(host.textContent).toContain("Custom axis pair — not saved for this setting");
  expect(host.textContent).not.toContain("Saved axis pair");
  await enter("Configuration rationale", "Save this explicit alternative axis pair"); await click("Save Accuracy configuration");
  expect(posted.find(row => row.action === "configure")).toMatchObject({ scope: "all", x_axis: "effort_cost", y_axis: "time_pressure", expected_config_revision: "global" });
  expect(host.textContent).toContain("Saved axis pair");
  expect(host.textContent).not.toContain("Custom axis pair");
});

it.each(["network", "http"])("does not resurrect an R1 fresh candidate after a %s failed reload and a successful R2 retry", async failure => {
  let revision = "R1", failRead = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options) return { ok: true, json: async () => ({ suggestions: [{ gap_id: "gap", suggested_band: "defer", rationale: `${revision} candidate` }], skipped: [] }) };
    if (failRead && failure === "network") throw new Error("Disconnected");
    if (failRead) return { ok: false, json: async () => ({ error: "Read failed" }) };
    return { ok: true, json: async () => ({ ...read(), expected_input_revision: revision }) };
  }));
  await open(); await click("Suggest S8 priority");
  expect(host.textContent).toContain("Fresh suggestion: defer · R1 candidate");
  failRead = true; await click("Reload current priority inputs");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Fresh suggestion: defer · R1 candidate");
  revision = "R2"; failRead = false; await click("Reload current priority inputs");
  expect(host.textContent).not.toContain("Fresh suggestion: defer · R1 candidate");
  await enter("S8 rationale", "Human reviews current R2 evidence");
  expect([...host.querySelectorAll("button")].find(row => row.textContent === "Validate working priority")!.disabled).toBe(false);
  await click("Suggest S8 priority");
  expect(host.textContent).toContain("Fresh suggestion: defer · R2 candidate");
});
