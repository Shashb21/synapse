/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GapPriorityActions } from "@/components/prioritize/gap-priority-actions";
import { AxisChooser, PrioritizeMatrix, type PrioritizeGap } from "@/components/prioritize/prioritize-matrix";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const axes = [
  { id: "impact", label: "Impact", description: "Impact", weight: 1, low_label: "Low", high_label: "High" },
  { id: "urgency", label: "Urgency", description: "Urgency", weight: 1, low_label: "Low", high_label: "High" },
];
const identity = { signed_in: true, actor_name: "Reviewer", actor_function: "medical_affairs" as const };
const gap: PrioritizeGap = { gap_id: "g1", gap_name: "Evidence gap", statement: "", domain_label: "Efficacy", settings: [], tactic_count: 0, axis_scores: { impact: 80, urgency: 80 }, band: "high", validated: false, suggested_band: null, suggested_rationale: null, rationale: null, actor_name: null, at: null };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
function actions(mayPrioritize = true) { act(() => root.render(createElement(GapPriorityActions, { gap, xAxis: axes[0], yAxis: axes[1], identity, mayPrioritize }))); }
async function click(text: string) { const button = [...document.querySelectorAll("button")].find(button => button.textContent === text)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
async function submit(confirm: boolean, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ok ? { ok: true, placement: { validated: confirm } } : { safe_error: true, request_outcome: "rejected", error: "Save refused" }), { status: ok ? 200 : 409 })));
  await click("Edit scores");
  const form = document.querySelector("form")!;
  (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Reviewed evidence";
  (form.querySelector('[name="validate"]') as HTMLSelectElement).value = confirm ? "yes" : "no";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
it("groups the sequence around axes and placement, with AI off", () => {
  act(() => root.render(createElement(PrioritizeMatrix, { scope: "all", gaps: [gap], axes, xAxis: axes[0], yAxis: axes[1], identity, mayPrioritize: true })));
  const headings = [...host.querySelectorAll("h2")].map(node => node.textContent);
  expect(headings).toEqual(expect.arrayContaining(["1. Choose axes", "2. Review placement"]));
  expect(host.textContent).toContain("Changing axes changes the plotted view");
  const help = [...host.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "How matrix placement works")!;
  expect(help).toBeTruthy();
  expect(help.open).toBe(false);
  const axisChoices = [...host.querySelectorAll('[data-testid="matrix-axes"] select')].map(node => (node as HTMLSelectElement).value);
  expect(axisChoices).toHaveLength(2);
  act(() => help.querySelector("summary")!.click());
  expect(help.open).toBe(true);
  expect(help.textContent).toContain("The quadrant only suggests a priority");
  expect([...host.querySelectorAll('[data-testid="matrix-axes"] select')].map(node => (node as HTMLSelectElement).value)).toEqual(axisChoices);
  expect(router.refresh).not.toHaveBeenCalled();
  expect(host.textContent).not.toMatch(/Re-suggest|AI/);
});
it("keeps axis choices mounted when optional placement help opens and closes", () => {
  act(() => root.render(createElement(AxisChooser, { scope: "all", scopeLabel: "all settings", axes, gapIds: ["g1"], identity, mayPrioritize: true, submitLabel: "Place gaps" })));
  const details = host.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  const selects = host.querySelectorAll("select");
  expect(details.open).toBe(false);
  expect(host.textContent).toContain("Saved priorities apply across all settings");
  act(() => {
    selects[0]!.value = "impact";
    selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    selects[1]!.value = "urgency";
    selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    summary.click();
  });
  expect(details.open).toBe(true);
  act(() => summary.click());
  expect(details.open).toBe(false);
  expect(host.querySelectorAll("select")[0]?.value).toBe("impact");
  expect(host.querySelectorAll("select")[1]?.value).toBe("urgency");
  expect(router.refresh).not.toHaveBeenCalled();
});
it.each([false, true])("reports a successful placement distinctly when confirm=%s", async confirm => {
  actions(); await submit(confirm);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(confirm ? "Priority validated across all settings." : "Draft placement saved. Validate priority when you are ready.");
  expect(router.refresh).toHaveBeenCalledTimes(1);
  // The action stays mounted as GapPanel receives refreshed server data.
  actions();
  expect(host.querySelector('[role="status"]')?.textContent).toContain(confirm ? "Priority validated" : "Draft placement saved");
});
it("keeps a refused save open without success feedback", async () => {
  actions(); await submit(false, false);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Save refused");
  expect(host.querySelector('[role="status"]')?.textContent ?? "").toBe("");
  expect(router.refresh).not.toHaveBeenCalled();
});
it("hides mutation controls from a view-only role", () => {
  actions(false);
  expect(host.querySelector("button")).toBeNull();
  expect(host.textContent).not.toMatch(/AI/);
});

it("confirms an existing draft with a reason and reports confirmation", async () => {
  actions();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  await click("Validate priority");
  const form = document.querySelector("form")!;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("reason is required");
  expect(router.refresh).not.toHaveBeenCalled();
  (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Reviewed all settings";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Priority validated across all settings.");
});
it("clears the previous success when a later save fails", async () => {
  actions(); await submit(false);
  await submit(true, false);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Save refused");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("");
});
it("saves a keyboard move only after explicit review and reports the saved placement", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  act(() => root.render(createElement(PrioritizeMatrix, { scope: "all", gaps: [gap], axes, xAxis: axes[0], yAxis: axes[1], identity, mayPrioritize: true })));
  const point = host.querySelector('button[data-gap-id="g1"]')!;
  await act(async () => point.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(fetch).not.toHaveBeenCalled();
  const form = document.querySelector("form")!;
  (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Reviewed new placement";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Matrix placement saved as a draft.");
  expect(router.refresh).toHaveBeenCalledTimes(1);
});

it("explains review and confirmation in the axis chooser without AI", () => {
  act(() => root.render(createElement(AxisChooser, { scope: "all", scopeLabel: "all settings", axes, gapIds: [gap.gap_id], identity, mayPrioritize: false, submitLabel: "Prioritize" })));
  expect(host.querySelector("h2")?.textContent).toContain("1. Choose axes");
  expect(host.textContent).toContain("Review placement, then validate priority with your reason");
  expect(host.textContent).not.toMatch(/AI|model/);
  expect((host.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
});
it("keeps failed matrix moves in review without a success message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ safe_error: true, request_outcome: "rejected", error: "Move refused" }), { status: 409 })));
  act(() => root.render(createElement(PrioritizeMatrix, { scope: "all", gaps: [gap], axes, xAxis: axes[0], yAxis: axes[1], identity, mayPrioritize: true })));
  const point = host.querySelector('button[data-gap-id="g1"]')!;
  await act(async () => point.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  const form = document.querySelector("form")!;
  (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Reviewed new placement";
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Move refused");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  expect(router.refresh).not.toHaveBeenCalled();
});

it("reports the server confirmation retained by an edit with no new confirmation", async () => {
  actions();
  await click("Edit scores");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, placement: { validated: true } }), { status: 200 })));
  const form = document.querySelector("form")!;
  (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Fine-tuned existing scores";
  expect((form.querySelector('[name="validate"]') as HTMLSelectElement).value).toBe("no");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Priority validated across all settings.");
});

it("names priority validation separately from an evidence assessment", () => {
  actions();
  expect(host.querySelector("h3")?.textContent).toBe("3. Validate priority");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Validate priority")).toBe(true);
  expect(host.textContent).not.toContain("Confirm evidence assessment");
});
