import { sourcePageInputSchema, resolveSourcePage, locatePageEvidence, sourcePromptUser } from "../../domain/source-pages";
import { z } from "zod";
import { agenticModule } from "../_factory";
import { inspectQuoteSpans, runShallowAgenticCycle } from "../../kernel/agentic";
import type { CriticIssue, ProductionSignals } from "../../kernel/agent-events";
import { completeJson } from "../../kernel/routing";
import { isTestStub } from "@/modules/kernel/llm";
import { provenanceSpanSchema } from "../../store/quote-validator";
import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import { newId } from "@/modules/kernel/ids";
import type { AccuracyModuleContext } from "../../kernel/contracts";
import { INVENTORY_PROPOSER_SYSTEM, inventoryProposerUser } from "./prompts";
import { readParseBlocks, readParseBlocksByIds } from "../../store/parse-store";
import { claimMetadata, listActiveSourceClaims } from "../../store/claim-store";
import { inspectSnapshotCompleteness, type SnapshotItem } from "../completeness-audit/snapshot-inspector";
import { emptyTacticStructuredFields, tacticStructuredFieldsSchema, rejectedCandidateSchema, validateFieldEvidence, structuredProvenance, type RejectedCandidate } from "../../domain/structured-fields";

const tacticStatusSchema = z.enum([...TACTIC_STATUSES, "unknown"]);
const tacticTypeSchema = z.enum(TACTIC_TYPES);

/** One inventory tactic after judge (stable id + validated shape). */
export const inventoryTacticSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  external_id: z.string().nullable().optional(),
  type: tacticTypeSchema,
  status: tacticStatusSchema,
  evidence_question: z.string().min(1),
  origin: z.literal("inventory"),
  provenance: z.array(provenanceSpanSchema).min(1),
  structured: tacticStructuredFieldsSchema.default(() => emptyTacticStructuredFields()),
});

export type InventoryTactic = z.infer<typeof inventoryTacticSchema>;

export const inventoryExtractOutputSchema = z.object({
  workspace_id: z.string(),
  source_file_id: z.string(),
  tactics: z.array(inventoryTacticSchema),
  rejected_candidates: z.array(rejectedCandidateSchema).optional(),
  source_complete: z.boolean().optional(),
});

export type InventoryExtractOutput = z.infer<typeof inventoryExtractOutputSchema>;

const proposerTacticSchema = z.object({
  name: z.string(),
  external_id: z.string().nullable().optional(),
  type: z.string(),
  status: z.string().default("unknown"),
  evidence_question: z.string(),
  origin: z.string().optional(),
  provenance: z.array(provenanceSpanSchema).optional(),
  structured: z.unknown().optional(),
});

type InventoryDraft = {
  tactics: (z.infer<typeof proposerTacticSchema> & { candidate_index: number })[];
  rejected_candidates?: RejectedCandidate[];
};

function critiqueDraft(draft: InventoryDraft, source_file_id: string, blocks: { id: string; source_file_id: string; text: string }[]): { score: number; issues: CriticIssue[]; observationIssues: CriticIssue[] } {
  const issues: CriticIssue[] = [];
  const observationIssues: CriticIssue[] = [];
  const add = (claim: string, code: string, source_ref?: CriticIssue["source_ref"]) => {
    issues.push({ issue_id: `inventory:${issues.length}`, category: "inventory_extract", code,
      severity: "medium", claim, suggested_action: claim, ...(source_ref ? { source_ref } : {}) });
  };
  if (draft.tactics.length === 0) {
    add("no_tactics_proposed", "no_tactics_proposed");
  }
  const names = new Set<string>();
  for (const [index, tactic] of draft.tactics.entries()) {
    const subject = tactic.name?.trim() || `tactic_${index}`;
    if (!tactic.name?.trim()) add(`${subject}:missing_name`, "missing_name");
    if (tactic.origin && tactic.origin !== "inventory") {
      add(`${subject}:wrong_origin`, "wrong_origin");
    }
    if (!tactic.provenance?.length) {
      add(`${subject}:no_quote`, "no_quote");
    } else {
      for (const span of tactic.provenance) {
        const ref = span.source_file_id && span.block_id ? { source_file_id: span.source_file_id, block_id: span.block_id } : undefined;
        if (span.source_file_id !== source_file_id) add(`${subject}:source_file_mismatch`, "source_file_mismatch", ref);
        if (!span.quote?.trim()) add(`${subject}:empty_quote`, "empty_quote", ref);
      }
    }
    const key = tactic.name?.trim().toLowerCase();
    if (key) {
      if (names.has(key)) add(`${subject}:duplicate`, "duplicate");
      names.add(key);
    }
  }
  const checked = inspectQuoteSpans({ spans: draft.tactics.flatMap((tactic) => [...(tactic.provenance ?? []), ...structuredProvenance(tactic.structured)]), blocks });
  for (const finding of checked.findings) {
    observationIssues.push({ issue_id: `inventory:observed:${observationIssues.length}`,
      category: "quote_validity", code: finding.code, severity: "medium",
      claim: `${finding.span.block_id}:${finding.code}`,
      suggested_action: "Check the quote against its source block",
      source_ref: { source_file_id: finding.span.source_file_id, block_id: finding.span.block_id } });
  }
  const score = draft.tactics.length === 0 ? 0 : Math.max(0, 1 - issues.length * 0.15);
  return { score, issues, observationIssues };
}

function normalizeDraft(raw: unknown): InventoryDraft {
  const envelope = z.object({ tactics: z.array(z.unknown()) }).safeParse(raw);
  if (!envelope.success) return { tactics: [], rejected_candidates: [{ index: 0, field: "response", reason: "malformed_response" }] };
  const draft: InventoryDraft = { tactics: [], rejected_candidates: [] };
  for (const [index, candidate] of envelope.data.tactics.entries()) {
    const parsed = proposerTacticSchema.safeParse(candidate);
    if (!parsed.success) draft.rejected_candidates!.push({ index, field: "candidate", reason: "invalid_candidate_shape" });
    else draft.tactics.push({ ...parsed.data, candidate_index: index });
  }
  return draft;
}

function judgeDraft(draft: InventoryDraft, source_file_id: string, blocks: Parameters<typeof validateFieldEvidence>[0]["blocks"]) {
  const tactics: InventoryTactic[] = [];
  const rejected_candidates = [...(draft.rejected_candidates ?? [])];
  for (const tactic of draft.tactics) {
    if (tactic.origin !== undefined && tactic.origin !== "inventory") {
      rejected_candidates.push({ index: tactic.candidate_index, field: "origin", reason: "wrong_origin" });
      continue;
    }
    const raw = tactic.structured;
    const structured = raw === undefined ? emptyTacticStructuredFields("not_stated")
      : raw && typeof raw === "object" ? { ...emptyTacticStructuredFields("not_stated"), ...raw } : raw;
    // Older proposer contracts already supply a sourced lifecycle; retain that fact with its evidence.
    if (structured && typeof structured === "object" && (!raw || typeof raw !== "object" || !("lifecycle" in raw))
      && tactic.status !== "unknown" && (TACTIC_STATUSES as readonly string[]).includes(tactic.status)) {
      Object.assign(structured, { lifecycle: { state: "known", value: tactic.status, provenance: tactic.provenance ?? [] } });
    }
    const parsed = inventoryTacticSchema.safeParse({ id: newId("tac"), name: tactic.name.trim(), type: tactic.type,
      external_id: tactic.external_id?.trim() || null, status: tactic.status, evidence_question: tactic.evidence_question.trim(), origin: "inventory",
      provenance: tactic.provenance ?? [], structured });
    let error = parsed.success ? validateFieldEvidence({ structured: parsed.data.structured,
      provenance: parsed.data.provenance, source_file_id, blocks })
      : { field: raw === undefined ? "candidate" : "structured", reason: "invalid_candidate_shape" };
    if (!error && parsed.success) {
      const lifecycle = parsed.data.structured.lifecycle;
      if ((lifecycle.state === "known" ? lifecycle.value : "unknown") !== parsed.data.status) {
        error = { field: "structured.lifecycle", reason: "lifecycle_mismatch" };
      }
    }
    if (error) rejected_candidates.push({ index: tactic.candidate_index, ...error });
    else if (parsed.success) tactics.push(parsed.data);
  }
  return { tactics, rejected_candidates };
}

async function proposeInventory(
  ctx: AccuracyModuleContext,
  input: { workspace_id: string; source_file_id: string; block_ids: string[] },
  round: number,
  prior: InventoryDraft | null,
  critiques: string[],
  blocks: Awaited<ReturnType<typeof readParseBlocks>>,
  block_ids: string[],
): Promise<InventoryDraft> {
  if (isTestStub()) {
    return { tactics: [] };
  }
  const raw = await completeJson(ctx.complete, {
    system: INVENTORY_PROPOSER_SYSTEM,
    user: sourcePromptUser(INVENTORY_PROPOSER_SYSTEM, inventoryProposerUser({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      block_ids,
      blocks,
      hints: "",
      critiques: round === 0 ? [] : critiques,
    })),
    purpose: `inventory_extract:proposer:r${round}`,
  });
  if (round > 0 && prior && (!raw || (raw as { tactics?: unknown[] }).tactics?.length === 0)) {
    return prior;
  }
  return normalizeDraft(raw);
}

export const inventoryExtractModule = agenticModule({
  id: "inventory-extract.agent-v1",
  call_kind: "inventory_extract",
  title: "Inventory extract",
  summary: "Tactic inventory from parse blocks (1× PCJ default).",
  inputSchema: z.object({
    workspace_id: z.string(),
    source_file_id: z.string(),
    block_ids: z.array(z.string()),
    source_page: sourcePageInputSchema.optional(),
  }),
  outputSchema: inventoryExtractOutputSchema,
  run: async (input, ctx) => {
    const stub = isTestStub();
    const originalBlocks = stub ? [] : (input.block_ids.length
      ? await readParseBlocksByIds(input.workspace_id, input.block_ids)
      : await readParseBlocks(input.workspace_id, input.source_file_id))
      .filter((row) => row.source_file_id === input.source_file_id);
    const pageBlocks = input.source_page && !stub ? resolveSourcePage(originalBlocks, input.source_page) : undefined;
    const blocks = pageBlocks ?? originalBlocks;
    let sourceChecked = stub;
    const block_ids = blocks.map((block) => block.id);
    const availableIds = new Set(blocks.map((block) => block.id));
    const missingIds = input.block_ids.filter((id) => !availableIds.has(id));
    const persisted = stub ? [] : await listActiveSourceClaims(input.workspace_id, input.source_file_id);
    const persistedItems: SnapshotItem[] = persisted.map((claim) => {
      const provenance = claimMetadata(claim).provenance;
      return {
        item_kind: claim.claim_type as SnapshotItem["item_kind"], item_ref: claim.id,
        statement: claim.statement,
        provenance: Array.isArray(provenance) ? provenance.flatMap((span) => {
          if (!span || typeof span !== "object") return [];
          const record = span as Record<string, unknown>;
          return typeof record.source_file_id === "string" && typeof record.block_id === "string"
            && typeof record.quote === "string"
            ? [{ source_file_id: record.source_file_id, block_id: record.block_id, quote: record.quote }] : [];
        }) : [],
      };
    });

    const cycle = await runShallowAgenticCycle<InventoryDraft>({
      run: ctx.run,
      onSnapshot: async (draft): Promise<ProductionSignals> => ({
        quote_validity: inspectQuoteSpans({ spans: draft.tactics.flatMap((tactic) => [...(tactic.provenance ?? []), ...structuredProvenance(tactic.structured)]), blocks }).signals,
        invariant_failures: critiqueDraft(draft, input.source_file_id, blocks).issues.map((issue) => issue.claim),
        completeness: "not_checked",
      }),
      proposer: (round, prior, critiques) =>
        proposeInventory(ctx, input, round, prior, critiques, blocks, block_ids),
      onCompleteness: stub ? undefined : async (draft, prior_open_issues) => {
        const items: SnapshotItem[] = [
          ...persistedItems,
          ...draft.tactics.map((tactic, index) => ({ item_kind: "tactic" as const,
            item_ref: `draft-tactic-${index}`, statement: tactic.name,
            provenance: tactic.provenance ?? [] })),
        ];
        const assessment = await inspectSnapshotCompleteness({
          blocks, items, prior_open_issues, complete: ctx.complete,
        });
        sourceChecked = assessment.risk_level !== "check_failed" && assessment.unchecked_block_ids.length === 0 && missingIds.length === 0;
        if (missingIds.length === 0) return assessment;
        return { ...assessment,
          risk_level: assessment.risk_level === "check_failed" ? "check_failed" : "important" as const,
          unchecked_block_ids: [...assessment.unchecked_block_ids, ...missingIds],
        };
      },
      critic: async (draft) => {
        if (stub) return { score: 1, issues: [] };
        return critiqueDraft(draft, input.source_file_id, blocks);
      },
      judge: async (draft) => draft,
    });

    ctx.run.note("agentic:trace", cycle.trace);

    const { tactics, rejected_candidates } = stub ? { tactics: [], rejected_candidates: [] } : judgeDraft(cycle.final, input.source_file_id, blocks);
    if (input.source_page && !stub) {
      const resolved = tactics.flatMap((candidate, index) => {
        try { return [locatePageEvidence(candidate, pageBlocks!)]; }
        catch (error) {
          rejected_candidates.push({ index, field: "provenance", reason: error instanceof Error ? error.message : "invalid_page_evidence" });
          return [];
        }
      });
      tactics.splice(0, tactics.length, ...resolved);
    }
    if (rejected_candidates.length) ctx.run.note("extract:rejected_candidates", rejected_candidates);
    const output = {
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      tactics,
      source_complete: sourceChecked && rejected_candidates.length === 0,
      ...(rejected_candidates.length ? { rejected_candidates } : {}),
    };

    return {
      output,
      summary: stub
        ? "Inventory extract (SYNAPSE_TEST_STUB_LLM — empty tactics)"
        : `Inventory extract — ${output.tactics.length} tactic(s)`,
    };
  },
});

inventoryExtractModule.manifest.version = "0.3.0";
