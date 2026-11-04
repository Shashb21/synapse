/** @vitest-environment jsdom */
/** Save decisions preserve drafts and resume their original action only after confirmation. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { parsePlanningContext } from "@/lib/iegp/planning-context";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = parsePlanningContext({
  asset_name: "Nova", therapeutic_area: "Immunology", lifecycle_stage: "growth",
  indications: [{ name: "Psoriasis", status: "current" }], markets: ["US"],
  plan_owner: "Owner", sponsoring_function: "Medical Affairs",
  objectives: [{ id: "OBJ-1", name: "Win HTA", strategic_importance: 5, key_decision: "Filing", decision_date: "2028-01-15" }],
  stakeholders: [{ function: "HEOR", lead: "Lead" }], saved_at: "2026-10-01T00:00:00.000Z",
});
let root: Root;
let container: HTMLDivElement;
let requests: { url: string; body: Record<string, unknown> }[];
let respond: (url: string, body: Record<string, unknown>) => Promise<Response>;

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks(); requests = [];
  respond = async (url, body) => Response.json(url === "/api/walkthrough"
    ? { progress: { status: "active", step: 0, updated_at: null } }
    : { ok: true, context: { ...(body.context as object), saved_at: "2026-11-04T12:00:00.000Z" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push({ url, body }); return respond(url, body);
  }));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function render(setupComplete = true, context = initial, ai = true) {
  act(() => root.render(<AiStatusProvider enabled={ai}><SetupWizard initial={context} actorName="Owner" actorFunction="medical_affairs" setupComplete={setupComplete}
    linkedGaps={[{ id: "g1", name: "Survival evidence", objective_id: "OBJ-1", open: true, settings: ["1L", "2L"] }]} /></AiStatusProvider>));
}
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent?.trim().replace(/^✓\s*/, "") === label);
  expect(found, `button ${label}`).toBeDefined(); return found!;
}
async function click(label: string, scope: ParentNode = document) { await act(async () => button(label, scope).click()); }
function field(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll("label")].find(row => row.textContent?.includes(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  expect(found, `field ${label}`).toBeTruthy(); return found!;
}
function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function dialog() { const found = document.querySelector<HTMLElement>('[role="dialog"]'); expect(found).not.toBeNull(); return found!; }
async function edit() { await click("Objectives & decisions"); change(field("Key decision"), "Committee filing"); }
async function open() { await edit(); await click("Continue"); return dialog(); }
async function escape() { await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); }

describe("setup reason dialog", () => {
  it("opens only at a revision save with an accessible reason and impact warning, validates short reasons, and continues after confirmation", async () => {
    render(); await edit(); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...document.querySelectorAll("label")].some(label => label.textContent?.includes("Reason for objective changes"))).toBe(false);
    await click("Continue"); const popup = dialog();
    expect(popup.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(popup.getAttribute("aria-labelledby")!)?.textContent).toContain("Reason");
    expect(popup.textContent).toContain("Survival evidence"); expect(popup.textContent).toContain("1L, 2L");
    change(field("Reason for objective changes", popup), " a "); await click("Save and continue", popup);
    expect(popup.querySelector('[role="alert"]')?.textContent).toContain("meaningful reason"); expect(requests).toHaveLength(0);
    change(field("Reason for objective changes", popup), "Committee confirmed scope"); await click("Save and continue", popup);
    expect(requests).toHaveLength(1); expect(requests[0].body).toMatchObject({ action: "save_product_setup", mark_complete: false, reason: "Committee confirmed scope" });
    expect(container.querySelector('[data-testid="setup-step-landscape"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(router.push).not.toHaveBeenCalled();
    await edit(); change(field("Key decision"), "Next committee filing"); await click("Continue"); expect(field("Reason for objective changes", dialog()).value).toBe("");
  });

  it.each(["Cancel", "Close", "Escape"])("%s dismisses without saving or navigating and preserves setup and reason drafts on reopen", async dismissal => {
    render(); const popup = await open(); change(field("Reason for objective changes", popup), "Draft explanation");
    if (dismissal === "Escape") { act(() => field("Reason for objective changes", popup).focus()); await escape(); }
    else await click(dismissal, popup);
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(field("Key decision").value).toBe("Committee filing");
    expect(requests).toHaveLength(0); expect(router.push).not.toHaveBeenCalled(); expect(router.refresh).not.toHaveBeenCalled();
    await click("Continue"); expect(field("Reason for objective changes", dialog()).value).toBe("Draft explanation");
    await click("Cancel", dialog()); await click("Review & finish"); await click("Save changes");
    change(field("Reason for objective changes", dialog()), "Final explanation"); await click("Save and continue", dialog());
    expect(router.refresh).toHaveBeenCalledOnce(); expect(container.querySelector('[data-testid="setup-step-review"]')).not.toBeNull();
  });

  it("retains reason and error after a failed save and permits a successful retry", async () => {
    render(); const popup = await open(); change(field("Reason for objective changes", popup), "Retained reason");
    const success = respond; respond = async () => Response.json({ error: "Setup context changed. Reload the latest context before retrying.", safe_error: true, request_outcome: "rejected" }, { status: 400 });
    await click("Save and continue", popup); expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Setup context changed");
    expect(field("Reason for objective changes", dialog()).value).toBe("Retained reason"); expect(button("Cancel", dialog()).disabled).toBe(false);
    expect(container.querySelector('[data-testid="setup-step-objectives"]')).not.toBeNull(); respond = success;
    await click("Save and continue", dialog()); expect(requests).toHaveLength(2); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="setup-step-landscape"]')).not.toBeNull();
  });

  it("keeps network failure recovery and both drafts after dismissal and reopening", async () => {
    render(); const popup = await open(); change(field("Reason for objective changes", popup), "Offline draft reason");
    const success = respond; respond = async () => { throw new TypeError("Offline"); };
    await click("Save and continue", popup);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Check your connection");
    await click("Cancel", dialog()); expect(field("Key decision").value).toBe("Committee filing");
    await click("Continue"); expect(field("Reason for objective changes", dialog()).value).toBe("Offline draft reason");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Check your connection");
    expect(router.push).not.toHaveBeenCalled(); expect(router.refresh).not.toHaveBeenCalled();
    respond = success; await click("Save and continue", dialog());
    expect(container.querySelector('[data-testid="setup-step-landscape"]')).not.toBeNull();
  });

  it("opens recovery for an unexpected server rationale rejection and retries the original action", async () => {
    render(); await click("Company & plan"); change(field("Plan owner"), "Updated owner");
    const success = respond; respond = async () => Response.json({ error: "A short rationale is required for every edit.", safe_error: true, request_outcome: "rejected" }, { status: 400 });
    await click("Continue"); expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("rationale is required");
    change(field("Reason for objective changes", dialog()), "Legacy objective context updated"); respond = success;
    await click("Save and continue", dialog()); expect(requests).toHaveLength(2);
    expect(container.querySelector('[data-testid="setup-step-objectives"]')).not.toBeNull(); expect(field("Objective 1").value).toBe("Win HTA");
  });

  it("blocks duplicate saves and all dismissal while saving, then resumes once", async () => {
    render(); const popup = await open(); change(field("Reason for objective changes", popup), "Confirmed scope");
    const success = respond; let resolve!: (response: Response) => void;
    respond = async () => new Promise<Response>(done => { resolve = done; });
    const confirm = button("Save and continue", popup);
    const cancel = button("Cancel", popup);
    await act(async () => { confirm.click(); confirm.click(); cancel.click(); }); expect(requests).toHaveLength(1);
    expect(button("Cancel", dialog()).disabled).toBe(true); expect(dialog().textContent).toContain("Saving");
    await click("Close", dialog()); await escape(); expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => resolve(await success(requests[0].url, requests[0].body)));
    expect(requests).toHaveLength(1); expect(container.querySelector('[data-testid="setup-step-landscape"]')).not.toBeNull();
  });

  it.each([
    { complete: true, tour: false, ai: true, action: "Save changes", path: null },
    { complete: false, tour: false, ai: true, action: "Finish without tour", path: "/sources" },
    { complete: false, tour: false, ai: false, action: "Finish without tour", path: "/?place=gaps" },
    { complete: false, tour: true, ai: true, action: "Finish & start walkthrough", path: "/?place=gaps" },
  ])("resumes $action once (complete=$complete ai=$ai)", async ({ complete, tour, ai, action, path }) => {
    render(complete, initial, ai); await edit(); await click("Review & finish"); await click(action);
    change(field("Reason for objective changes", dialog()), "Approved revision"); await click("Save and continue", dialog());
    expect(requests.filter(row => row.url === "/api/iegp")).toHaveLength(1); expect(requests[0].body.mark_complete).toBe(true);
    expect(requests.filter(row => row.url === "/api/walkthrough")).toHaveLength(tour ? 1 : 0);
    if (path) { expect(router.push).toHaveBeenCalledExactlyOnceWith(path); expect(router.refresh).not.toHaveBeenCalled(); }
    else { expect(router.refresh).toHaveBeenCalledOnce(); expect(router.push).not.toHaveBeenCalled(); }
  });

  it("saves initial objective creation directly after an earlier draft save", async () => {
    render(false, { ...initial, objectives: [] }); await click("Add objective");
    change(field("Objective 1"), "First objective"); change(field("Key decision"), "First filing"); change(field("Decision date"), "2028-01-15");
    await click("Continue"); expect(requests).toHaveLength(1); expect(requests[0].body.reason).toBe("");
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.querySelector('[data-testid="setup-step-landscape"]')).not.toBeNull();
  });
});
