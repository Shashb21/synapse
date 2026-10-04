/** @vitest-environment jsdom */
/** Exercise complete-proposal review controls through real React DOM interactions. */
import { StrictMode, act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Assembly, AssemblyCheckReport } from "@/accuracy/domain/assembly";
import { AssemblyHistory } from "@/components/accuracy/assembly-history";

let host: HTMLDivElement;
let root: Root;

const baseAssembly: Assembly = {
  id: "assembly-review-a",
  workspace_id: "ws",
  created_at: "2026-10-03T09:00:00Z",
  actor: { name: "Extraction agent", function: "medical_affairs" },
  fingerprint: "fingerprint-review-a",
  source_file_ids: ["source-1"],
  items: [],
  mappings: [],
  coverage: [],
  extraction_runs: [
    { call_kind: "need_extract", run_id: "run-gap", source_file_id: "source-1", item_count: 0, outcome: "empty", evaluation_context: "production" },
  ],
  linking_complete: true,
  output: { gaps: [], tactics: [] },
  checks: { checker_version: "assembly-domain-v1", status: "passed", findings: [] },
};

const advisoryFinding: AssemblyCheckReport["findings"][number] = {
  code: "coverage_stub_advisory",
  severity: "advisory",
  item_version_ids: ["gap-v1", "tactic-v1"],
  message: "Stub coverage is advisory only.",
};

const blockingFinding: AssemblyCheckReport["findings"][number] = {
  code: "linking_incomplete",
  severity: "blocking",
  item_version_ids: [],
  message: "Assembly linking has not completed.",
};

const advisoryAssembly: Assembly = {
  ...baseAssembly,
  id: "assembly-review-b",
  fingerprint: "fingerprint-review-b",
  checks: { checker_version: "assembly-domain-v1", status: "passed", findings: [advisoryFinding] },
};

const blockedAssembly: Assembly = {
  ...baseAssembly,
  id: "assembly-review-c",
  fingerprint: "fingerprint-review-c",
  linking_complete: false,
  checks: { checker_version: "assembly-domain-v1", status: "blocked", findings: [blockingFinding, advisoryFinding] },
};

function reviewState(
  assembly: Assembly,
  status: "pending" | "approved" | "rejected" | "stale",
  latestDecision: Record<string, unknown> | null = null,
) {
  return {
    assembly_id: assembly.id,
    fingerprint: assembly.fingerprint,
    checks_fingerprint: `checks-${assembly.id}`,
    status,
    head_status: status === "stale" ? "stale" : "current",
    expected_review_id: typeof latestDecision?.id === "string" ? latestDecision.id : null,
    latest_decision: latestDecision,
    checks: assembly.checks,
    advisories: assembly.checks.findings.filter((finding) => finding.severity === "advisory"),
  };
}

function response(body: object, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(workspaceId = "ws") {
  await act(async () => root.render(createElement(AssemblyHistory, { workspaceId })));
}

async function renderStrictMode(workspaceId = "ws") {
  await act(async () => root.render(createElement(StrictMode, null, createElement(AssemblyHistory, { workspaceId }))));
}

async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

async function setField(labelText: string, value: string) {
  const label = [...host.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(labelText));
  expect(label, labelText).toBeDefined();
  const control = label!.querySelector("textarea,input") as HTMLInputElement | HTMLTextAreaElement | null;
  expect(control, labelText).toBeDefined();
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(control, value);
    control!.dispatchEvent(new Event("input", { bubbles: true }));
    control!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function setChecked(labelText: string) {
  const label = [...host.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(labelText));
  expect(label, labelText).toBeDefined();
  const control = label!.querySelector("input[type='checkbox']") as HTMLInputElement | null;
  expect(control, labelText).toBeDefined();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  await act(async () => {
    setter?.call(control, true);
    control!.dispatchEvent(new Event("input", { bubbles: true }));
    control!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("shows current review labels and immutable reviewer decisions from detail metadata", async () => {
  const approvedDecision = {
    id: "review-approved",
    decision: "approve",
    rationale: "Ready for live use.",
    advisory_overrides: [],
    reviewer_actor_name: "Dr Approver",
    reviewer_actor_function: "medical_affairs",
    reviewer_role: "medical_affairs",
    created_at: "2026-10-03T10:00:00Z",
  };
  const rejectedDecision = {
    id: "review-rejected",
    decision: "reject",
    rationale: "Needs a revised proposal.",
    advisory_overrides: [{ code: advisoryFinding.code, item_version_ids: advisoryFinding.item_version_ids, reason: "Stub coverage is insufficient." }],
    reviewer_actor_name: "Case Reviewer",
    reviewer_actor_function: "medical_affairs",
    reviewer_role: "contributor",
    created_at: "2026-10-03T11:00:00Z",
  };
  const staleDecision = { ...approvedDecision, id: "review-stale", rationale: "Old approval.", created_at: "2026-10-03T08:00:00Z" };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly, advisoryAssembly, blockedAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "approved", approvedDecision), can_review: true }))
    .mockResolvedValueOnce(response({ assembly: advisoryAssembly, review_state: reviewState(advisoryAssembly, "rejected", rejectedDecision), can_review: true }))
    .mockResolvedValueOnce(response({ assembly: blockedAssembly, review_state: reviewState(blockedAssembly, "stale", staleDecision), can_review: true }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  expect([...host.querySelectorAll("li span")].filter((span) => span.textContent === "Complete proposal")).toHaveLength(3);
  expect(host.textContent).not.toContain("Unapproved proposal");
  await click("Inspect proposal assembly-review-a");
  for (const text of ["Review status: approved", "Live head: current", "Dr Approver", "medical_affairs", "Ready for live use.", "2026-10-03T10:00:00Z"]) {
    expect(host.textContent).toContain(text);
  }

  await click("Inspect proposal assembly-review-b");
  for (const text of ["Review status: rejected", "Case Reviewer", "Needs a revised proposal.", "Stub coverage is insufficient.", "Live use pauses until a revised complete proposal is generated and approved."]) {
    expect(host.textContent).toContain(text);
  }

  await click("Inspect proposal assembly-review-c");
  expect(host.textContent).toContain("Review status: stale");
  expect(host.textContent).toContain("Live head: stale");
  expect(host.textContent).toContain("Refresh proposal before deciding.");
});

it("keeps viewers read-only and requires complete detail before showing review controls", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "pending"), can_review: false }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  expect(host.textContent).not.toContain("Approve proposal");
  await click("Inspect proposal assembly-review-a");
  expect(host.textContent).toContain("Review status: pending");
  expect(host.textContent).toContain("You can inspect this proposal, but your current role cannot approve or reject it.");
  expect(host.textContent).not.toContain("Approve proposal");
  expect(host.textContent).not.toContain("Reject proposal");
});

it("requires rationale plus every advisory acknowledgement and sends exact displayed bindings", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [advisoryAssembly] }))
    .mockResolvedValueOnce(response({ assembly: advisoryAssembly, review_state: reviewState(advisoryAssembly, "pending"), can_review: true }))
    .mockResolvedValueOnce(response({ ok: true, state: reviewState(advisoryAssembly, "approved", { id: "review-new" }) }))
    .mockResolvedValueOnce(response({ assemblies: [advisoryAssembly] }))
    .mockResolvedValueOnce(response({ assembly: advisoryAssembly, review_state: reviewState(advisoryAssembly, "approved", { id: "review-new" }), can_review: true }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  await click("Inspect proposal assembly-review-b");
  expect(host.textContent).toContain("Fingerprint: fingerprint-review-b");
  expect((host.querySelector("button[aria-label='Approve proposal']") as HTMLButtonElement).disabled).toBe(true);

  await setField("Review rationale", "Approved after checking the advisory.");
  expect((host.querySelector("button[aria-label='Approve proposal']") as HTMLButtonElement).disabled).toBe(true);
  await setChecked("Acknowledge advisory coverage_stub_advisory");
  await setField("Reason for advisory coverage_stub_advisory", "Stub coverage is acceptable for this release.");
  expect((host.querySelector("button[aria-label='Approve proposal']") as HTMLButtonElement).disabled).toBe(false);
  await click("Approve proposal");

  const [, init] = fetcher.mock.calls[2] as [string, RequestInit];
  expect(fetcher.mock.calls[2][0]).toBe("/api/accuracy/assemblies");
  expect(JSON.parse(String(init.body))).toEqual({
    workspace_id: "ws",
    assembly_id: "assembly-review-b",
    expected_fingerprint: "fingerprint-review-b",
    expected_review_id: null,
    decision: "approve",
    rationale: "Approved after checking the advisory.",
    advisory_overrides: [{ code: "coverage_stub_advisory", item_version_ids: ["gap-v1", "tactic-v1"], reason: "Stub coverage is acceptable for this release." }],
  });
  expect(host.textContent).toContain("Review status: approved");
  expect([...host.querySelectorAll("li span")].filter((span) => span.textContent === "Complete proposal")).toHaveLength(1);
  expect(host.textContent).not.toContain("Unapproved proposal");
});

it("disables approval for blocking findings but permits rejection with rationale", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [blockedAssembly] }))
    .mockResolvedValueOnce(response({ assembly: blockedAssembly, review_state: reviewState(blockedAssembly, "pending"), can_review: true }))
    .mockResolvedValueOnce(response({ ok: true, state: reviewState(blockedAssembly, "rejected", { id: "review-reject" }) }))
    .mockResolvedValueOnce(response({ assemblies: [blockedAssembly] }))
    .mockResolvedValueOnce(response({ assembly: blockedAssembly, review_state: reviewState(blockedAssembly, "rejected", { id: "review-reject" }), can_review: true }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  await click("Inspect proposal assembly-review-c");
  expect(host.textContent).toContain("Blocking findings must be fixed before this proposal can be approved.");
  expect((host.querySelector("button[aria-label='Approve proposal']") as HTMLButtonElement).disabled).toBe(true);
  expect((host.querySelector("button[aria-label='Reject proposal']") as HTMLButtonElement).disabled).toBe(true);

  await setField("Review rationale", "Linking is incomplete.");
  await setChecked("Acknowledge advisory coverage_stub_advisory");
  await setField("Reason for advisory coverage_stub_advisory", "The advisory was considered during rejection.");
  expect((host.querySelector("button[aria-label='Reject proposal']") as HTMLButtonElement).disabled).toBe(false);
  await click("Reject proposal");
  expect(host.textContent).toContain("Review status: rejected");
});

it("handles concurrent review conflicts without optimistic approval and refreshes on request", async () => {
  const approvedDecision = { id: "review-other", decision: "approve", rationale: "Another reviewer accepted it.", advisory_overrides: [], reviewer_actor_name: "Other Reviewer", reviewer_actor_function: "medical_affairs", reviewer_role: "contributor", created_at: "2026-10-03T12:00:00Z" };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "pending"), can_review: true }))
    .mockResolvedValueOnce(response({ error: "Review decision identity is stale.", code: "conflict" }, false, 409))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "approved", approvedDecision), can_review: true }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  await click("Inspect proposal assembly-review-a");
  await setField("Review rationale", "Approve this exact proposal.");
  await click("Approve proposal");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Review decision identity is stale.");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Refresh proposal");
  expect(host.textContent).toContain("Review status: pending");
  expect((host.querySelector("button[aria-label='Approve proposal']") as HTMLButtonElement).disabled).toBe(true);

  await click("Refresh proposal");
  expect(host.textContent).toContain("Review status: approved");
  expect(host.textContent).toContain("Other Reviewer");
});

it("hides old review controls while refreshing after an accepted decision and after a failed detail load", async () => {
  let finishDetail!: (value: ReturnType<typeof response>) => void;
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "pending"), can_review: true }))
    .mockResolvedValueOnce(response({ ok: true, state: reviewState(baseAssembly, "approved", { id: "review-accepted" }) }))
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly] }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishDetail = resolve; }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "approved", { id: "review-accepted" }), can_review: true }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  await click("Inspect proposal assembly-review-a");
  await setField("Review rationale", "Approved after review.");
  await click("Approve proposal");
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();

  await act(async () => finishDetail(response({ error: "Detail unavailable" }, false, 503)));
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Detail unavailable");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
  await click("Retry proposal");
  expect(host.textContent).toContain("Review status: approved");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
});

it("serializes decisions across proposals so another form cannot suppress an accepted response", async () => {
  let finishFirstReview!: (value: ReturnType<typeof response>) => void;
  const secondAssembly = { ...baseAssembly, id: "assembly-review-b", fingerprint: "fingerprint-review-b" };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly, secondAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "pending"), can_review: true }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishFirstReview = resolve; }))
    .mockResolvedValueOnce(response({ assembly: secondAssembly, review_state: reviewState(secondAssembly, "pending"), can_review: true }))
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly, secondAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "approved", { id: "review-a" }), can_review: true }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  await click("Inspect proposal assembly-review-a");
  await setField("Review rationale", "Approve A.");
  await click("Approve proposal");
  await click("Inspect proposal assembly-review-b");
  await setField("Review rationale", "Approve B.");
  expect((host.querySelector("button[aria-label='Approve proposal']") as HTMLButtonElement).disabled).toBe(true);
  await click("Approve proposal");
  expect(fetcher).toHaveBeenCalledTimes(4);

  await act(async () => finishFirstReview(response({ ok: true, state: reviewState(baseAssembly, "approved", { id: "review-a" }) })));
  expect(fetcher).toHaveBeenCalledTimes(6);
  await click("Inspect proposal assembly-review-a");
  expect(host.textContent).toContain("Review status: approved");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
});

it("ignores a late review response after StrictMode workspace switch", async () => {
  let finishReview!: (value: ReturnType<typeof response>) => void;
  const nextAssembly = { ...baseAssembly, id: "assembly-review-new", workspace_id: "ws-new", fingerprint: "fingerprint-new" };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [baseAssembly] }))
    .mockResolvedValueOnce(response({ assembly: baseAssembly, review_state: reviewState(baseAssembly, "pending"), can_review: true }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishReview = resolve; }))
    .mockResolvedValueOnce(response({ assemblies: [nextAssembly] }));
  vi.stubGlobal("fetch", fetcher);

  await renderStrictMode("ws-old");
  await click("Complete proposals");
  await click("Inspect proposal assembly-review-a");
  await setField("Review rationale", "Approve before switching.");
  await click("Approve proposal");

  await act(async () => {
    flushSync(() => root.render(createElement(StrictMode, null, createElement(AssemblyHistory, { workspaceId: "ws-new" }))));
  });
  await act(async () => finishReview(response({ ok: true, state: reviewState(baseAssembly, "approved", { id: "late-review" }) })));

  expect(host.textContent).not.toContain("Review status: approved");
  await click("Complete proposals");
  expect(host.textContent).toContain("assembly-review-new");
  expect(host.textContent).not.toContain("assembly-review-a");
});
