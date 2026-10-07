/** @vitest-environment jsdom */
/** Exercise exact-assembly feedback in the Complete proposals panel. */
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Assembly } from "@/accuracy/domain/assembly";
import { AssemblyHistory } from "@/components/accuracy/assembly-history";

const assembly: Assembly = {
  id: "assembly-old", workspace_id: "ws", created_at: "2026-10-03T09:00:00Z",
  actor: { name: "Agent", function: "medical_affairs" }, fingerprint: "fingerprint-old",
  source_file_ids: ["source-1"], items: [], mappings: [], coverage: [],
  extraction_runs: [], linking_complete: true, output: { gaps: [], tactics: [] },
  checks: { checker_version: "assembly-domain-v1", status: "passed", findings: [] },
};
const successor: Assembly = { ...assembly, id: "assembly-new", fingerprint: "fingerprint-new" };
const run = { run_id: "consumer-1", created_at: "2026-10-04T12:00:00Z", approval_review_id: "review-old", consumed_item_version_ids: ["gap-v1", "tactic-v1"] };
const feedback = {
  id: "feedback-1", workspace_id: "ws", assembly_id: assembly.id,
  assembly_fingerprint: assembly.fingerprint, approval_review_id: run.approval_review_id,
  consumer_run_id: run.run_id, selected_item_version_ids: ["gap-v1"],
  items: [{ item_version_id: "gap-v1", claim_type: "gap", source_file_id: "source-1", evidence: [{ source_file_id: "source-1", block_id: "block-1", quote: "Recorded evidence" }] }],
  category: "edited", rationale: "Wording changed after deployment.", actor_subject: "subject-1", actor_provider: "credentials",
  actor_name: "Dr Contributor", actor_function: "medical_affairs", created_at: "2026-10-05T14:00:00Z",
};

let host: HTMLDivElement;
let root: Root;
const reply = (body: object, ok = true) => ({ ok, json: async () => body });
const list = (assemblies: Assembly[] = [assembly]) => reply({ assemblies });
const detail = (target: Assembly = assembly, options: { can?: boolean; entries?: object[]; runs?: object[] } = {}) => reply({
  assembly: target, can_feedback: options.can ?? true, feedback: options.entries ?? [], feedback_runs: options.runs ?? [run],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(workspaceId = "ws") { await act(async () => root.render(createElement(AssemblyHistory, { workspaceId }))); }
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(candidate => candidate.textContent === label);
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}
async function choose(labelText: string) {
  const label = [...host.querySelectorAll("label")].find(candidate => candidate.textContent?.includes(labelText));
  expect(label, labelText).toBeDefined();
  const input = label!.querySelector("input") as HTMLInputElement;
  await act(async () => { input.click(); });
}
async function fill(labelText: string, value: string) {
  const label = [...host.querySelectorAll("label")].find(candidate => candidate.textContent?.includes(labelText));
  expect(label, labelText).toBeDefined();
  const input = label!.querySelector("textarea,input") as HTMLTextAreaElement | HTMLInputElement;
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function select(labelText: string, value: string) {
  const label = [...host.querySelectorAll("label")].find(candidate => candidate.textContent?.includes(labelText));
  expect(label, labelText).toBeDefined();
  const input = label!.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function open() { await click("Complete proposals"); await click("Inspect proposal assembly-old"); }

it("shows eligible run links, consumed subset and history without calling observations a metric", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail(assembly, { entries: [feedback] })));
  await render(); await open();
  expect(host.textContent).toContain("consumer-1");
  expect(host.querySelector('a[href="/accuracy/runs/consumer-1?workspace_id=ws"]')).not.toBeNull();
  expect(host.textContent).toContain("gap-v1"); expect(host.textContent).toContain("tactic-v1");
  for (const text of ["Dr Contributor", "2026-10-05T14:00:00Z", "source-1", "block-1", "Recorded evidence", "Wording changed after deployment."]) expect(host.textContent).toContain(text);
  expect(host.textContent).toContain("do not establish gold accuracy or clinical correctness");
  expect(host.textContent).not.toMatch(/feedback accuracy|feedback score|accuracy percentage/i);
});

it("submits only a selected consumed item and then displays refreshed history", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail())
    .mockResolvedValueOnce(reply({ ok: true, feedback })).mockResolvedValueOnce(detail(assembly, { entries: [feedback] }));
  vi.stubGlobal("fetch", fetcher);
  await render(); await open(); await choose("Select gap-v1"); await fill("Feedback rationale", "Wording changed after deployment.");
  await click("Record feedback");
  const body = JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body));
  expect(body).toEqual({ action: "feedback", workspace_id: "ws", assembly_id: "assembly-old", expected_fingerprint: "fingerprint-old", approval_review_id: "review-old", consumer_run_id: "consumer-1", selected_item_version_ids: ["gap-v1"], category: "accepted_unchanged", rationale: "Wording changed after deployment." });
  expect(host.textContent).toContain("Dr Contributor");
});

it("sends an empty subset for all consumed items with the chosen category", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail())
    .mockResolvedValueOnce(reply({ ok: true, feedback })).mockResolvedValueOnce(detail(assembly, { entries: [feedback] }));
  vi.stubGlobal("fetch", fetcher);
  await render(); await open(); await select("Feedback category", "missing_item");
  await fill("Feedback rationale", "Expected gap absent from consumer output.");
  await click("Record feedback");
  const body = JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body));
  expect(body.selected_item_version_ids).toEqual([]);
  expect(body.category).toBe("missing_item");
  expect(host.textContent).toContain("Dr Contributor");
});

it("keeps viewers read-only and keeps successor history separate", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(list([assembly, successor]))
    .mockResolvedValueOnce(detail(assembly, { can: false, entries: [feedback] }))
    .mockResolvedValueOnce(detail(successor, { can: false, entries: [], runs: [] })));
  await render(); await open();
  expect(host.textContent).toContain("Dr Contributor"); expect(host.textContent).not.toContain("Record feedback");
  await click("Inspect proposal assembly-new");
  expect(host.textContent).not.toContain("Dr Contributor"); expect(host.textContent).toContain("No feedback recorded for this proposal.");
});

it("serializes duplicate clicks and preserves retry state after refresh failure", async () => {
  const posted = deferred<ReturnType<typeof reply>>();
  const fetcher = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail())
    .mockReturnValueOnce(posted.promise).mockResolvedValueOnce(reply({ error: "Refresh failed" }, false))
    .mockResolvedValueOnce(detail());
  vi.stubGlobal("fetch", fetcher);
  await render(); await open(); await fill("Feedback rationale", "Observed in deployment.");
  const button = [...host.querySelectorAll("button")].find(candidate => candidate.textContent === "Record feedback")!;
  await act(async () => { button.click(); button.click(); });
  expect(fetcher).toHaveBeenCalledTimes(3);
  await act(async () => posted.resolve(reply({ ok: true, feedback })));
  expect(host.textContent).toContain("Refresh failed");
  expect((host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement).disabled).toBe(true);
  await click("Retry feedback refresh");
  expect((host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement).disabled).toBe(false);
  expect((host.querySelector('textarea[aria-label="Feedback rationale"]') as HTMLTextAreaElement).value).toBe("Observed in deployment.");
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("ignores late detail responses after a workspace change", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const fetcher = vi.fn().mockResolvedValueOnce(list()).mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(list([{ ...assembly, workspace_id: "next", id: "next-assembly" }]));
  vi.stubGlobal("fetch", fetcher);
  await render(); await click("Complete proposals");
  const inspect = [...host.querySelectorAll("button")].find(candidate => candidate.textContent === "Inspect proposal assembly-old")!;
  await act(async () => { inspect.click(); });
  flushSync(() => root.render(createElement(AssemblyHistory, { workspaceId: "next" })));
  await act(async () => pending.resolve(detail(assembly, { entries: [feedback] })));
  expect(host.textContent).not.toContain("Dr Contributor");
});

it("refreshes the submitting assembly after reopening it when feedback completes during navigation", async () => {
  const posted = deferred<ReturnType<typeof reply>>();
  const nextDetail = deferred<ReturnType<typeof reply>>();
  const refreshedOldDetail = deferred<ReturnType<typeof reply>>();
  const fetcher = vi.fn().mockResolvedValueOnce(list([assembly, successor]))
    .mockResolvedValueOnce(detail()).mockReturnValueOnce(posted.promise)
    .mockReturnValueOnce(nextDetail.promise).mockReturnValueOnce(refreshedOldDetail.promise);
  vi.stubGlobal("fetch", fetcher);
  await render(); await open(); await fill("Feedback rationale", "Observed in deployment.");
  await act(async () => { (host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement).click(); });
  await click("Inspect proposal assembly-new");
  await act(async () => posted.resolve(reply({ ok: true, feedback })));
  expect(fetcher).toHaveBeenCalledTimes(4);
  await act(async () => nextDetail.resolve(detail(successor, { runs: [], entries: [] })));
  expect(host.textContent).not.toContain("Dr Contributor");
  expect(host.textContent).toContain("No feedback recorded for this proposal.");
  await click("Inspect proposal assembly-old");
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls[4][0]).toBe("/api/accuracy/assemblies?workspace_id=ws&assembly_id=assembly-old");
  const submitWhileRefreshing = host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement | null;
  expect(submitWhileRefreshing === null || submitWhileRefreshing.disabled).toBe(true);
  expect(host.textContent).not.toContain("Dr Contributor");
  await act(async () => refreshedOldDetail.resolve(detail(assembly, { entries: [feedback] })));
  expect(host.textContent).toContain("Dr Contributor");
  await fill("Feedback rationale", "A new observation.");
  expect((host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement).disabled).toBe(false);
});

it("requires a fresh detail GET after an uncertain feedback response resolves away from the assembly", async () => {
  const posted = deferred<ReturnType<typeof reply>>();
  const nextDetail = deferred<ReturnType<typeof reply>>();
  const refreshedOldDetail = deferred<ReturnType<typeof reply>>();
  const fetcher = vi.fn().mockResolvedValueOnce(list([assembly, successor]))
    .mockResolvedValueOnce(detail()).mockReturnValueOnce(posted.promise)
    .mockReturnValueOnce(nextDetail.promise).mockReturnValueOnce(refreshedOldDetail.promise);
  vi.stubGlobal("fetch", fetcher);
  await render(); await open(); await fill("Feedback rationale", "Observed in deployment.");
  await act(async () => { (host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement).click(); });
  await click("Inspect proposal assembly-new");
  await act(async () => posted.resolve(reply({ error: "Response uncertain" }, false)));
  expect(fetcher).toHaveBeenCalledTimes(4);
  await act(async () => nextDetail.resolve(detail(successor, { runs: [], entries: [] })));
  expect(host.textContent).toContain("No feedback recorded for this proposal.");
  await click("Inspect proposal assembly-old");
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls[4][0]).toBe("/api/accuracy/assemblies?workspace_id=ws&assembly_id=assembly-old");
  const submitWhileRefreshing = host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement | null;
  expect(submitWhileRefreshing === null || submitWhileRefreshing.disabled).toBe(true);
  await act(async () => refreshedOldDetail.resolve(detail(assembly, { entries: [feedback] })));
  expect(host.textContent).toContain("Dr Contributor");
  await fill("Feedback rationale", "A new observation.");
  expect((host.querySelector('button[aria-label="Record feedback"]') as HTMLButtonElement).disabled).toBe(false);
});
