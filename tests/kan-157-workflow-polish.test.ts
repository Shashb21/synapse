/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { parsePlanningContext } from "@/lib/iegp/planning-context";
import { ChoiceField } from "@/components/setup/setup-fields";
import { ActionDialog } from "@/components/platform/action-dialog";
import { AddSourceForm } from "@/components/add-source-form";
import { TimelineBoard } from "@/components/timeline/timeline-board";
import { buildSeed } from "@/lib/iegp/seed";
import { buildTimeline } from "@/modules/stages/s10-timeline/build";
import { gapTimelineView } from "@/modules/stages/s10-timeline/gap-view";
import { AddTacticsButton, CreateTacticButton } from "@/components/plan-cards";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/setup", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/lock-form", () => ({ LockForm: ({children}: {children: React.ReactNode}) => createElement("form", null, children) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("uses isolated native radio groups and returns the original numeric choice", () => {
  const change = vi.fn();
  const props = {label: "Importance", value: 1, options: [{id: 1, label: "Low"}, {id: 2, label: "High"}], onChange: change};
  act(() => root.render(createElement("div", null, createElement(ChoiceField<number>, props), createElement(ChoiceField<number>, props))));
  const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(inputs).toHaveLength(4);
  expect(inputs[0].name).toBe(inputs[1].name);
  expect(inputs[0].name).not.toBe(inputs[2].name);
  expect(inputs[0].checked).toBe(true);
  act(() => inputs[1].click());
  expect(change).toHaveBeenCalledWith(2);
});

it.each([["existing", AddTacticsButton], ["new", CreateTacticButton]] as const)("keeps %s manual tactic labels visible after typing", (_name, Component) => {
  act(() => root.render(createElement(Component)));
  for (const [name, text] of [["name", "Tactic name"], ["evidence_question", "Evidence question"]]) {
    const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    input.value = "Typed value";
    expect(input.labels?.[0]?.textContent).toContain(text);
  }
});

it("provides a visible file label focus treatment for the native input", () => {
  act(() => root.render(createElement(AddSourceForm)));
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input.labels?.[0]?.textContent).toContain("Choose file");
  expect(input.classList.contains("peer")).toBe(true);
  expect(input.labels?.[0]?.className).toContain("peer-focus-visible:ring-2");
});

it("marks required fields and associates the failed field with the displayed error", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  act(() => root.render(createElement(ActionDialog, {endpoint: "/unused", payload: {}, label: "Edit", open: true, trigger: null, identity: {signed_in: true, actor_name: "Reviewer", actor_function: "medical_affairs"}, fields: [{name: "name", label: "Activity name", required: true}, {name: "notes", label: "Notes", type: "textarea", required: true}, {name: "choice", label: "Choice", type: "select", required: true, options: [{value: "yes", label: "Yes"}]}]})));
  const form = document.querySelector("form")!;
  const rationale = form.querySelector<HTMLTextAreaElement>('[name="rationale"]')!;
  expect(rationale.required).toBe(true);
  for (const name of ["name", "notes", "choice"]) {
    const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    expect(input.required).toBe(true);
    expect(input.getAttribute("aria-required")).toBe("true");
  }
  await act(async () => form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  expect(rationale.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(rationale.getAttribute("aria-describedby")!)?.textContent).toContain("rationale is required");
  rationale.value = "Reviewed source";
  await act(async () => form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent).toBe("Activity name is required.");
  expect(rationale.getAttribute("aria-invalid")).not.toBe("true");
  expect(fetch).not.toHaveBeenCalled();
});


it("keeps the blocker count visible and exposes every blocker and link inside a disclosure", () => {
  const state = buildSeed();
  const model = buildTimeline({state, placements: [], overrides: []});
  const view = gapTimelineView({state, model, placements: [], today: "2026-10-21"});
  const gapBlockers = Array.from({length: 12}, (_, index) => ({issue: "unconfirmed" as const, gap_id: `gap-${index}`, message: `Review gap ${index}`}));
  act(() => root.render(createElement(TimelineBoard, {model, view, today: "2026-10-21", identity: {signed_in: true, actor_name: "Reviewer", actor_function: "medical_affairs"}, plan: null, history: [], canSaveFinal: true, canReschedule: false, gapDomains: {}, gapBlockers})));
  const checklist = host.querySelector<HTMLDetailsElement>('details[data-testid="final-save-checklist"]')!;
  expect(checklist).not.toBeNull();
  expect(checklist.open).toBe(false);
  expect(checklist.querySelector("summary")?.textContent).toContain("12 items");
  expect(checklist.querySelector("summary")?.textContent).toContain("saved as final");
  act(() => checklist.querySelector("summary")!.click());
  expect(checklist.open).toBe(true);
  expect(checklist.querySelectorAll('[data-testid="final-gap-blocker"]')).toHaveLength(12);
  expect(checklist.querySelector('a[href="/gaps/gap-11"]')?.textContent).toBe("Review gap 11");
});


it("changes completed setup from timestamp unavailable to unsaved edits, then the server save time", async () => {
  const initial = parsePlanningContext({asset_name: "Nova", therapeutic_area: "Immunology", indications: [{name: "Psoriasis", status: "current"}], markets: ["US"], lifecycle_stage: "growth"});
  const saved = {...initial, asset_name: "Nova revised", saved_at: "2026-10-21T10:00:00.000Z"};
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({context: saved}), {status: 200})));
  act(() => root.render(createElement(SetupWizard, {initial, actorName: "Reviewer", actorFunction: "medical_affairs", setupComplete: true})));
  expect(host.querySelector('[data-testid="setup-saved-at"]')?.textContent).toBe("Saved · time unavailable");
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="setup-summary-asset"] button')!.click());
  const input = [...host.querySelectorAll<HTMLInputElement>("input")].find(input => input.value === "Nova")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Nova revised");
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
  expect(host.querySelector('[data-testid="setup-saved-at"]')?.textContent).toBe("Unsaved changes");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Continue")!.click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-testid="setup-saved-at"]')?.textContent).toBe(`Saved ${new Date(saved.saved_at).toLocaleString()}`);
});
