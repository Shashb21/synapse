import { describe, expect, it, vi } from "vitest";
import { inventoryExtractModule } from "@/accuracy/modules/inventory-extract/module";
import { needExtractModule } from "@/accuracy/modules/need-extract/module";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks, editParseBlock, splitParseBlock, mergeParseBlocks } from "@/accuracy/store/parse-store";
import { readStructuredFields, emptyTacticStructuredFields, emptyGapStructuredFields } from "@/accuracy/domain/structured-fields";
import { claimFactualRevision, claimValidationFreshness } from "@/accuracy/domain/structured-fields";
import { applyClaimValidation, claimMetadata, getClaim, insertClaim, listClaims, updateClaimMetadata } from "@/accuracy/store/claim-store";
import { preserveHumanLocks, updateClaim } from "@/accuracy/store/claim-edit";
import { insertCoverageJoin, listCoverageJoins } from "@/accuracy/store/coverage-store";
import { asTacticLifecycle, deriveGapStatus } from "@/accuracy/modules/status-derive/engine";
import { POST as extractPost } from "@/app/api/accuracy/extract/route";
import { runAccuracyExperiment } from "@/accuracy/experiments/run";
import { accuracyRouteConfig, setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { openAi } from "@/modules/llm/provider";
import * as session from "@/modules/auth/session";
import { accuracyDb, accuracyTransactionActive } from "@/accuracy/store/db";
import { sql } from "drizzle-orm";
import { INVENTORY_PROPOSER_SYSTEM } from "@/accuracy/modules/inventory-extract/prompts";
import { NEED_PROPOSER_SYSTEM } from "@/accuracy/modules/need-extract/prompts";
import { captureMergeInputs, prepareMergeJudgment, applyMergeJudgment } from "@/accuracy/modules/merge-dedupe/module";
import { withAccuracyTransaction } from "@/accuracy/store/db";
import type { AgentEvent } from "@/accuracy/kernel/agent-events";
import { copyExperimentWorkspace } from "@/accuracy/experiments/copy-workspace";

async function sourceFixture(text: string) {
  const org_id = await createOrganization(`structured-${crypto.randomUUID()}`);
  const workspace_id = await createWorkspace({ org_id, name: "Structured facts", slug: crypto.randomUUID() });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "interview.txt", mime: "text/plain",
    checksum: crypto.randomUUID(), doc_role: "medical" });
  const block_id = `${source.id}-B001`;
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local_structured",
    blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text }] });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

function context(fixture: Awaited<ReturnType<typeof sourceFixture>>, output: unknown): AccuracyModuleContext {
  return {
    ...fixture, actor: { name: "Ada", function: "medical_affairs" }, role: "medical_affairs",
    run: { id: crypto.randomUUID(), note: () => {}, step: async (_name, fn) => fn(), steps: () => [],
      recordAgentEvent: async () => {}, usageSummary: () => ({ token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 }) },
    route: { call_kind: "inventory_extract", role: "proposer", provider_id: "openai", provider_label: "OpenAI",
      model: "fixture", auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 8192 },
      fallbacks: [], degraded: false, reason: null },
    complete: async (request) => ({ raw: JSON.stringify(request.purpose === "snapshot_completeness"
      ? { checked_block_ids: [fixture.block_id], suspected_omissions: [], prior_issue_resolutions: [] } : output),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), noteCost: () => {},
  };
}

async function live<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SYNAPSE_TEST_STUB_LLM;
  process.env.SYNAPSE_TEST_STUB_LLM = "0";
  try { return await run(); } finally { process.env.SYNAPSE_TEST_STUB_LLM = previous; }
}

describe("source-backed structured extraction", () => {
  // Removing the structured proposer/output fields loses the cited objective and explicit unknowns.
  it("extracts a cited inventory objective without inventing owner, timing or lifecycle", async () => {
    const fixture = await sourceFixture("Registry R measures survival. Owner and dates are not stated.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R measures survival" };
    const unknown = { state: "unknown", value: null, reason: "not_stated", provenance: [] };
    const result = await live(() => inventoryExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      tactics: [{ name: "Registry R", type: "registry", status: "unknown", evidence_question: "What is survival?",
        provenance: [span], origin: "inventory", structured: { version: 1,
          description: { state: "known", value: "Registry R", provenance: [span] },
          objective: { state: "known", value: "Measure survival", provenance: [span] },
          owner: unknown, timing: unknown, outputs: unknown, lifecycle: unknown } }],
    })));
    expect(result.output.tactics).toHaveLength(1);
    expect(result.output.tactics[0]).toMatchObject({ status: "unknown", structured: { version: 1,
      objective: { state: "known", value: "Measure survival", provenance: [span] }, owner: unknown, timing: unknown } });
  });

  it("extracts HRQoL context, an unresolved document and a quotation with unknown attribution", async () => {
    const fixture = await sourceFixture("HRQoL evidence for NSCLC in first line is missing. See Protocol P9. We need quality of life data.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "HRQoL evidence for NSCLC in first line is missing" };
    const unknown = { state: "unknown", value: null, reason: "not_stated", provenance: [] };
    const quote = { ...span, quote: "We need quality of life data" };
    const result = await live(() => needExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      gaps: [{ statement: "Need first-line NSCLC HRQoL evidence", external_id: null, provenance: [span], structured: {
        version: 1, description: { state: "known", value: "HRQoL evidence is missing", provenance: [span] },
        indication: { state: "known", value: "NSCLC", provenance: [span] },
        disease_setting: { state: "known", value: "first line", provenance: [span] },
        category: { state: "known", value: { source_label: "HRQoL" }, provenance: [span] },
        rationale: unknown, supporting_documents: { state: "known", value: [
          { title: "Protocol P9", document_id: "P9", resolution: "unresolved", source_file_id: null }],
          provenance: [{ ...span, quote: "See Protocol P9" }] },
        interview_quotes: { state: "known", value: [{ quote, speaker: unknown, role: unknown }], provenance: [quote] },
      } }],
    })));
    expect(result.output.gaps[0]).toMatchObject({ structured: { version: 1,
      indication: { value: "NSCLC" }, disease_setting: { value: "first line" },
      category: { value: { source_label: "HRQoL", evidence_domain: "qol_pro" } },
      supporting_documents: { value: [{ title: "Protocol P9", resolution: "unresolved", source_file_id: null }] },
      interview_quotes: { value: [{ quote, speaker: unknown, role: unknown }] } } });
  });

  it.each([
    ["clinical efficacy", "efficacy"], ["safety", "safety"], ["PRO", "qol_pro"], ["HRQoL", "qol_pro"],
    ["HEOR", "economics"], ["epidemiology", "epidemiology"], ["biomarkers", "biomarkers"],
    ["guidelines", "implementation"], ["access", "health_system_impact"],
  ])("extracts the %s source category as %s and retains its label", async (source_label, evidence_domain) => {
    const fixture = await sourceFixture(`Missing ${source_label} evidence.`);
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: `Missing ${source_label} evidence` };
    const result = await live(() => needExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      gaps: [{ statement: `Need ${source_label} evidence`, provenance: [span], structured: { version: 1,
        category: { state: "known", value: { source_label }, provenance: [span] } } }],
    })));
    expect(result.output.gaps[0]).toMatchObject({ structured: { category: { state: "known", value: { source_label, evidence_domain }, provenance: [span] } } });
  });

  it("extracts stated inventory timing and outputs with field evidence", async () => {
    const fixture = await sourceFixture("Registry R completed. Objective: survival. Owner: Ada. Readout Q4 2027. Outputs: manuscript and congress abstract.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R completed" };
    const known = (value: unknown, quote: string) => ({ state: "known", value, provenance: [{ ...span, quote }] });
    const result = await live(() => inventoryExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      tactics: [{ name: "Registry R", type: "registry", status: "completed", evidence_question: "Survival?", provenance: [span], structured: {
        version: 1, description: known("Registry R", "Registry R completed"), objective: known("Survival", "Objective: survival"),
        owner: known("Ada", "Owner: Ada"), timing: known("Q4 2027 readout", "Readout Q4 2027"),
        outputs: known(["manuscript", "congress abstract"], "Outputs: manuscript and congress abstract"),
        lifecycle: known("completed", "Registry R completed") } }],
    })));
    expect(result.output.tactics[0]).toMatchObject({ status: "completed", structured: { timing: known("Q4 2027 readout", "Readout Q4 2027"),
      outputs: known(["manuscript", "congress abstract"], "Outputs: manuscript and congress abstract") } });
  });

  it("extracts quoted speaker and role separately from the interview words", async () => {
    const fixture = await sourceFixture("Ada (Medical Affairs): We need survival data.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "We need survival data" };
    const result = await live(() => needExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      gaps: [{ statement: "Need survival data", provenance: [span], structured: { version: 1, interview_quotes: {
        state: "known", provenance: [span], value: [{ quote: span,
          speaker: { state: "known", value: "Ada", provenance: [{ ...span, quote: "Ada (Medical Affairs)" }] },
          role: { state: "known", value: "Medical Affairs", provenance: [{ ...span, quote: "Ada (Medical Affairs)" }] } }] } } }],
    })));
    expect(result.output.gaps[0]).toMatchObject({ structured: { interview_quotes: { value: [{ quote: span,
      speaker: { state: "known", value: "Ada" }, role: { state: "known", value: "Medical Affairs" } }] } } });
  });

  it.each([
    ["speaker without attribution", "speaker", "Ada", "attribution_not_in_evidence"],
    ["invalid role quote", "role", "Medical Affairs", "quote_not_substring"],
  ])("reports %s instead of assigning it to a quotation", async (_label, field, value, reason) => {
    const fixture = await sourceFixture("We need survival data.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "We need survival data" };
    const unknown = { state: "unknown", value: null, reason: "not_stated", provenance: [] };
    const result = await live(() => needExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      gaps: [{ statement: "Need survival data", provenance: [span], structured: { version: 1, interview_quotes: {
        state: "known", provenance: [span], value: [{ quote: span, speaker: unknown, role: unknown,
          [field]: { state: "known", value, provenance: [{ ...span, quote: field === "role" ? "Medical Affairs" : span.quote }] } }] } } }],
    })));
    expect(result.output.gaps).toEqual([]);
    expect(result.output.rejected_candidates).toEqual([{ index: 0, field: `structured.interview_quotes.0.${field}`, reason }]);
  });

  it.each([
    ["missing reason", { state: "unknown", value: null, provenance: [] }],
    ["invented unknown evidence", { state: "unknown", value: null, reason: "not_stated", provenance: [{ source_file_id: "x", block_id: "y", quote: "z" }] }],
  ])("reports an unknown field with %s as a rejected candidate", async (_label, owner) => {
    const fixture = await sourceFixture("Registry R.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R" };
    const result = await live(() => inventoryExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      tactics: [{ name: "Registry R", type: "registry", status: "unknown", evidence_question: "Survival?", provenance: [span],
        structured: { version: 1, owner } }],
    })));
    expect(result.output.tactics).toEqual([]);
    expect(result.output.rejected_candidates).toEqual([{ index: 0, field: "structured", reason: "invalid_candidate_shape" }]);
  });

  it.each([
    ["invalid field quote", "Invented owner", false, "quote_not_substring"],
    ["wrong source", "Ada owns Registry R", true, "source_file_mismatch"],
  ])("rejects and reports %s rather than accepting its valid record quote", async (_label, quote, wrongSource, reason) => {
    const fixture = await sourceFixture("Registry R measures survival. Ada owns Registry R.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R measures survival" };
    const result = await live(() => inventoryExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      tactics: [{ name: "Registry R", type: "registry", status: "unknown", evidence_question: "Survival?", provenance: [span],
        structured: { version: 1, owner: { state: "known", value: "Ada", provenance: [
          { ...span, source_file_id: wrongSource ? "wrong-source" : span.source_file_id, quote }] } } }],
    })));
    expect(result.output.tactics).toEqual([]);
    expect(result.output).toMatchObject({ rejected_candidates: [{ index: 0, field: "structured.owner", reason }] });
  });

  it("records invalid structured evidence in the experiment snapshot signals", async () => {
    const fixture = await sourceFixture("Registry R measures survival.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R measures survival" };
    const ctx = context(fixture, { tactics: [{ name: "Registry R", type: "registry", status: "unknown", evidence_question: "Survival?",
      provenance: [span], structured: { version: 1, owner: { state: "known", value: "Ada", provenance: [{ ...span, quote: "Invented owner" }] } } }] });
    const events: AgentEvent[] = [];
    ctx.run.recordAgentEvent = async event => { events.push(event); };
    const result = await live(() => inventoryExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, ctx));
    expect(result.output.tactics).toEqual([]);
    expect(events.find(event => event.event_type === "snapshot")).toMatchObject({ signals: { quote_validity: { invalid_count: 1 } } });
    expect(events.find(event => event.event_type === "critique")).toMatchObject({ issues: [expect.objectContaining({ code: "quote_not_substring" })] });
  });

  it("does not relabel ideation as source inventory", async () => {
    const fixture = await sourceFixture("Registry R measures survival.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R" };
    const result = await live(() => inventoryExtractModule.run({ ...fixture, block_ids: [fixture.block_id] }, context(fixture, {
      tactics: [{ name: "Registry R", type: "registry", status: "proposed", evidence_question: "Survival?",
        provenance: [span], origin: "ideated" }],
    })));
    expect(result.output.tactics).toEqual([]);
    expect(result.output).toMatchObject({ rejected_candidates: [{ index: 0, field: "origin", reason: "wrong_origin" }] });
  });

  it("reads missing legacy facts as unknown without changing validation or timestamps", async () => {
    const fixture = await sourceFixture("Old inventory.");
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, claim_type: "tactic", statement: "Old registry",
      validated: true, status: "validated", metadata: { tactic_status: "planned" } });
    expect(readStructuredFields(claim)).toMatchObject({ owner: { state: "unknown", value: null,
      reason: "legacy_missing", provenance: [] }, timing: { state: "unknown", reason: "legacy_missing" } });
    expect(await getClaim(fixture.workspace_id, claim.id)).toEqual(claim);
  });

  it("normalizes unknown lifecycle without counting it as committed", () => {
    expect(asTacticLifecycle("unknown")).toBe("unknown");
    expect(deriveGapStatus({ gap_id: "gap", coverages: [{ gap_id: "gap", tactic_id: "tactic", overall: "full", validated: true }],
      tactics: [{ id: "tactic", status: "unknown" as never }] })).toBe("open");
  });

  it("locks just the edited structured field and invalidates claim and dependent validation", async () => {
    const fixture = await sourceFixture("Registry R is owned by Ada. It measures survival and progression.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R is owned by Ada" };
    const original = { ...emptyTacticStructuredFields("not_stated"), objective: { state: "known" as const,
      value: "Measure survival", provenance: [{ ...span, quote: "It measures survival and progression" }] } };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", status: "unknown", metadata: { structured: original, tactic_status: "unknown" } });
    const gap = await insertClaim({ workspace_id: fixture.workspace_id, claim_type: "gap", statement: "Need survival" });
    await insertCoverageJoin({ workspace_id: fixture.workspace_id, gap_id: gap.id, tactic_id: claim.id,
      overall: "full", validated: true, rationale: "Reviewed by the board" });
    await applyClaimValidation({ workspace_id: fixture.workspace_id, claim_ids: [claim.id], action: "validate",
      rationale: "Verified source inventory", actor: { name: "Reviewer", function: "medical_affairs" } });
    const revised = await updateClaim({ workspace_id: fixture.workspace_id, claim_id: claim.id,
      patch: { structured: { owner: { state: "known", value: "Ada", provenance: [span] } } } as never,
      rationale: "Owner confirmed in source", actor: { name: "Ada", function: "medical_affairs" } });
    const meta = claimMetadata(revised.claim);
    expect(meta.human_locked).toContain("structured.owner");
    expect(meta.human_locked).not.toContain("structured");
    expect(readStructuredFields(revised.claim)).toMatchObject({ owner: { state: "known", value: "Ada", provenance: [span] },
      objective: { value: "Measure survival" } });
    expect(meta.validation).toMatchObject({ by: "Reviewer", rationale: "Verified source inventory", stale: true });
    expect(revised.claim.validated).toBe(false);
    expect(meta.edit_history?.at(-1)).toMatchObject({ fields: ["structured.owner"], by: "Ada", rationale: "Owner confirmed in source" });
    expect((await listCoverageJoins(fixture.workspace_id))[0]).toMatchObject({ validated: false, rationale: "Reviewed by the board" });
    const nextObjective = { state: "known" as const, value: "Measure progression", provenance: [{ ...span, quote: "It measures survival and progression" }] };
    const merged = preserveHumanLocks(meta, { ...meta, structured: { ...original, objective: nextObjective } });
    expect(merged.structured).toMatchObject({ owner: { value: "Ada" }, objective: nextObjective });
  });

  it("keeps a factual revision stable across validation and derived metadata writes", async () => {
    const fixture = await sourceFixture("Registry R.");
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, claim_type: "tactic", statement: "Registry R",
      metadata: { structured: emptyTacticStructuredFields(), tactic_status: "unknown" } });
    const token = claimFactualRevision(claim);
    const validated = await applyClaimValidation({ workspace_id: fixture.workspace_id, claim_ids: [claim.id], action: "validate",
      rationale: "Verified registry", actor: { name: "Reviewer", function: "medical_affairs" } });
    expect(claimFactualRevision(validated.claims[0])).toBe(token);
    expect(claimValidationFreshness(validated.claims[0])).toBe("current");
    const derived = await updateClaimMetadata({ workspace_id: fixture.workspace_id, claim_id: claim.id,
      metadata: { ...claimMetadata(validated.claims[0]), computed_status: "open", derived_at: "2030-01-01" } });
    expect(claimFactualRevision(derived)).toBe(token);
    expect(derived.validated).toBe(true);
  });

  it.each(["production", "experiment", "production_rejected"] as const)("persists structured evidence through the %s extraction pipeline", async mode => {
    const fixture = await sourceFixture("Registry R is owned by Ada. HRQoL evidence is missing.");
    const previousRoutes = await Promise.all((["need_extract", "inventory_extract", "merge_dedupe"] as const)
      .map(kind => accuracyRouteConfig(kind, kind === "merge_dedupe" ? "judge" : "proposer")));
    const previousStub = process.env.SYNAPSE_TEST_STUB_LLM;
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.SYNAPSE_TEST_STUB_LLM = "0";
    process.env.OPENAI_API_KEY = "scripted-structured-provider";
    const owner = vi.spyOn(session, "sessionContext").mockResolvedValue({ session: null,
      actor: { name: "Owner", function: "medical_affairs" }, role: "operator", demo: false, signed_in: true });
    const provider = vi.spyOn(openAi, "complete").mockImplementation(async request => {
      expect(accuracyTransactionActive()).toBe(false);
      if (request.system.startsWith("Compare every source block")) {
        const input = JSON.parse(request.user);
        return JSON.stringify({ checked_block_ids: input.blocks.map((block: { id: string }) => block.id), suspected_omissions: [], prior_issue_resolutions: [] });
      }
      const source_file_id = request.user.match(/source_file_id=(\S+)/)?.[1];
      const block_id = request.user.match(/### block_id=(\S+)/)?.[1];
      const span = { source_file_id, block_id, quote: "Registry R is owned by Ada" };
      if (request.system === INVENTORY_PROPOSER_SYSTEM) return JSON.stringify({ tactics: [{ name: "Registry R", type: "registry",
        status: "unknown", evidence_question: "Survival?", provenance: [span], structured: { version: 1,
          owner: { state: "known", value: "Ada", provenance: [{ ...span,
            quote: mode === "production_rejected" ? "Invented owner" : span.quote }] } } }] });
      if (request.system === NEED_PROPOSER_SYSTEM) return JSON.stringify({ gaps: [{ statement: "Need HRQoL evidence", external_id: null,
        provenance: [{ ...span, quote: "HRQoL evidence is missing" }], structured: { version: 1,
          category: { state: "known", value: { source_label: "HRQoL" }, provenance: [{ ...span, quote: "HRQoL evidence is missing" }] } } }] });
      throw new Error("Unexpected provider request");
    });
    try {
      for (const route of previousRoutes) await setAccuracyRouteConfig({ ...route, provider_id: "openai", model: "gpt-5.1", fallbacks: [], actor_name: "test" });
      let workspace_id = fixture.workspace_id;
      if (mode !== "experiment") {
        const response = await extractPost(new Request("http://localhost/api/accuracy/extract", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify(fixture) }));
        const body = await response.json();
        expect(body).toMatchObject({ ok: mode !== "production_rejected", gaps_inserted: 1, tactics_inserted: mode === "production_rejected" ? 0 : 1 });
        expect(response.status).toBe(mode === "production_rejected" ? 409 : 200);
        if (mode === "production_rejected") expect(body.source_progress).toMatchObject({ complete: false, next_cursor: expect.any(String) });
        if (mode === "production_rejected") {
          expect(body.runs.find((run: { call_kind: string }) => run.call_kind === "inventory_extract")).toMatchObject({
            count: 0, rejected_candidates: [{ index: 0, field: "structured.owner", reason: "quote_not_substring" }] });
          expect(await listClaims(workspace_id)).toHaveLength(1);
          return;
        }
      } else {
        const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: fixture.workspace_id,
          source_file_ids: [fixture.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "Ada", function: "medical_affairs" } });
        expect(experiment.status).toBe("completed");
        workspace_id = experiment.workspace_id;
        expect(await listClaims(fixture.workspace_id)).toEqual([]);
      }
      const claims = await listClaims(workspace_id);
      expect(claims).toHaveLength(2);
      expect(claims.find(claim => claim.claim_type === "tactic")).toMatchObject({ validated: false, status: "unknown",
        metadata: { structured: { version: 1, owner: { state: "known", value: "Ada", provenance: [expect.objectContaining({ quote: "Registry R is owned by Ada" })] } } } });
      expect(claims.find(claim => claim.claim_type === "gap")).toMatchObject({ validated: false, metadata: {
        structured: { category: { value: { source_label: "HRQoL", evidence_domain: "qol_pro" } } } } });
    } finally {
      provider.mockRestore(); owner.mockRestore();
      if (previousStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM; else process.env.SYNAPSE_TEST_STUB_LLM = previousStub;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
      for (const route of previousRoutes) await setAccuracyRouteConfig({ ...route, actor_name: route.updated_by,
        temperature: route.params.temperature, max_tokens: route.params.max_tokens });
    }
  });

  it("carries structured facts through merge capture and application while respecting a nested human lock", async () => {
    const fixture = await sourceFixture("Registry R. Ada owns Registry R. Ben manages sites. Survival is measured.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R" };
    const survivor = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", status: "unknown", metadata: { provenance: [span], tactic_status: "unknown",
        structured: emptyTacticStructuredFields("not_stated") } });
    await updateClaim({ workspace_id: fixture.workspace_id, claim_id: survivor.id, patch: { structured: {
      owner: { state: "known", value: "Ada", provenance: [{ ...span, quote: "Ada owns Registry R" }] } } },
      rationale: "Confirmed accountable owner", actor: { name: "Ada", function: "medical_affairs" } });
    const duplicate = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", status: "unknown", metadata: { provenance: [span], tactic_status: "unknown",
        structured: { ...emptyTacticStructuredFields("not_stated"),
          owner: { state: "known", value: "Ben", provenance: [{ ...span, quote: "Ben manages sites" }] },
          objective: { state: "known", value: "Measure survival", provenance: [{ ...span, quote: "Survival is measured" }] } } } });
    const inputs = await captureMergeInputs(fixture.workspace_id);
    expect(inputs.candidates.find(row => row.id === duplicate.id)).toMatchObject({ structured: { objective: { value: "Measure survival" } } });
    const ctx = context(fixture, null);
    const prepared = await prepareMergeJudgment(inputs, ctx);
    const result = await withAccuracyTransaction(() => applyMergeJudgment(inputs, prepared, ctx));
    expect(result.output.merged).toBe(1);
    expect((await getClaim(fixture.workspace_id, duplicate.id))?.status).toBe("merged");
    const current = (await getClaim(fixture.workspace_id, survivor.id))!;
    expect(readStructuredFields(current)).toMatchObject({ owner: { value: "Ada" }, objective: { value: "Measure survival" } });
    expect(claimMetadata(current).edit_history).toHaveLength(1);
  });

  it("protects a structured field quote when a source block is edited", async () => {
    const fixture = await sourceFixture("Registry R. Ada owns the registry.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Ada owns the registry" };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", metadata: { structured: { ...emptyTacticStructuredFields(),
        owner: { state: "known", value: "Ada", provenance: [span] } } } });
    await expect(editParseBlock({ workspace_id: fixture.workspace_id, block_id: fixture.block_id,
      text: "Registry R.", rationale: "Trim transcript", actor: { name: "Ada", function: "medical_affairs" } })).rejects.toThrow(/quote|orphan|provenance/i);
    expect(readStructuredFields((await getClaim(fixture.workspace_id, claim.id))!)).toMatchObject({ owner: { value: "Ada", provenance: [span] } });
  });

  it("keeps structured evidence attached to its original words after splitting and merging a source block", async () => {
    const fixture = await sourceFixture("Registry R. Ada owns the registry.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Ada owns the registry" };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", metadata: { structured: { ...emptyTacticStructuredFields(),
        owner: { state: "known", value: "Ada", provenance: [span] } } } });
    const split = await splitParseBlock({ workspace_id: fixture.workspace_id, block_id: fixture.block_id, at_text: "Ada",
      rationale: "Separate attribution", actor: { name: "Ada", function: "medical_affairs" } });
    expect(readStructuredFields((await getClaim(fixture.workspace_id, claim.id))!)).toMatchObject({ owner: {
      value: "Ada", provenance: [{ ...span, block_id: split.second_id }] } });
    await mergeParseBlocks({ workspace_id: fixture.workspace_id, block_id: fixture.block_id, next_block_id: split.second_id,
      rationale: "Join transcript sections", actor: { name: "Ada", function: "medical_affairs" } });
    expect(readStructuredFields((await getClaim(fixture.workspace_id, claim.id))!)).toMatchObject({ owner: { value: "Ada", provenance: [span] } });
    await expect(editParseBlock({ workspace_id: fixture.workspace_id, block_id: fixture.block_id, text: "Registry R.",
      rationale: "Trim transcript", actor: { name: "Ada", function: "medical_affairs" } })).rejects.toThrow(/quote|orphan|provenance/i);
  });

  it("rejects explicit human validation of a known field with invalid source evidence", async () => {
    const fixture = await sourceFixture("Registry R.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Fabricated owner" };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id, claim_type: "tactic",
      statement: "Registry R", metadata: { structured: { ...emptyTacticStructuredFields(), owner: { state: "known", value: "Ada", provenance: [span] } } } });
    await expect(applyClaimValidation({ workspace_id: fixture.workspace_id, claim_ids: [claim.id], action: "validate",
      rationale: "Reviewed registry", actor: { name: "Ada", function: "medical_affairs" } })).rejects.toThrow("quote_not_substring");
    expect((await getClaim(fixture.workspace_id, claim.id))?.validated).toBe(false);
  });

  it("keeps human lifecycle edits aligned with the structured field and protects both on rerun", async () => {
    const fixture = await sourceFixture("Registry R is ongoing.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R is ongoing" };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id, claim_type: "tactic",
      statement: "Registry R", status: "ongoing", metadata: { tactic_status: "ongoing", structured: { ...emptyTacticStructuredFields(),
        lifecycle: { state: "known", value: "ongoing", provenance: [span] } } } });
    const edited = await updateClaim({ workspace_id: fixture.workspace_id, claim_id: claim.id, patch: { tactic_status: "planned" },
      rationale: "Study was rescheduled by the board", actor: { name: "Ada", function: "medical_affairs" } });
    const meta = claimMetadata(edited.claim);
    expect(meta.human_locked).toContain("structured.lifecycle");
    expect(readStructuredFields(edited.claim)).toMatchObject({ lifecycle: { state: "unknown", value: null,
      reason: "human_edit_without_field_evidence", provenance: [] } });
    const rerun = preserveHumanLocks(meta, { ...meta, tactic_status: "ongoing", structured: { ...emptyTacticStructuredFields(),
      lifecycle: { state: "known", value: "ongoing", provenance: [span] } } });
    expect(rerun.tactic_status).toBe("planned");
    expect(rerun.structured).toMatchObject({ lifecycle: { state: "unknown", value: null } });
  });

  it("retains a sourced known lifecycle when deduplicating an unknown-lifecycle inventory row", async () => {
    const fixture = await sourceFixture("Registry R is ongoing. Ada owns the registry.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Registry R is ongoing" };
    const original = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", status: "unknown", metadata: { tactic_status: "unknown", provenance: [span], structured: emptyTacticStructuredFields() } });
    await updateClaim({ workspace_id: fixture.workspace_id, claim_id: original.id, patch: { structured: {
      owner: { state: "known", value: "Ada", provenance: [{ ...span, quote: "Ada owns the registry" }] } } },
      rationale: "Source confirms accountable owner", actor: { name: "Ada", function: "medical_affairs" } });
    const duplicate = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", status: "ongoing", metadata: { tactic_status: "ongoing", provenance: [span],
        structured: { ...emptyTacticStructuredFields(), lifecycle: { state: "known", value: "ongoing", provenance: [span] } } } });
    const inputs = await captureMergeInputs(fixture.workspace_id);
    const ctx = context(fixture, null);
    const prepared = await prepareMergeJudgment(inputs, ctx);
    const result = await withAccuracyTransaction(() => applyMergeJudgment(inputs, prepared, ctx));
    expect(result.output.merged).toBe(1);
    expect((await getClaim(fixture.workspace_id, duplicate.id))?.status).toBe("merged");
    const survivor = (await getClaim(fixture.workspace_id, original.id))!;
    expect(claimMetadata(survivor).tactic_status).toBe("ongoing");
    expect(readStructuredFields(survivor)).toMatchObject({ lifecycle: { state: "known", value: "ongoing", provenance: [span] } });
  });

  it("rolls back the factual edit and its history when dependent invalidation fails", async () => {
    const fixture = await sourceFixture("Registry R. Ada owns the registry.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Ada owns the registry" };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", metadata: { structured: emptyTacticStructuredFields() } });
    const gap = await insertClaim({ workspace_id: fixture.workspace_id, claim_type: "gap", statement: "Need survival" });
    await insertCoverageJoin({ workspace_id: fixture.workspace_id, gap_id: gap.id, tactic_id: claim.id, overall: "full", validated: true });
    await applyClaimValidation({ workspace_id: fixture.workspace_id, claim_ids: [claim.id], action: "validate",
      rationale: "Reviewed inventory", actor: { name: "Reviewer", function: "medical_affairs" } });
    const before = await getClaim(fixture.workspace_id, claim.id);
    await accuracyDb().execute(sql.raw(`CREATE FUNCTION kan83_structured_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.workspace_id = '${fixture.workspace_id}' THEN RAISE EXCEPTION 'injected dependent failure'; END IF; RETURN NEW; END $$`));
    try {
      await accuracyDb().execute(sql.raw("CREATE TRIGGER kan83_structured_rollback BEFORE UPDATE ON accuracy_coverage_joins FOR EACH ROW EXECUTE FUNCTION kan83_structured_rollback()"));
      await expect(updateClaim({ workspace_id: fixture.workspace_id, claim_id: claim.id, patch: { structured: {
        owner: { state: "known", value: "Ada", provenance: [span] } } }, rationale: "Confirmed source owner",
        actor: { name: "Ada", function: "medical_affairs" } })).rejects.toThrow();
      expect(await getClaim(fixture.workspace_id, claim.id)).toEqual(before);
      expect((await listCoverageJoins(fixture.workspace_id))[0]?.validated).toBe(true);
    } finally {
      await accuracyDb().execute(sql.raw("DROP TRIGGER IF EXISTS kan83_structured_rollback ON accuracy_coverage_joins"));
      await accuracyDb().execute(sql.raw("DROP FUNCTION kan83_structured_rollback()"));
    }
  });

  it("gives the existing merge judge structured disease context before deciding equivalence", async () => {
    const fixture = await sourceFixture("Need NSCLC survival data. Need Melanoma survival data.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "survival data" };
    for (const [statement, indication] of [["Need survival evidence", "NSCLC"], ["Need survival data", "Melanoma"]]) {
      await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id, claim_type: "gap", statement,
        metadata: { provenance: [span], structured: { ...emptyGapStructuredFields(), indication: {
          state: "known", value: indication, provenance: [{ ...span, quote: `Need ${indication} survival data` }] } } } });
    }
    const inputs = await captureMergeInputs(fixture.workspace_id);
    const ctx = context(fixture, null);
    ctx.complete = async request => {
      expect(accuracyTransactionActive()).toBe(false);
      const same = !(request.user.includes("NSCLC") && request.user.includes("Melanoma"));
      return { raw: JSON.stringify({ decisions: [{ pair_id: "p1", same, rationale: same ? "Same survival question" : "Distinct indications" }] }),
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    };
    const prepared = await live(() => prepareMergeJudgment(inputs, ctx));
    const result = await withAccuracyTransaction(() => applyMergeJudgment(inputs, prepared, ctx));
    expect(result.output.judged_pairs).toBe(1);
    expect(result.output.merged).toBe(0);
    expect((await listClaims(fixture.workspace_id)).every(claim => claim.status !== "merged")).toBe(true);
  });

  it("keeps current human validation current when an experiment only remaps source and claim identities", async () => {
    const fixture = await sourceFixture("Registry R. Ada owns the registry.");
    const span = { source_file_id: fixture.source_file_id, block_id: fixture.block_id, quote: "Ada owns the registry" };
    const claim = await insertClaim({ workspace_id: fixture.workspace_id, source_file_id: fixture.source_file_id,
      claim_type: "tactic", statement: "Registry R", metadata: { structured: { ...emptyTacticStructuredFields(),
        owner: { state: "known", value: "Ada", provenance: [span] } } } });
    await applyClaimValidation({ workspace_id: fixture.workspace_id, claim_ids: [claim.id], action: "validate",
      rationale: "Source inventory reviewed", actor: { name: "Reviewer", function: "medical_affairs" } });
    const original = (await getClaim(fixture.workspace_id, claim.id))!;
    const copy = await copyExperimentWorkspace({ source_workspace_id: fixture.workspace_id, source_file_ids: [fixture.source_file_id] });
    const cloned = (await getClaim(copy.workspace_id, copy.claim_id_map[claim.id]))!;
    expect(claimValidationFreshness(cloned)).toBe("current");
    expect(claimMetadata(cloned).validation).toMatchObject({ by: "Reviewer", rationale: "Source inventory reviewed", stale: false });
    expect(readStructuredFields(cloned)).toMatchObject({ owner: { value: "Ada", provenance: [{
      ...span, source_file_id: copy.source_id_map[fixture.source_file_id], block_id: copy.block_id_map[fixture.block_id] }] } });
    expect(await getClaim(fixture.workspace_id, claim.id)).toEqual(original);
  });
});
