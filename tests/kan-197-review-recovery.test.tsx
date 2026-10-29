/** @vitest-environment jsdom */
/** Lost replies must preserve drafts without enabling duplicate consequential writes. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogClose: () => null,
}));
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";
import { PlanIdeateAllButton, PlanPriorityCard } from "@/components/accuracy/plan-priority-card";
import { AdminWorkspacePicker } from "@/components/admin/admin-workspace-picker";
import { DemoResetBar } from "@/components/workspaces/demo-reset-bar";
import { CreateWorkspaceForm as CustomerCreate, WorkspacesView } from "@/components/workspaces/workspaces-view";
import { CreateWorkspaceForm as AccuracyCreate } from "@/components/accuracy/create-workspace-form";
import { GapSettingsEditor } from "@/components/gap-settings-editor";
import { ActivitySheetEditor } from "@/components/timeline/timeline-dialogs";
import { AiStatusProvider } from "@/components/platform/ai-status";
import type { TimelineActivity } from "@/modules/stages/s10-timeline/build";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks(); vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function render(node: ReactNode) { act(() => root.render(<AiStatusProvider enabled>{node}</AiStatusProvider>)); }
function button(label: string) { return [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!; }
function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => button(label).click()); }
async function submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
const priority = <PlanPriorityCard workspaceId="w" claimId="g" statement="Gap" priority="high" validated status="open" />;
const owners = [
  { name: "workshop snapshot", node: <WorkshopSaveCta workspaceId="w" ready blockers={[]} hasSnapshot={false} workshopHref="/workshop" />, prepare: async () => {}, run: () => click("Save state for workshop"), control: () => button("Save state for workshop"), check: "Check workshop state", draft: () => expect(container.textContent).toContain("Ready to save") },
  { name: "all-gap ideation", node: <PlanIdeateAllButton workspaceId="w" eligibleCount={1} />, prepare: async () => {}, run: () => click("Run LLM ideate (1 high open gap)"), control: () => button("Run LLM ideate (1 high open gap)"), check: "Check plan ideas", draft: () => {} },
  ...["LLM", "manual"].map(mode => ({
    name: `${mode} gap ideation`, node: priority,
    prepare: async () => { change(container.querySelector('input[placeholder*="title hint"]')!, "Retained proposed tactic"); change(container.querySelector('input[placeholder*="Optional rationale"]')!, "Retained proposal reason"); },
    run: () => mode === "manual" ? submit() : click("Run LLM ideate"),
    control: () => button(mode === "manual" ? "Save manual proposal" : "Run LLM ideate"), check: "Check plan ideas",
    draft: () => expect((container.querySelector('input[placeholder*="title hint"]') as HTMLInputElement).value).toBe("Retained proposed tactic"),
  })),
  { name: "client demo replacement", node: <AdminWorkspacePicker workspaces={[{ id: "w", name: "Demo client", created_by: "Owner", created_at: "today", demo: false, member_count: 1 }]} currentId="w" next="/admin" />, prepare: async () => {}, run: async () => { await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }, control: () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!, check: "Check workspace state", draft: () => expect(container.textContent).toContain("Demo client") },
  { name: "demo reset", node: <DemoResetBar workspace={{ id: "w", name: "Demo client", role: "owner", demo: true }} />, prepare: () => click("Reset demo"), run: async () => { await act(async () => [...container.querySelectorAll("button")].filter(b => b.textContent?.trim() === "Reset demo").at(-1)!.click()); }, control: () => [...container.querySelectorAll("button")].filter(b => b.textContent?.trim() === "Reset demo").at(-1)!, check: "Check workspace contents", draft: () => expect(container.textContent).toContain("Demo client") },
  { name: "customer workspace create", node: <CustomerCreate />, prepare: async () => change(container.querySelector("input")!, "Retained workspace"), run: submit, control: () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!, check: "Check workspace list", draft: () => expect(container.querySelector("input")!.value).toBe("Retained workspace") },
  { name: "Accuracy workspace create", node: <AccuracyCreate />, prepare: async () => change(container.querySelector("input")!, "Retained workspace"), run: submit, control: () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!, check: "Check workspace list", draft: () => { expect(container.querySelector("input")!.value).toBe("Retained workspace"); expect(container.querySelectorAll("input")[1].value).toBe("retained-workspace"); } },
];

describe.each(owners)("$name", owner => {
  it.each(["lost reply", "unreadable success", "incomplete success"])("blocks repetition after %s and provides a working read check", async failure => {
    const fetch = vi.fn().mockImplementation(async () => {
      if (failure === "lost reply") throw new TypeError("SQL secret=sk-test");
      return failure === "unreadable success" ? new Response("not-json") : Response.json({ unexpected: true });
    });
    vi.stubGlobal("fetch", fetch);
    render(owner.node); await owner.prepare(); await owner.run();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/confirm|current state/i);
    expect(container.textContent).not.toContain("sk-test");
    expect(container.textContent).not.toMatch(/Saving…|Creating…|Working…|Ideating…|Resetting…/);
    owner.draft(); expect(owner.control().disabled).toBe(true);
    await owner.run(); expect(fetch).toHaveBeenCalledTimes(1);
    // Exercise the actual recovery handler; replacing only location avoids a jsdom navigation.
    const reload = vi.fn(); const originalWindow = window;
    vi.stubGlobal("window", new Proxy(originalWindow, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } }));
    await click(owner.check); expect(reload).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains the draft and permits retry after a definitive rejection", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ ok: false, safe_error: true, request_outcome: "rejected", error: "Correct the required fields and try again." }, { status: 400 }));
    vi.stubGlobal("fetch", fetch); render(owner.node); await owner.prepare(); await owner.run();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Correct the required fields");
    owner.draft(); expect(owner.control().disabled).toBe(false);
    await owner.run(); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it.each(["lost reply", "unreadable success", "incomplete success"])("retains gap settings and rationale after %s without asserting that nothing saved", async failure => {
  const fetch = vi.fn().mockImplementation(async () => { if (failure === "lost reply") throw new TypeError("lost"); return failure === "unreadable success" ? new Response("not-json") : Response.json({ unexpected: true }); });
  vi.stubGlobal("fetch", fetch);
  render(<GapSettingsEditor gapId="g" settings={["1L"]} options={[]} />);
  change(container.querySelector("input")!, "Metastatic"); await submit();
  change(container.querySelector("textarea")!, "Retained treatment-setting rationale");
  await click("Save settings");
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/confirm/i);
  expect(container.textContent).not.toContain("Changes have not been saved");
  expect(container.textContent).toContain("Metastatic");
  expect(container.querySelector("textarea")!.value).toBe("Retained treatment-setting rationale");
  expect(button("Save settings").disabled).toBe(true);
  await click("Save settings"); expect(fetch).toHaveBeenCalledTimes(1);
  const reload = vi.fn(); const originalWindow = window;
  vi.stubGlobal("window", new Proxy(originalWindow, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } }));
  await click("Check current settings"); expect(reload).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(1);
});

const activity: TimelineActivity = {
  id: "a", tactic_id: "t", tactic_name: "Current name", tactic_type: "rwe_study",
  start_date: "2026-01-01", end_date: "2026-01-31", readout_date: null, lane: "medium",
  tactic_status: "planned", band: "medium", depends_on: [], gap_ids: [], gap_names: [],
  meta: {
    objective: "", outputs: "", inclusion: "committed", evidence_question: "Current evidence question",
    population: "", comparator: "", outcomes: "", data_source: "", study_design: "", owner: "", budget: "",
    function: "", priority_rationale: null, dependency_note: null, counts_toward_addressing: true,
    schedule_rationale: "", schedule_basis: { start: "human", end: "human", readout: null },
    lane_locked: false, depends_locked: false, rationale_locked: false, manual: false,
    proposed_dependencies: [], rejected_dependencies: [], inputs_key: "", estimate_stale: false,
  },
};
const identity = { signed_in: true, actor_name: "Owner", actor_function: "medical_affairs" as const };
it("freezes a confirmed schedule after details reject, then retries only the corrected details", async () => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, init) => {
    const body = JSON.parse(init.body); writes.push({ url, body });
    return writes.length === 2
      ? Response.json({ safe_error: true, request_outcome: "rejected", error: "Correct the activity details." }, { status: 400 })
      : Response.json({ ok: true });
  }));
  const done = vi.fn(); render(<ActivitySheetEditor activity={activity} expectedTactic="opening-token" identity={identity} canEditDetails onDone={done} />);
  const start = container.querySelector<HTMLInputElement>('[name="start_date"]')!;
  start.value = "2026-01-03";
  container.querySelector<HTMLInputElement>('[name="name"]')!.value = "First draft";
  container.querySelector<HTMLTextAreaElement>('[name="rationale"]')!.value = "A reason for the change";
  await submit();
  expect(writes.map(write => write.body.action)).toEqual(["move_activity", "modify_tactic"]);
  expect(start.matches(":disabled")).toBe(true);
  const scheduleFields = start.closest("fieldset")!.querySelectorAll("input, select, textarea");
  expect([...scheduleFields].every(field => field.matches(":disabled"))).toBe(true);
  expect(start.value).toBe("2026-01-03");
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(/schedule.*saved/i);
  expect(container.textContent).toContain("finish saving the details");
  expect(done).not.toHaveBeenCalled();
  container.querySelector<HTMLInputElement>('[name="name"]')!.value = "Corrected details";
  await submit();
  expect(writes.map(write => write.body.action)).toEqual(["move_activity", "modify_tactic", "modify_tactic"]);
  expect(writes[2].body.name).toBe("Corrected details"); expect(done).toHaveBeenCalledOnce();
});

it("accepts a confirmed settings save and displays the stored tags", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, settings: ["1L", "Metastatic"] })));
  render(<GapSettingsEditor gapId="g" settings={["1L"]} options={[]} />);
  change(container.querySelector("input")!, "Metastatic"); await submit();
  change(container.querySelector("textarea")!, "Retained treatment-setting rationale");
  await click("Save settings");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Metastatic");
  expect(container.querySelector("textarea")).toBeNull();
  expect(router.refresh).toHaveBeenCalledOnce();
});

const workspaceList = <WorkspacesView
  workspaces={[{ id: "existing", name: "Existing workspace", role: "owner", demo: false, created_at: "2026-01-01" }]}
  currentId="existing" startCreating next="/"
/>;

it.each(["lost reply", "unreadable success", "incomplete success"])("keeps the composed create form mounted after %s until workspace state is checked", async failure => {
  const fetch = vi.fn().mockImplementation(async () => {
    if (failure === "lost reply") throw new TypeError("lost");
    return failure === "unreadable success" ? new Response("not-json") : Response.json({ unexpected: true });
  });
  vi.stubGlobal("fetch", fetch);
  render(workspaceList);
  change(container.querySelector('input[name="workspace-name"]')!, "Retained new workspace");
  await submit();
  expect(button("Cancel").disabled).toBe(true);
  await click("Cancel");
  expect(container.querySelector('form[aria-label="Create a workspace"]')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[name="workspace-name"]')!.value).toBe("Retained new workspace");
  expect(button("New workspace")).toBeUndefined();
  await submit(); expect(fetch).toHaveBeenCalledTimes(1);
  const reload = vi.fn(); const originalWindow = window;
  vi.stubGlobal("window", new Proxy(originalWindow, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } }));
  await click("Check workspace list");
  expect(reload).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(1);
});

it("allows cancelling the composed create form after a definitive rejection", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: false, safe_error: true, request_outcome: "rejected", error: "Correct the required fields and try again." }, { status: 400 }));
  vi.stubGlobal("fetch", fetch);
  render(workspaceList);
  change(container.querySelector('input[name="workspace-name"]')!, "Rejected workspace");
  await submit();
  expect(button("Cancel").disabled).toBe(false);
  await click("Cancel");
  expect(container.querySelector('form[aria-label="Create a workspace"]')).toBeNull();
  await click("New workspace");
  expect(container.querySelector('form[aria-label="Create a workspace"]')).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
