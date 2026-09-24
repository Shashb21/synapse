import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { PATCH as claimsPatch, POST as claimsPost } from "@/app/api/accuracy/claims/route";
import { POST as mergePost } from "@/app/api/accuracy/claims/merge/route";
import { POST as priorityPost } from "@/app/api/accuracy/claims/priority/route";
import { POST as coveragePost } from "@/app/api/accuracy/coverage/route";
import { POST as ideatePost } from "@/app/api/accuracy/ideate/route";
import { POST as reviewPost } from "@/app/api/accuracy/review/route";
import {
  applyClaimValidation,
  claimMetadata,
  getClaim,
  insertClaim,
  listClaims,
  tacticsForGantt,
} from "@/accuracy/store/claim-store";
import {
  createManualClaim,
  isHumanProtectedClaim,
  preserveHumanLocks,
  updateClaim,
} from "@/accuracy/store/claim-edit";
import { listCoverageJoins, listCoveragePairs } from "@/accuracy/store/coverage-store";
import { projectWorkspaceGantt } from "@/accuracy/modules/gantt-project/save-final";
import { projectGanttFromTactics } from "@/accuracy/modules/gantt-project/engine";
import { mergeDedupeCandidates, type MergeCandidate } from "@/accuracy/modules/merge-dedupe/engine";
import type { MergeDedupeOutput } from "@/accuracy/modules/merge-dedupe/module";
import type { StatusDeriveOutput } from "@/accuracy/modules/status-derive/module";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";

registerAccuracyStack();

const actor = { name: "Ada", function: "medical_affairs" as const };

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  return { org_id, workspace_id };
}

function req(url: string, method: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runMerge(org_id: string, workspace_id: string) {
  return runAccuracyModule<MergeDedupeOutput>({
    call_kind: "merge_dedupe",
    agent_role: "judge",
    input: { workspace_id },
    actor,
    org_id,
    workspace_id,
  });
}

async function runStatus(org_id: string, workspace_id: string) {
  return runAccuracyModule<StatusDeriveOutput>({
    call_kind: "status_derive",
    agent_role: "none",
    input: { workspace_id },
    actor,
    org_id,
    workspace_id,
  });
}

/** What extract persists for an inventory tactic (AI, unprotected). */
async function extractLikeTactic(workspace_id: string, name: string, extra: Record<string, unknown> = {}) {
  return insertClaim({
    workspace_id,
    claim_type: "tactic",
    statement: name,
    status: "ongoing",
    metadata: {
      origin: "inventory",
      source_badge: "extract",
      type: "registry",
      evidence_question: "AI question",
      tactic_status: "ongoing",
      provenance: [{ source_file_id: "src-x", block_id: "b-ai", quote: "AI quote" }],
      ...extra,
    },
  });
}

describe("updateClaim / PATCH /api/accuracy/claims", () => {
  it("requires a rationale and records audit + human locks", async () => {
    const { workspace_id } = await freshWorkspace("edit-basic");
    const tactic = await extractLikeTactic(workspace_id, "Registry of 1L patients");

    await expect(
      updateClaim({ workspace_id, claim_id: tactic.id, patch: { statement: "X" }, rationale: "no", actor }),
    ).rejects.toThrow(/rationale/i);

    const res = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: tactic.id,
        rationale: "Name per protocol synopsis",
        patch: {
          statement: "EU5 1L registry",
          type: "rwe_study",
          tactic_status: "planned",
          evidence_question: "Real-world OS in 1L?",
          provenance_quote: "Human corrected quote",
        },
      }),
    );
    expect(res.status).toBe(200);
    const row = (await getClaim(workspace_id, tactic.id))!;
    const meta = claimMetadata(row);
    expect(row.statement).toBe("EU5 1L registry");
    expect(row.status).toBe("planned");
    expect(meta.type).toBe("rwe_study");
    expect(meta.tactic_type).toBe("rwe_study");
    expect(meta.evidence_question).toBe("Real-world OS in 1L?");
    expect((meta.provenance as Array<{ quote: string }>)[0]?.quote).toBe("Human corrected quote");
    expect(meta.human_locked).toEqual(
      expect.arrayContaining(["statement", "type", "tactic_status", "evidence_question", "provenance_quote"]),
    );
    expect(meta.edit_history).toHaveLength(1);
    expect(meta.edit_history![0]!.before.statement).toBe("Registry of 1L patients");
    expect(meta.edit_history![0]!.rationale).toBe("Name per protocol synopsis");
    expect(isHumanProtectedClaim(row)).toBe(true);
  });

  it("rejects wrong-type fields, bad dates, and empty rationale over HTTP", async () => {
    const { workspace_id } = await freshWorkspace("edit-bad");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need OS" });
    const bad = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: gap.id,
        rationale: "ok rationale",
        patch: { start: "2026-01-01" },
      }),
    );
    expect(bad.status).toBe(400);
    const tactic = await extractLikeTactic(workspace_id, "T");
    const dates = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: tactic.id,
        rationale: "ok rationale",
        patch: { start: "2026-06-01", end: "2026-01-01" },
      }),
    );
    expect(dates.status).toBe(400);
    const noRationale = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: tactic.id,
        rationale: " ",
        patch: { statement: "New" },
      }),
    );
    expect(noRationale.status).toBe(400);
    const missing = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: "tac_nope",
        rationale: "ok rationale",
        patch: { statement: "New" },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("POST with rationale creates a manual human-authored claim", async () => {
    const { workspace_id } = await freshWorkspace("manual-create");
    const res = await claimsPost(
      req("/api/accuracy/claims", "POST", {
        workspace_id,
        claim_type: "tactic",
        statement: "Manual PRO study",
        rationale: "Agreed at advisory board",
        fields: { type: "pro_study", tactic_status: "planned", start: "2027-01-01", end: "2027-12-31" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claim: { id: string } };
    const row = (await getClaim(workspace_id, body.claim.id))!;
    const meta = claimMetadata(row);
    expect(meta.origin).toBe("manual");
    expect(meta.source_badge).toBe("manual");
    expect(row.validated).toBe(false);
    expect(row.status).toBe("planned");
    expect(meta.start).toBe("2027-01-01");
    expect(meta.edit_history?.[0]?.action).toBe("create");
    expect(meta.human_locked).toEqual(expect.arrayContaining(["statement", "start", "end", "type"]));

    const noRationale = await claimsPost(
      req("/api/accuracy/claims", "POST", {
        workspace_id,
        claim_type: "gap",
        statement: "x",
        rationale: "",
      }),
    );
    expect(noRationale.status).toBe(400);
  });

  it("preserveHumanLocks restores locked fields from an AI rewrite", () => {
    const prev = {
      human_locked: ["start", "type"],
      start: "2026-01-01",
      type: "registry",
      tactic_type: "registry",
      edit_history: [],
    };
    const next = preserveHumanLocks(prev, {
      start: "2030-01-01",
      type: "slr",
      tactic_type: "slr",
      end: "2031-01-01",
    });
    expect(next.start).toBe("2026-01-01");
    expect(next.type).toBe("registry");
    expect(next.tactic_type).toBe("registry");
    expect(next.end).toBe("2031-01-01");
    expect(next.human_locked).toEqual(["start", "type"]);
  });
});

describe("merge protection + manual merge / unmerge", () => {
  it("engine never absorbs a protected candidate; it becomes a proposal", () => {
    const base = {
      claim_type: "gap" as const,
      status: "draft",
      source_file_id: null,
      reference_pack_id: null,
      external_id: null,
      provenance: [],
    };
    const candidates: MergeCandidate[] = [
      { ...base, id: "a", statement: "Need OS data", validated: true, protected: true, created_at: "2026-02-01" },
      { ...base, id: "b", statement: "Need OS data", validated: true, protected: true, created_at: "2026-01-01" },
      { ...base, id: "c", statement: "Need OS data", validated: false, created_at: "2025-01-01" },
    ];
    const result = mergeDedupeCandidates(candidates);
    expect(Object.keys(result.absorbed)).toEqual(["c"]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.duplicate_id).toBe("a");
    expect(result.proposals[0]?.survivor_id).toBe("b");

    const blocked = mergeDedupeCandidates(candidates, { blocked: new Set(["a::b"]) });
    expect(blocked.proposals).toHaveLength(0);
  });

  it("re-run merge never marks a validated claim merged (bug fix) and proposes instead", async () => {
    const { org_id, workspace_id } = await freshWorkspace("merge-protect");
    const older = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need CNS outcomes" });
    const validated = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need CNS outcomes" });
    await applyClaimValidation({
      workspace_id,
      claim_ids: [validated.id],
      action: "validate",
      rationale: "Confirmed by MA lead",
      actor,
    });
    const run = await runMerge(org_id, workspace_id);
    expect(run.output.merged).toBe(1);
    const claims = await listClaims(workspace_id);
    expect(claims.find((c) => c.id === validated.id)?.status).toBe("validated");
    expect(claims.find((c) => c.id === older.id)?.status).toBe("merged");

    // Two protected duplicates: proposal only.
    const human = await createManualClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need CNS outcomes",
      rationale: "Typed from interview notes",
      actor,
    });
    const rerun = await runMerge(org_id, workspace_id);
    expect(rerun.output.merged).toBe(0);
    expect(rerun.output.proposed).toBe(1);
    const humanRow = (await getClaim(workspace_id, human.id))!;
    const validatedRow = (await getClaim(workspace_id, validated.id))!;
    expect(humanRow.status).toBe("draft");
    expect(validatedRow.status).toBe("validated");
    const proposal =
      claimMetadata(humanRow).merge_proposal ?? claimMetadata(validatedRow).merge_proposal;
    expect(proposal).toBeTruthy();

    // Human dismisses → never re-proposed.
    const target = claimMetadata(humanRow).merge_proposal ? human.id : validated.id;
    const dismiss = await mergePost(
      req("/api/accuracy/claims/merge", "POST", {
        action: "dismiss",
        workspace_id,
        claim_id: target,
        rationale: "Different populations",
      }),
    );
    expect(dismiss.status).toBe(200);
    const third = await runMerge(org_id, workspace_id);
    expect(third.output.proposed).toBe(0);
    expect(claimMetadata((await getClaim(workspace_id, target))!).merge_proposal ?? null).toBeNull();
  });

  it("AI duplicate folds into a human-edited survivor without clobbering locked fields", async () => {
    const { org_id, workspace_id } = await freshWorkspace("merge-survivor");
    const tactic = await extractLikeTactic(workspace_id, "BGB-11417 registry");
    await updateClaim({
      workspace_id,
      claim_id: tactic.id,
      patch: { provenance_quote: "Human quote", tactic_status: "planned", start: "2026-02-01", end: "2026-10-01" },
      rationale: "Corrected from protocol",
      actor,
    });
    // Re-extract produces the same tactic again (AI, unprotected).
    const dup = await extractLikeTactic(workspace_id, "BGB-11417 registry", { tactic_status: "planned" });
    const run = await runMerge(org_id, workspace_id);
    expect(run.output.merged).toBe(1);
    const survivor = (await getClaim(workspace_id, tactic.id))!;
    const meta = claimMetadata(survivor);
    expect(survivor.status).not.toBe("merged");
    expect((await getClaim(workspace_id, dup.id))!.status).toBe("merged");
    expect((meta.provenance as Array<{ quote: string }>)[0]?.quote).toBe("Human quote");
    expect(meta.provenance as unknown[]).toHaveLength(1);
    expect(meta.tactic_status).toBe("planned");
    expect(meta.start).toBe("2026-02-01");
    expect(meta.edit_history).toHaveLength(1);
    await runStatus(org_id, workspace_id);
    const after = claimMetadata((await getClaim(workspace_id, tactic.id))!);
    expect(after.start).toBe("2026-02-01");
    expect(after.human_locked).toContain("provenance_quote");
  });

  it("manual merge + unmerge restores status and the pair is never auto-merged again", async () => {
    const { org_id, workspace_id } = await freshWorkspace("merge-manual");
    const a = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need QoL data" });
    const b = await insertClaim({ workspace_id, claim_type: "gap", statement: "Quality of life evidence" });
    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "PRO study" });

    const short = await mergePost(
      req("/api/accuracy/claims/merge", "POST", {
        action: "merge",
        workspace_id,
        survivor_id: a.id,
        duplicate_id: b.id,
        rationale: "x",
      }),
    );
    expect(short.status).toBe(400);
    const cross = await mergePost(
      req("/api/accuracy/claims/merge", "POST", {
        action: "merge",
        workspace_id,
        survivor_id: a.id,
        duplicate_id: tactic.id,
        rationale: "wrong types",
      }),
    );
    expect(cross.status).toBe(400);

    const merged = await mergePost(
      req("/api/accuracy/claims/merge", "POST", {
        action: "merge",
        workspace_id,
        survivor_id: a.id,
        duplicate_id: b.id,
        rationale: "Same QoL need",
      }),
    );
    expect(merged.status).toBe(200);
    let bRow = (await getClaim(workspace_id, b.id))!;
    expect(bRow.status).toBe("merged");
    expect(claimMetadata(bRow).merged_into).toBe(a.id);
    expect(claimMetadata((await getClaim(workspace_id, a.id))!).merged_from).toContain(b.id);

    const unmerged = await mergePost(
      req("/api/accuracy/claims/merge", "POST", {
        action: "unmerge",
        workspace_id,
        claim_id: b.id,
        rationale: "Actually distinct: caregiver QoL",
      }),
    );
    expect(unmerged.status).toBe(200);
    bRow = (await getClaim(workspace_id, b.id))!;
    expect(bRow.status).toBe("draft");
    expect(claimMetadata(bRow).merged_into ?? null).toBeNull();
    expect(claimMetadata((await getClaim(workspace_id, a.id))!).merged_from).not.toContain(b.id);

    // Make them textually identical: the re-run must still respect the human unmerge.
    await updateClaim({
      workspace_id,
      claim_id: b.id,
      patch: { statement: "Need QoL data" },
      rationale: "Same wording, different population",
      actor,
    });
    const run = await runMerge(org_id, workspace_id);
    expect(run.output.merged).toBe(0);
    expect(run.output.proposed).toBe(0);
    expect((await getClaim(workspace_id, b.id))!.status).toBe("draft");
    expect((await getClaim(workspace_id, a.id))!.status).toBe("draft");
  });
});

describe("status_override writer", () => {
  it("override beats derived status and survives status-derive re-runs", async () => {
    const { org_id, workspace_id } = await freshWorkspace("override");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need OS by subgroup" });
    const res = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: gap.id,
        rationale: "Addressed by published NMA outside this plan",
        patch: { status_override: "addressed" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { statuses: StatusDeriveOutput };
    const row = body.statuses.statuses.find((s) => s.gap_id === gap.id);
    expect(row?.status).toBe("addressed");
    expect(row?.override).toBe(true);
    expect(row?.computed).toBe("open");

    const rerun = await runStatus(org_id, workspace_id);
    expect(rerun.output.statuses.find((s) => s.gap_id === gap.id)?.status).toBe("addressed");
    const meta = claimMetadata((await getClaim(workspace_id, gap.id))!);
    expect(meta.status_override?.rationale).toMatch(/NMA/);
    expect(meta.status_override?.by).toBe("Accuracy reviewer");

    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "T" });
    const wrong = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: tactic.id,
        rationale: "not allowed",
        patch: { status_override: "open" },
      }),
    );
    expect(wrong.status).toBe(400);

    await updateClaim({
      workspace_id,
      claim_id: gap.id,
      patch: { status_override: null },
      rationale: "NMA retracted",
      actor,
    });
    const cleared = await runStatus(org_id, workspace_id);
    expect(cleared.output.statuses.find((s) => s.gap_id === gap.id)?.override).toBe(false);
  });
});

describe("priority band rationale", () => {
  it("requires a user-typed rationale and records it", async () => {
    const { workspace_id } = await freshWorkspace("priority");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need HCRU" });
    const bad = await priorityPost(
      req("/api/accuracy/claims/priority", "POST", {
        workspace_id,
        claim_id: gap.id,
        priority: "high",
        rationale: " ",
      }),
    );
    expect(bad.status).toBe(400);
    const ok = await priorityPost(
      req("/api/accuracy/claims/priority", "POST", {
        workspace_id,
        claim_id: gap.id,
        priority: "high",
        rationale: "Payer blocker in DE",
      }),
    );
    expect(ok.status).toBe(200);
    const meta = claimMetadata((await getClaim(workspace_id, gap.id))!);
    expect(meta.priority).toBe("high");
    expect(meta.priority_rationale).toBe("Payer blocker in DE");
    expect(meta.human_locked).toContain("priority");
    expect(meta.edit_history?.[0]?.fields).toEqual(["priority"]);
  });
});

describe("ideate proposals: manual dates + edit", () => {
  it("manual proposal carries type/dates and can be edited", async () => {
    const { workspace_id } = await freshWorkspace("ideate-edit");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "High priority need",
      validated: true,
      status: "open",
      metadata: { priority: "high" },
    });
    const bad = await ideatePost(
      req("/api/accuracy/ideate", "POST", {
        workspace_id,
        gap_id: gap.id,
        title: "Proposed registry expansion",
        rationale: "Fills the gap",
        start: "2027-09-01",
        end: "2027-01-01",
      }),
    );
    expect(bad.status).toBe(400);
    const res = await ideatePost(
      req("/api/accuracy/ideate", "POST", {
        workspace_id,
        gap_id: gap.id,
        title: "Proposed registry expansion",
        rationale: "Fills the gap",
        start: "2027-01-01",
        end: "2027-09-01",
        type: "registry",
      }),
    );
    expect(res.status).toBe(200);
    const { tactic_id } = (await res.json()) as { tactic_id: string };
    let meta = claimMetadata((await getClaim(workspace_id, tactic_id))!);
    expect(meta.origin).toBe("ideated");
    expect(meta.start).toBe("2027-01-01");
    expect(meta.type).toBe("registry");
    expect(meta.human_locked).toEqual(expect.arrayContaining(["statement", "start", "end"]));

    await updateClaim({
      workspace_id,
      claim_id: tactic_id,
      patch: { statement: "EU registry expansion", design_summary: "Add 3 sites", end: "2027-12-01", type: "rwe_study" },
      rationale: "Refined in planning call",
      actor,
    });
    const row = (await getClaim(workspace_id, tactic_id))!;
    meta = claimMetadata(row);
    expect(row.statement).toBe("EU registry expansion");
    expect(meta.design_summary).toBe("Add 3 sites");
    expect(meta.end).toBe("2027-12-01");
    expect(row.status).toBe("proposed");
  });
});

describe("gantt: human dates survive re-projection", () => {
  it("human-locked dates are pinned; unlocked successors still shift", () => {
    const tactics = [
      { id: "T-a", validated: true, start: "2026-01-01", end: "2026-06-01" },
      { id: "T-b", validated: true, start: "2026-02-01", end: "2026-04-01", depends_on: ["T-a"] },
      {
        id: "T-c",
        validated: true,
        start: "2026-02-01",
        end: "2026-04-01",
        depends_on: ["T-a"],
        dates_locked: true,
      },
    ];
    const bars = projectGanttFromTactics({ tactics });
    expect(bars.find((b) => b.tactic_id === "T-b")?.start).toBe("2026-06-01");
    expect(bars.find((b) => b.tactic_id === "T-c")?.start).toBe("2026-02-01");
    expect(bars.find((b) => b.tactic_id === "T-c")?.end).toBe("2026-04-01");
  });

  it("dates / readout / depends_on entered via edit reach the workspace gantt and stay put", async () => {
    const { org_id, workspace_id } = await freshWorkspace("gantt-edit");
    const up = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Upstream study",
      validated: true,
      status: "validated",
      metadata: { start: "2026-01-01", end: "2026-12-01" },
    });
    const down = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Downstream study",
      validated: true,
      status: "validated",
    });
    expect((await projectWorkspaceGantt(workspace_id)).activities).toHaveLength(1);

    const res = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: down.id,
        rationale: "Dates from steering committee",
        patch: { start: "2026-03-01", end: "2026-09-01", readout: "2026-10-01", depends_on: [up.id] },
      }),
    );
    expect(res.status).toBe(200);
    const badDep = await claimsPatch(
      req("/api/accuracy/claims", "PATCH", {
        workspace_id,
        claim_id: down.id,
        rationale: "bad dependency",
        patch: { depends_on: ["tac_missing"] },
      }),
    );
    expect(badDep.status).toBe(400);

    expect(tacticsForGantt(await listClaims(workspace_id)).find((t) => t.id === down.id)?.dates_locked).toBe(true);
    for (let i = 0; i < 2; i += 1) {
      await runMerge(org_id, workspace_id);
      await runStatus(org_id, workspace_id);
      const { activities } = await projectWorkspaceGantt(workspace_id);
      const bar = activities.find((a) => a.tactic_id === down.id)!;
      expect(bar.start).toBe("2026-03-01");
      expect(bar.end).toBe("2026-09-01");
      expect(bar.readout).toBe("2026-10-01");
      expect(bar.depends_on).toContain(`ACT-${up.id}`);
    }
  });
});

describe("coverage: decide any pair", () => {
  it("accepts a non-candidate pair, lists it, and rejects unknown claims", async () => {
    const { workspace_id } = await freshWorkspace("coverage-any");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need OS" });
    const tactics = [];
    for (let i = 0; i < 5; i += 1) {
      tactics.push(await insertClaim({ workspace_id, claim_type: "tactic", statement: `Tactic ${i}` }));
    }
    const before = await listCoveragePairs(workspace_id);
    const outside = tactics.find(
      (t) => !before.some((p) => p.tactic.id === t.id && p.gap.id === gap.id),
    )!;
    expect(outside).toBeTruthy();

    const res = await coveragePost(
      req("/api/accuracy/coverage", "POST", {
        workspace_id,
        gap_id: gap.id,
        tactic_id: outside.id,
        overall: "partial",
        rationale: "Partially answers OS",
      }),
    );
    expect(res.status).toBe(200);
    const joins = await listCoverageJoins(workspace_id);
    expect(joins.some((j) => j.tactic_id === outside.id && j.validated)).toBe(true);
    const after = await listCoveragePairs(workspace_id);
    expect(after.some((p) => p.tactic.id === outside.id && p.overall === "partial")).toBe(true);

    const bad = await coveragePost(
      req("/api/accuracy/coverage", "POST", {
        workspace_id,
        gap_id: outside.id,
        tactic_id: gap.id,
        overall: "covers",
        rationale: "swapped ids",
      }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("miss-flag promote with an edited statement", () => {
  it("uses the reviewer's wording, keeps the block quote, and locks it", async () => {
    const { org_id, workspace_id } = await freshWorkspace("promote-edit");
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "plan.txt",
      mime: "text/plain",
      checksum: `chk-${Date.now()}`,
      doc_role: "medical",
    });
    const block_id = `${source.id}-B001`;
    await persistParseBlocks({
      workspace_id,
      source_file_id: source.id,
      parser: "local_structured",
      blocks: [
        {
          id: block_id,
          source_file_id: source.id,
          index: 0,
          kind: "prose",
          heading: null,
          text: "Unmet need for pneumonitis monitoring outside academic centres.",
        },
      ],
    });
    const res = await reviewPost(
      req("/api/accuracy/review", "POST", {
        workspace_id,
        block_id,
        action: "promote",
        suggested: "gap",
        statement: "Need community-setting pneumonitis monitoring data",
        rationale: "Clear unmet need",
      }),
    );
    expect(res.status).toBe(200);
    const { claim_id } = (await res.json()) as { claim_id: string };
    const row = (await getClaim(workspace_id, claim_id))!;
    const meta = claimMetadata(row);
    expect(row.statement).toBe("Need community-setting pneumonitis monitoring data");
    expect((meta.provenance as Array<{ quote: string; block_id: string }>)[0]?.block_id).toBe(block_id);
    expect(meta.origin).toBe("completeness_audit");
    expect(meta.human_locked).toContain("statement");
    expect(meta.edit_history?.[0]?.action).toBe("promote");
  });
});
