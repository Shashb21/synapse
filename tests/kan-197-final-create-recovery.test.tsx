/** @vitest-environment jsdom */
/** Creation is confirmed only with the expected identifier; unknown writes cannot repeat. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { LedgerNewClaimForm } from "@/components/accuracy/ledger-new-claim-form";
import { ManualSourceForm } from "@/components/platform/manual-source-form";
import { CoverageManualPairForm } from "@/components/accuracy/coverage-manual-pair-form";
import { SeedFromGoldForm } from "@/components/accuracy/seed-from-gold-form";
import { AiStatusProvider } from "@/components/platform/ai-status";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function render(node: ReactNode) { act(() => root.render(<AiStatusProvider enabled>{node}</AiStatusProvider>)); }
function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) { act(() => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
function button(label: string) { return [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
const owners = [
  { name: "ledger claim", node: <LedgerNewClaimForm workspaceId="w" tacticOptions={[]} initialKind="gap" />, prepare: async () => { change(container.querySelector('[data-testid="new-claim-statement"]')!, "Retained statement"); change(container.querySelectorAll("textarea")[2], "Retained rationale"); }, run: submit, control: () => button("Create draft gap"), check: "Check current claims", draft: () => expect((container.querySelector('[data-testid="new-claim-statement"]') as HTMLTextAreaElement).value).toBe("Retained statement"), success: { ok: true, claim: { id: "aclm_confirmed" } } },
  { name: "manual source", node: <ManualSourceForm endpoint="/api/sources/blocks" payload={{}} fields={[]} identity={{ signed_in: true, actor_name: "Owner", actor_function: "medical_affairs" }} onSavedHref="/sources/{id}" />, prepare: async () => { change(container.querySelector("textarea")!, "Retained source paragraph"); await click("Split into paragraphs"); change(container.querySelectorAll("textarea")[2], "Retained rationale"); }, run: () => click("Save 1 human-entered block"), control: () => button("Save 1 human-entered block"), check: "Check current sources", draft: () => expect(container.querySelector("textarea")!.value).toBe("Retained source paragraph"), success: { ok: true, source_id: "src_confirmed" } },
  { name: "reference seed", node: <SeedFromGoldForm />, prepare: async () => {}, run: submit, control: () => button("Seed workspace from gold"), check: "Check workspace list", draft: () => expect(container.querySelector("select")!.value).toBe("beone-bgb-58067-prmt5i"), success: { ok: true, workspace_id: "wsp_confirmed", gaps: 1, tactics: 2, parse_blocks: 3 } },
];
describe.each(owners)("$name", owner => {
  it.each(["lost reply", "unreadable success", "incomplete success", "invalid identifier"])("retains draft and prevents a second write after %s", async failure => {
    const fetch = vi.fn(async () => { if (failure === "lost reply") throw new TypeError("SQL password=secret"); return failure === "unreadable success" ? new Response("html") : Response.json(failure === "invalid identifier" ? { ...owner.success, claim: { id: {} }, source_id: {}, workspace_id: {} } : { unexpected: true }); });
    vi.stubGlobal("fetch", fetch); render(owner.node); await owner.prepare(); await owner.run();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/confirm|check/i); expect(alert.className).toContain("text-sm"); expect(container.textContent).not.toContain("password=secret");
    owner.draft(); expect(owner.control().disabled).toBe(true); await owner.run(); expect(fetch).toHaveBeenCalledTimes(1);
    if (owner.name === "ledger claim") expect(button("Close").disabled).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
    const reload = vi.fn(); const original = window;
    vi.stubGlobal("window", new Proxy(original, { get(target, key) { return key === "location" ? { reload } : Reflect.get(target, key, target); } }));
    await click(owner.check); if (owner.name === "manual source") expect(router.push).toHaveBeenCalledWith("/sources"); else expect(reload).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("keeps safe validation and blocks unknown repeat (trusted=%s)", async trusted => {
    const correction = "End date must not be before start date.";
    const raw = "SELECT password FROM private token=sample-secret";
    const fetch = vi.fn(async () => Response.json({ ok: false, ...(trusted ? { safe_error: true } : {}), error: trusted ? correction : raw }, { status: 400 }));
    vi.stubGlobal("fetch", fetch); render(owner.node); await owner.prepare(); await owner.run();
    const alert = container.querySelector('[role="alert"]')!;
    if (trusted) expect(alert.textContent).toContain(correction);
    expect(alert.textContent).toMatch(/couldn’t confirm creation/i);
    expect(alert.textContent).toMatch(/check.*before/i);
    expect(container.textContent).not.toContain(raw); expect(container.textContent).not.toContain("sample-secret");
    owner.draft(); expect(owner.control().disabled).toBe(true); await owner.run(); expect(fetch).toHaveBeenCalledTimes(1);
    if (owner.name === "ledger claim") expect(button("Close").disabled).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
  });
  it("confirms a valid create before clearing its draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(owner.success))); render(owner.node); await owner.prepare(); await owner.run();
    expect(container.querySelector('[role="alert"]')).toBeNull(); if (owner.name !== "manual source") expect(router.refresh).toHaveBeenCalledOnce();
    if (owner.name === "ledger claim") expect((container.querySelector('[data-testid="new-claim-statement"]') as HTMLTextAreaElement).value).toBe("");
    if (owner.name === "manual source") { expect(container.querySelector("textarea")!.value).toBe(""); expect(router.push).toHaveBeenCalledWith("/sources/src_confirmed"); }
  });
});
it("announces seeded claims and incomplete source reading without discarding that explanation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, workspace_id: "wsp_seed", gaps: 2, tactics: 3, parse_blocks: 0, parse_error: "fixed safe server guidance" })));
  render(<SeedFromGoldForm />); await submit();
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(/2 gaps.*3 tactics.*reading.*did not finish/i);
  expect(container.querySelector('a[href="/admin/accuracy/ledger?workspace_id=wsp_seed"]')?.textContent).toContain("Open seeded workspace");
  expect(router.push).not.toHaveBeenCalled(); expect(button("Seed workspace from gold").disabled).toBe(true);
});

it("manual coverage announces its primary correction at body size", async () => {
  render(<CoverageManualPairForm workspaceId="w" gaps={[{ id: "g", statement: "Gap" }]} tactics={[{ id: "t", statement: "Tactic" }]} />);
  await click("Pick a pair"); await submit();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe("Pick a gap and a tactic."); expect(alert.className).toContain("text-sm");
});
