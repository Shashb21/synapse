/** Scripted source evidence; real Postgres publication, assembly, authentication and live readers. */
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { activateAccuracyModule, activeAccuracyModuleId, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { inspectQuoteSpans, runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import { generateExtractionAssembly } from "@/accuracy/kernel/assembly-generation";
import { selectExtractionSnapshot } from "@/accuracy/modules/extraction-judge";
import { needExtractOutputSchema, type NeedExtractOutput } from "@/accuracy/modules/need-extract/module";
import { accuracyTransactionActive, ensureAccuracySchema } from "@/accuracy/store/db";
import { applyExtractionBatch, createExtractionBatch } from "@/accuracy/store/extraction-batch-store";
import { publishGeneratedItemHistory, readItemHistory } from "@/accuracy/store/item-history-store";
import { approvedLiveInventory } from "@/accuracy/store/assembly-review-store";
import { listClaims, listDownstreamClaims } from "@/accuracy/store/claim-store";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks, readParseBlocks } from "@/accuracy/store/parse-store";
import { POST as reviewPost } from "@/app/api/accuracy/assemblies/route";
import { newId } from "@/modules/kernel/ids";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));
const actor = { name: "Selected lineage fixture", function: "medical_affairs" as const };
const subject = "kan4-exact-reviewer";
let workspace_id: string | undefined;
let original: string | undefined;
afterEach(async () => {
  if (original) activateAccuracyModule({ call_kind: "need_extract", module_id: original, activated_by: "restore" });
  if (workspace_id) await deleteWorkspace(workspace_id);
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

it("publishes V1 beating V3 with honest normalized final lineage, then requires authenticated exact approval for downstream content", async () => {
  registerAccuracyStack(); await ensureAccuracySchema();
  const org_id = await createOrganization(newId("kan4-lineage"));
  workspace_id = await createWorkspace({ org_id, name: "KAN4 selected lineage", slug: newId("kan4") });
  const scope = { workspace_id, org_id };
  await grantOrganizationAccess({ subject, org_id });
  const source = await insertSourceFile({ ...scope, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local", blocks: [{ id: block_id,
    source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Comparative evidence is needed for the regional population." }] });
  const blocks = await readParseBlocks(workspace_id, source.id);
  original = activeAccuracyModuleId("need_extract")!;
  const module_id = newId("kan4-source-fixture");
  // The public native cycle supplies every persisted event. This bounded source fixture
  // uses the production selector and normalization schema; it makes no live accuracy claim.
  registerAccuracyModule({
    manifest: { id: module_id, call_kind: "need_extract", version: "fixture-v1", title: "Scripted selected source",
      summary: "Four produced source snapshots", agentic: true, contract: 1 },
    inputSchema: z.object({ workspace_id: z.string(), source_file_id: z.string() }), outputSchema: needExtractOutputSchema,
    run: async (rawInput, ctx) => {
      const input = z.object({ workspace_id: z.string(), source_file_id: z.string() }).parse(rawInput);
      const cycle = await runShallowAgenticCycle({ run: ctx.run, maxExchanges: 3,
        proposer: async iteration => {
          expect(accuracyTransactionActive()).toBe(false);
          return { gaps: [{ candidate_index: 0, statement: `Regional need V${iteration}`, external_id: null,
            provenance: [{ source_file_id: input.source_file_id, block_id,
              quote: iteration < 2 ? "Comparative evidence is needed" : "Invented V3 evidence" }] }] };
        },
        onSnapshot: async draft => ({ quote_validity: inspectQuoteSpans({ spans: draft.gaps[0].provenance, blocks }).signals,
          invariant_failures: [], completeness: "not_checked" }),
        critic: async () => ({ score: 0.8, issues: [] }),
        onCompleteness: async () => ({ risk_level: "none_detected", checked_block_ids: [block_id], unchecked_block_ids: [],
          suspected_omissions: [], prior_issue_resolutions: [] }),
        select: async candidates => selectExtractionSnapshot(candidates, () => true),
      });
      return { output: needExtractOutputSchema.parse({ ...input, source_complete: true,
        gaps: cycle.final.gaps.map(item => ({ ...item, id: newId("gap") })) }), summary: "Selected V1 regional need" };
    },
  });
  activateAccuracyModule({ call_kind: "need_extract", module_id, activated_by: "KAN4 lineage fixture" });
  const extracted = await runAccuracyModule<NeedExtractOutput>({ ...scope, actor, call_kind: "need_extract",
    input: { workspace_id, source_file_id: source.id } });
  const progression = await readAgentProgression({ workspace_id, run_id: extracted.run_id });
  expect(progression!.events.filter(row => row.event_type === "snapshot").map(row => row.iteration)).toEqual([0, 1, 2, 3]);
  expect(progression!.events.at(-1)!.event).toMatchObject({ event_type: "judgment", selected_iteration: 1 });
  const selected = extracted.output.gaps[0];
  expect(selected.statement).toBe("Regional need V1");
  expect(selected).not.toHaveProperty("candidate_index");
  const raw = progression!.events.find(row => row.event_type === "snapshot" && row.iteration === 1)!.event;
  expect(raw).toMatchObject({ output: { gaps: [{ candidate_index: 0, statement: "Regional need V1" }] } });

  const batch = await createExtractionBatch(workspace_id, source.id, ["need_extract"]);
  await applyExtractionBatch(batch, [extracted.run_id], [selected.id], async () => {
    await publishGeneratedItemHistory({ workspace_id: scope.workspace_id, source_file_id: source.id,
      run_id: extracted.run_id, claim_type: "gap", final_claims: [{ id: selected.id, workspace_id: scope.workspace_id,
        source_file_id: source.id, claim_type: "gap", statement: selected.statement }] });
  });
  const assembly = await generateExtractionAssembly({ ...scope, actor, source_file_ids: [source.id],
    extraction_run_ids: [extracted.run_id], generation_key: batch.id, requested_kinds: ["need_extract"] });
  expect(assembly.checks.status).toBe("passed");
  expect(assembly.output.gaps).toEqual([selected]);
  expect(assembly.items).toMatchObject([{ run_id: extracted.run_id, snapshot_id: null, iteration: null, payload: selected }]);
  expect(assembly.items[0].reason).toContain("judged final output");
  const history = await readItemHistory(workspace_id, assembly.items[0].claim_id);
  expect(history!.versions).toMatchObject([{ run_id: extracted.run_id, snapshot_id: null, iteration: null, payload: selected }]);
  const claims = await listClaims(workspace_id);
  const retained = (await Promise.all(claims.map(claim => readItemHistory(scope.workspace_id, claim.id))))
    .flatMap(history => history?.versions ?? []);
  expect(retained.filter(version => version.snapshot_id !== null).map(version => version.iteration).sort()).toEqual([0, 1, 2, 3]);
  await expect(listDownstreamClaims(workspace_id, { limit: null })).rejects.toMatchObject({ code: "approval_required" });

  vi.stubEnv("OWNER_EMAILS", "kan4-owner@example.test");
  const review = { workspace_id, assembly_id: assembly.id, expected_fingerprint: assembly.fingerprint,
    expected_review_id: null, decision: "approve", rationale: "Reviewed exact V1 normalized regional source evidence", advisory_overrides: [] };
  const post = (body: unknown) => reviewPost(new Request("http://localhost/api/accuracy/assemblies", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  sessionContext.mockResolvedValue({ signed_in: false, demo: false, role: "viewer", actor, session: null });
  expect((await post(review)).status).toBe(401);
  sessionContext.mockResolvedValue({ signed_in: true, demo: false, role: "medical_affairs", actor,
    session: { subject, email: "kan4-owner@example.test", provider_id: "test-idp", actor, role: "medical_affairs" } });
  expect((await post({ ...review, expected_fingerprint: "stale" })).status).toBe(409);
  await expect(listDownstreamClaims(workspace_id, { limit: null })).rejects.toMatchObject({ code: "approval_required" });
  const approved = await post(review);
  expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
  const response = await approved.json();
  expect(response.review).toMatchObject({ reviewer_subject: subject, fingerprint: assembly.fingerprint });
  expect((await approvedLiveInventory(workspace_id))!.selected_items.map(item => item.payload)).toEqual([selected]);
  expect((await listDownstreamClaims(workspace_id, { limit: null })).map(claim => claim.statement)).toEqual(["Regional need V1"]);
  // A stale competing request cannot replace authority on the exact approved assembly.
  expect((await post({ ...review, decision: "reject" })).status).toBe(409);
  expect((await listDownstreamClaims(workspace_id, { limit: null })).map(claim => claim.statement)).toEqual(["Regional need V1"]);
});
