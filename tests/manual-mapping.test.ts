import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import "@/modules";
import { resetWorkspaceModules, wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { COVERAGE_DIMENSIONS } from "@/lib/iegp/enums";
import { displayedGapStatus } from "@/lib/iegp/engine";
import { buildMappingTableView } from "@/lib/iegp/mapping-table";
import {
  acceptMapping,
  assignTacticToGap,
  createGap,
  humanMappingRow,
  lockCoverageDimension,
  lockCoverageOverall,
  loadState,
  recordMissedTactic,
  rejectMapping,
  resetSeed,
  saveMappingTableRow,
  unassignTacticFromGap,
  validateGap,
} from "@/lib/iegp/store";
import { kgMappingModule, type MappingTableRow } from "@/modules/stages/s4-kg-mapping/module";
import { POST } from "@/app/api/iegp/route";

const HUMAN = { actor_name: "A. Rao", actor_function: "heor" as const };
const MODEL = { actor_name: "S4 model", actor_function: "medical_affairs" as const };

async function workspace(tacticCount = 2) {
  await resetSeed();
  await resetWorkspaceModules();
  const gapId = await createGap({
    statement: "No comparative effectiveness data versus standard of care for the payer dossier.",
    ...HUMAN,
  });
  const tacticIds: string[] = [];
  for (let i = 0; i < tacticCount; i += 1) {
    await recordMissedTactic({
      name: `Manual mapping tactic ${i + 1}`,
      type: "rwe_study",
      evidence_question: `Question ${i + 1}`,
      status: "ongoing",
      ...HUMAN,
    });
    const state = await loadState();
    tacticIds.push(state.tactics.find((t) => t.name === `Manual mapping tactic ${i + 1}`)!.id);
  }
  return { gapId, tacticIds };
}

const gapOf = async (id: string) => (await loadState()).gaps.find((g) => g.id === id)!;
const coverageOf = async (gapId: string, tacticId: string) =>
  (await loadState()).coverages.find((c) => c.gap_id === gapId && c.tactic_id === tacticId);

async function post(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HUMAN, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok?: boolean; error?: string } };
}

describe("human validation survives a model re-run (syncComputedGapStatuses)", () => {
  it("keeps a human-validated status and its validation, flagging the new computation stale", async () => {
    const { gapId, tacticIds } = await workspace(1);
    await validateGap({ gap_id: gapId, ...HUMAN, note: "Checked: nothing covers this yet." });
    // A model run maps an ongoing tactic: the engine would now compute Partial.
    await assignTacticToGap({ gap_id: gapId, tactic_id: tacticIds[0]!, ...MODEL, coverage: "partial" });
    const gap = await gapOf(gapId);
    expect(gap.human_validated).toBe(true);
    expect(gap.status_lock.locked).toBe(true);
    expect(gap.status).toBe("validated_open");
    expect(gap.computed_status).toBe("validated_partial");
    expect(gap.status_override).toMatchObject({ status: "validated_open", stale: true, actor_name: HUMAN.actor_name });
    expect(displayedGapStatus(gap)).toBe("validated_open");
    const audit = (await loadState()).audit.filter((a) => a.entity_id === gapId && a.action === "status_override_stale");
    expect(audit.length).toBeGreaterThan(0);
  });

  it("a person's own mapping edit still recomputes the status", async () => {
    const { gapId, tacticIds } = await workspace(1);
    await validateGap({ gap_id: gapId, ...HUMAN, note: "Checked." });
    await assignTacticToGap({ gap_id: gapId, tactic_id: tacticIds[0]!, ...HUMAN, note: "Mine.", human: true });
    const gap = await gapOf(gapId);
    expect(gap.status).toBe("validated_partial");
    expect(gap.status_override).toBeNull();
  });
});

describe("human rejections and removals bind every later model run", () => {
  it("refuses a model assignment of a pair a person rejected; a person may still map it", async () => {
    const { gapId, tacticIds } = await workspace(1);
    const tacticId = tacticIds[0]!;
    await rejectMapping({ gap_id: gapId, tactic_id: tacticId, ...HUMAN, note: "Wrong population." });
    await expect(assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, ...MODEL })).rejects.toThrow(
      /rejected or removed/,
    );
    expect(await coverageOf(gapId, tacticId)).toBeUndefined();
    await assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, ...HUMAN, note: "On reflection it fits.", human: true });
    expect(await coverageOf(gapId, tacticId)).toBeDefined();
    const decision = (await loadState()).mapping_suggestions.find((m) => m.gap_id === gapId && m.tactic_id === tacticId);
    expect(decision?.status).toBe("accepted");
  });

  it("unassigns with a rationale and audit, and the model cannot re-add the pair", async () => {
    const { gapId, tacticIds } = await workspace(1);
    const tacticId = tacticIds[0]!;
    await assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, ...MODEL, coverage: "partial" });
    await expect(
      unassignTacticFromGap({ gap_id: gapId, tactic_id: tacticId, rationale: "x", ...HUMAN }),
    ).rejects.toThrow(/rationale/i);
    await unassignTacticFromGap({ gap_id: gapId, tactic_id: tacticId, rationale: "Does not bear on it.", ...HUMAN });
    const state = await loadState();
    expect(state.coverages.some((c) => c.gap_id === gapId && c.tactic_id === tacticId)).toBe(false);
    expect(state.audit.some((a) => a.action === "unassign_tactic" && a.detail.includes("Does not bear on it."))).toBe(true);
    expect((await gapOf(gapId)).status).toBe("validated_open");
    await expect(assignTacticToGap({ gap_id: gapId, tactic_id: tacticId, ...MODEL })).rejects.toThrow(/rejected or removed/);
  });

  it("reject on a pair S4 already committed removes it; accept on one marks it human-accepted", async () => {
    const { gapId, tacticIds } = await workspace(2);
    const [t1, t2] = tacticIds as [string, string];
    await assignTacticToGap({ gap_id: gapId, tactic_id: t1, ...MODEL, coverage: "partial" });
    await assignTacticToGap({ gap_id: gapId, tactic_id: t2, ...MODEL, coverage: "limited" });
    await acceptMapping({ gap_id: gapId, tactic_id: t1, ...HUMAN, note: "Agreed." });
    await rejectMapping({ gap_id: gapId, tactic_id: t2, ...HUMAN, note: "Too thin." });
    const state = await loadState();
    expect(state.coverages.find((c) => c.gap_id === gapId && c.tactic_id === t1)?.overall).toBe("partial");
    expect(state.coverages.some((c) => c.gap_id === gapId && c.tactic_id === t2)).toBe(false);
    const view = buildMappingTableView(state, null).find((row) => row.gap_id === gapId)!;
    expect(view.decisions[t1]?.status).toBe("accepted");
    expect(view.decisions[t2]?.status).toBe("rejected");
  });
});

describe("S4 re-run leaves human decisions alone", () => {
  let savedStub: string | undefined;
  beforeEach(async () => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    await wipePlatform();
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const route: ResolvedRoute = {
    stage: "S4",
    provider_id: "anthropic-claude",
    provider_label: "Claude",
    model: "claude-test",
    auth: "api_key",
    connected: true,
    params: { temperature: 0, max_tokens: 4096 },
    fallbacks: [],
    degraded: false,
    reason: null,
  };
  const dims = Object.fromEntries(COVERAGE_DIMENSIONS.map((d) => [d, "partial"]));

  it("skips human-rejected pairs, tells the model about them, and never rewrites a human-locked coverage", async () => {
    const { gapId, tacticIds } = await workspace(3);
    const [rejected, locked, fresh] = tacticIds as [string, string, string];
    await rejectMapping({ gap_id: gapId, tactic_id: rejected, ...HUMAN, note: "Wrong comparator." });
    const covId = await assignTacticToGap({
      gap_id: gapId,
      tactic_id: locked,
      ...HUMAN,
      note: "I assessed this one.",
      coverage: "limited",
      human: true,
      lock_coverage: true,
    });
    const bodies: Record<string, unknown>[] = [];
    const ctx: ModuleContext = {
      workspace_id: "default",
      actor: { name: MODEL.actor_name, function: MODEL.actor_function },
      role: "medical_affairs",
      route,
      run: { id: "test", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
      complete: async ({ purpose, user }) => {
        const body = JSON.parse(user) as Record<string, unknown>;
        if (purpose === "mapping-table-proposer") {
          bodies.push(body);
          const ids = (body.gaps as { id: string }[]).map((g) => g.id);
          return {
            rows: ids.map((id) => ({
              gap_id: id,
              mapping_status: "addressed",
              confidence: 90,
              rationale: "model row",
              mappings: [rejected, locked, fresh].map((tactic_id) => ({
                tactic_id,
                coverage: "full",
                confidence: 90,
                rationale: `${tactic_id} covers it`,
                dimensions: dims,
              })),
            })),
          };
        }
        if (purpose === "mapping-table-critic") {
          return {
            reviews: (body.rows as { gap: { id: string }; mappings: { tactic_id: string }[] }[]).map((row) => ({
              gap_id: row.gap.id,
              verdict: "keep",
              confidence: 80,
              note: "ok",
              mappings: row.mappings.map((m) => ({ tactic_id: m.tactic_id, verdict: "keep", note: "ok" })),
            })),
          };
        }
        return {
          verdicts: (body.rows as { gap: { id: string } }[]).map((row) => ({
            gap_id: row.gap.id,
            verdict: "accept",
            confidence: 90,
            reason: "fine",
          })),
        };
      },
    };
    const { output } = await kgMappingModule.run(
      kgMappingModule.inputSchema.parse({ gap_ids: [gapId], tactic_ids: tacticIds, dry_run: false }),
      ctx,
    );
    const gapPrompt = (bodies[0]!.gaps as { id: string; human_rejected_tactic_ids?: string[] }[])[0]!;
    expect(gapPrompt.human_rejected_tactic_ids).toEqual([rejected]);
    const row = output.rows.find((r) => r.gap_id === gapId)!;
    expect(row.mappings.map((m) => m.tactic_id)).not.toContain(rejected);

    const state = await loadState();
    expect(state.coverages.some((c) => c.gap_id === gapId && c.tactic_id === rejected)).toBe(false);
    const human = state.coverages.find((c) => c.id === covId)!;
    expect(human.overall).toBe("limited");
    expect(human.overall_lock.actor_name).toBe(HUMAN.actor_name);
    // A new suggestion is still allowed: S4 may add a pair nobody decided on.
    expect(state.coverages.find((c) => c.gap_id === gapId && c.tactic_id === fresh)?.overall).toBe("full");
  });
});

describe("/mappings row save is persisted and wins over S4", () => {
  it("stores the status and exact tactic set, unassigning removed tactics", async () => {
    const { gapId, tacticIds } = await workspace(2);
    const [t1, t2] = tacticIds as [string, string];
    await assignTacticToGap({ gap_id: gapId, tactic_id: t1, ...MODEL, coverage: "partial" });
    await expect(
      saveMappingTableRow({ gap_id: gapId, tactic_ids: [t2], mapping_status: "partially_addressed", ...HUMAN, rationale: "" }),
    ).rejects.toThrow(/rationale/i);
    await saveMappingTableRow({
      gap_id: gapId,
      tactic_ids: [t2],
      mapping_status: "partially_addressed",
      ...HUMAN,
      rationale: "t2 is the relevant study, not t1.",
    });
    const state = await loadState();
    expect(state.coverages.filter((c) => c.gap_id === gapId).map((c) => c.tactic_id)).toEqual([t2]);
    expect(humanMappingRow(state, gapId)).toMatchObject({
      mapping_status: "partially_addressed",
      rationale: "t2 is the relevant study, not t1.",
    });
    await expect(assignTacticToGap({ gap_id: gapId, tactic_id: t1, ...MODEL })).rejects.toThrow(/rejected or removed/);

    const proposal: MappingTableRow = {
      gap_id: gapId,
      gap_name: "x",
      tactic_ids: [t1],
      tactic_names: ["t1"],
      mapping_status: "addressed",
      confidence: 90,
      rationale: ["S4 says addressed"],
      mappings: [],
      review: null,
    };
    const view = buildMappingTableView(state, [proposal]).find((row) => row.gap_id === gapId)!;
    expect(view.source).toBe("human");
    expect(view.mapping_status).toBe("partially_addressed");
    expect(view.tactic_ids).toEqual([t2]);
    expect(view.unreviewed_tactic_ids).toEqual([]);

    // A later save replaces the stored row rather than adding a second one.
    await saveMappingTableRow({ gap_id: gapId, tactic_ids: [], mapping_status: "open", ...HUMAN, rationale: "Nothing covers it." });
    const after = await loadState();
    expect(humanMappingRow(after, gapId)?.mapping_status).toBe("open");
    expect(after.mapping_suggestions.filter((m) => m.gap_id === gapId && m.tactic_id.startsWith("__row__:"))).toHaveLength(1);
    expect(after.coverages.some((c) => c.gap_id === gapId)).toBe(false);
  });
});

describe("manual create with coverage and manual coverage edits", () => {
  it("maps a tactic with a locked overall and dimensions in one step", async () => {
    const { gapId, tacticIds } = await workspace(1);
    const covId = await assignTacticToGap({
      gap_id: gapId,
      tactic_id: tacticIds[0]!,
      ...HUMAN,
      note: "Head-to-head RWE in the dossier population.",
      coverage: "full",
      dimensions: { relevance: "yes", population: "yes" },
      human: true,
      lock_coverage: true,
    });
    const cov = (await loadState()).coverages.find((c) => c.id === covId)!;
    expect(cov.overall).toBe("full");
    expect(cov.overall_lock.locked).toBe(true);
    expect(cov.dimensions.relevance).toMatchObject({ value: "yes" });
    expect(cov.dimensions.relevance.lock.locked).toBe(true);
    expect(cov.dimensions.comparator.value).toBe("unknown");
    expect(cov.dimensions.comparator.lock.locked).toBe(false);
    expect((await gapOf(gapId)).status).toBe("validated_addressed");
    await expect(
      assignTacticToGap({
        gap_id: (await createGap({ statement: "Another gap entirely.", ...HUMAN })),
        tactic_id: tacticIds[0]!,
        ...HUMAN,
        coverage: "full",
        human: true,
        lock_coverage: true,
      }),
    ).rejects.toThrow(/rationale/i);
  });

  it("requires a person's own rationale for coverage edits", async () => {
    const { gapId, tacticIds } = await workspace(1);
    const covId = await assignTacticToGap({ gap_id: gapId, tactic_id: tacticIds[0]!, ...MODEL, coverage: "partial" });
    await expect(
      lockCoverageDimension({ coverage_id: covId, dimension: "relevance", value: "yes", rationale: "", ...HUMAN }),
    ).rejects.toThrow(/rationale/i);
    await expect(
      lockCoverageOverall({ coverage_id: covId, overall: "limited", rationale: " ", ...HUMAN }),
    ).rejects.toThrow(/rationale/i);
    await lockCoverageDimension({ coverage_id: covId, dimension: "relevance", value: "yes", rationale: "My reading.", ...HUMAN });
    const cov = (await loadState()).coverages.find((c) => c.id === covId)!;
    expect(cov.dimensions.relevance).toMatchObject({ value: "yes", rationale: "My reading." });
  });
});

describe("route actions", () => {
  it("assign_tactic with a verdict, unassign, lock_dimension, accept and reject need a rationale", async () => {
    const { gapId, tacticIds } = await workspace(2);
    const [t1, t2] = tacticIds as [string, string];
    expect(
      (await post({ action: "assign_tactic", gap_id: gapId, tactic_id: t1, overall: "partial", dim_relevance: "yes" })).status,
    ).toBe(400);
    const ok = await post({
      action: "assign_tactic",
      gap_id: gapId,
      tactic_id: t1,
      overall: "partial",
      dim_relevance: "yes",
      dim_population: "",
      rationale: "Covers the elderly slice only.",
    });
    expect(ok).toMatchObject({ status: 200, json: { ok: true } });
    const cov = (await coverageOf(gapId, t1))!;
    expect(cov.overall).toBe("partial");
    expect(cov.overall_lock.locked).toBe(true);
    expect(cov.dimensions.relevance.value).toBe("yes");
    expect(cov.dimensions.population.value).toBe("unknown");

    // Plain assign with no verdict still works without a rationale (Map existing tactic).
    expect((await post({ action: "assign_tactic", gap_id: gapId, tactic_id: t2 })).status).toBe(200);
    expect((await coverageOf(gapId, t2))?.overall).toBe("unassessed");

    expect((await post({ action: "lock_dimension", coverage_id: cov.id, dimension: "timing", value: "no" })).status).toBe(400);
    expect(
      (await post({ action: "lock_dimension", coverage_id: cov.id, dimension: "timing", value: "no", rationale: "Readout is late." })).status,
    ).toBe(200);
    expect((await post({ action: "lock_overall", coverage_id: cov.id, overall: "full" })).status).toBe(400);

    expect((await post({ action: "unassign_tactic", gap_id: gapId, tactic_id: t2 })).status).toBe(400);
    expect((await post({ action: "unassign_tactic", gap_id: gapId, tactic_id: t2, rationale: "Not relevant here." })).status).toBe(200);
    expect(await coverageOf(gapId, t2)).toBeUndefined();

    expect((await post({ action: "accept_mapping", gap_id: gapId, tactic_id: t2 })).status).toBe(400);
    const accepted = await post({
      action: "accept_mapping",
      gap_id: gapId,
      tactic_id: t2,
      overall: "limited",
      dimensions: JSON.stringify({ relevance: "partial" }),
      rationale: "Accept the S4 proposal.",
    });
    expect(accepted.status).toBe(200);
    expect((await coverageOf(gapId, t2))?.overall).toBe("limited");
    expect((await post({ action: "reject_mapping", gap_id: gapId, tactic_id: t2 })).status).toBe(400);
    expect((await post({ action: "reject_mapping", gap_id: gapId, tactic_id: t2, rationale: "Changed my mind." })).status).toBe(200);
    expect(await coverageOf(gapId, t2)).toBeUndefined();
  });
});

describe("gap page coverage forms", () => {
  it("asks for the person's own rationale instead of filing the model's", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/gaps/[id]/page.tsx"), "utf8");
    expect(src).not.toContain('<input type="hidden" name="rationale" value={cell.rationale} />');
    expect(src).not.toContain("defaultValue={c.overall_rationale}");
    expect(src).toContain("AssignTacticWithCoverage");
    expect(src).toContain("UnassignTactic");
    const workbench = readFileSync(path.join(process.cwd(), "src/components/mapping-table-workbench.tsx"), "utf8");
    expect(workbench).toContain('action="accept_mapping"');
    expect(workbench).toContain('action="reject_mapping"');
  });
});
