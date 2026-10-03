/** @vitest-environment jsdom */
/** Exercise immutable assembly proposal inspection through real React DOM interactions. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssemblyHistory } from "@/components/accuracy/assembly-history";

let host: HTMLDivElement;
let root: Root;

const gapPayload = {
  id: "G-1",
  statement: "Burden gap statement",
  external_id: "BGB-1",
  provenance: [{ source_file_id: "source-1", block_id: "block-1", quote: "gap source quote" }],
};
const uncoveredGapPayload = {
  id: "G-2",
  statement: "Uncovered gap statement",
  provenance: [{ source_file_id: "source-1", block_id: "block-2", quote: "uncovered quote" }],
};
const tacticPayload = {
  id: "T-1",
  name: "Field activity",
  tactic_type: "field_activity",
  provenance: [{ source_file_id: "source-1", block_id: "block-3", quote: "tactic source quote" }],
};
const blockedAssembly = {
  id: "assembly-a",
  workspace_id: "ws",
  created_at: "2026-10-03T09:00:00Z",
  actor: { name: "Extraction agent", function: "medical_affairs" },
  fingerprint: "fingerprint-a",
  source_file_ids: ["source-1"],
  items: [
    {
      id: "gap-v1",
      claim_id: "gap-claim",
      claim_type: "gap",
      canonical_claim_id: "gap-canonical",
      source_file_id: "source-1",
      run_id: "run-gap",
      snapshot_id: "snapshot-gap",
      iteration: 2,
      item_index: 0,
      created_at: "2026-10-03T08:00:00Z",
      payload: gapPayload,
      reason: "Selected by judged gap output",
    },
    {
      id: "gap-v2",
      claim_id: "gap-claim-2",
      claim_type: "gap",
      canonical_claim_id: "gap-canonical-2",
      source_file_id: "source-1",
      run_id: "run-gap",
      snapshot_id: null,
      iteration: null,
      item_index: 1,
      created_at: "2026-10-03T08:01:00Z",
      payload: uncoveredGapPayload,
      reason: "Selected final-only gap from judged output",
    },
    {
      id: "tactic-v1",
      claim_id: "tactic-claim",
      claim_type: "tactic",
      canonical_claim_id: "tactic-canonical",
      source_file_id: "source-1",
      run_id: "run-tactic",
      snapshot_id: "snapshot-tactic",
      iteration: 1,
      item_index: 0,
      created_at: "2026-10-03T08:02:00Z",
      payload: tacticPayload,
      reason: "Selected by judged tactic output",
    },
  ],
  mappings: [{ gap_version_id: "gap-v1", tactic_version_id: "tactic-v1" }],
  coverage: [
    {
      gap_version_id: "gap-v1",
      tactic_version_id: "tactic-v1",
      run_id: "coverage-run-1",
      mode: "stub",
      input: { selected_versions: { gap_version_id: "gap-v1", tactic_version_id: "tactic-v1", gap_payload: gapPayload, tactic_payload: tacticPayload } },
      output: { gap_id: "gap-v1", tactic_id: "tactic-v1", overall: "partial", quote_block_ids: ["block-1"], rationale: "Coverage rationale" },
    },
    {
      gap_version_id: "gap-v2",
      tactic_version_id: "tactic-v1",
      run_id: "coverage-run-2",
      mode: "llm",
      input: {},
      output: { gap_id: "gap-v2", tactic_id: "tactic-v1", overall: "not_relevant", quote_block_ids: [], rationale: "Not relevant rationale" },
    },
  ],
  linking_complete: false,
  output: { gaps: [gapPayload, uncoveredGapPayload], tactics: [tacticPayload] },
  checks: {
    checker_version: "assembly-domain-v1",
    status: "blocked",
    findings: [
      { code: "linking_incomplete", severity: "blocking", item_version_ids: [], message: "Assembly linking has not completed." },
      { code: "coverage_stub_advisory", severity: "advisory", item_version_ids: ["gap-v1", "tactic-v1"], message: "Stub coverage is recorded as advisory structure only." },
    ],
  },
};
const passedAssembly = {
  ...blockedAssembly,
  id: "assembly-b",
  fingerprint: "fingerprint-b",
  linking_complete: true,
  checks: { checker_version: "assembly-domain-v1", status: "passed", findings: [] },
};

function response(body: object, ok = true) {
  return { ok, json: async () => body };
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

async function render() {
  await act(async () => root.render(createElement(AssemblyHistory, { workspaceId: "ws" })));
}

async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it("loads list and detail on demand with exact lineage, findings and uncovered outcomes", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ assemblies: [blockedAssembly, passedAssembly] }))
    .mockResolvedValueOnce(response({ assembly: blockedAssembly }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");

  await click("Complete proposals");
  expect(fetcher).toHaveBeenCalledWith("/api/accuracy/assemblies?workspace_id=ws", { cache: "no-store" });
  for (const text of ["assembly-a", "assembly-b", "Unapproved proposal", "Deterministic checks blocked", "Deterministic checks passed"]) {
    expect(host.textContent).toContain(text);
  }

  await click("Inspect proposal assembly-a");
  expect(fetcher).toHaveBeenCalledWith("/api/accuracy/assemblies?workspace_id=ws&assembly_id=assembly-a", { cache: "no-store" });
  for (const text of [
    "Fingerprint: fingerprint-a",
    "Source scope: source-1",
    "Linking incomplete",
    "gap-v1",
    "gap-canonical",
    "run-gap",
    "snapshot-gap",
    "Iteration: 2",
    "Selected by judged gap output",
    "gap source quote",
    "gap-v2",
    "Judged final output (no snapshot)",
    "Judged final output",
    "Selected final-only gap from judged output",
    "tactic-v1",
    "Field activity",
    "Selected by judged tactic output",
    "Mapping: gap-v1 -> tactic-v1",
    "Uncovered gap: gap-v2",
    "coverage-run-1",
    "Stub coverage advisory",
    "partial",
    "coverage-run-2",
    "not_relevant",
    "linking_incomplete",
    "coverage_stub_advisory",
    "Assembly linking has not completed.",
  ]) {
    expect(host.textContent).toContain(text);
  }
  for (const absent of ["Approve", "Reject assembly", "Add gap", "Remove tactic", "Select version", "Accuracy score"]) {
    expect(host.textContent).not.toContain(absent);
  }
});

it("announces loading, supports retry after failure and explains empty history", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(response({ error: "Sign in to access assemblies" }, false))
    .mockResolvedValueOnce(response({ assemblies: [] }));
  vi.stubGlobal("fetch", fetcher);

  await render();
  await click("Complete proposals");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading complete proposals");
  await act(async () => finish(response({ error: "Transient failure" }, false)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Transient failure");
  await click("Retry proposals");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Sign in to access assemblies");
  await click("Retry proposals");
  expect(host.textContent).toContain("No complete proposals recorded for this workspace.");
});
