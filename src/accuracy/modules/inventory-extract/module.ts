import { z } from "zod";
import { agenticModule } from "../_factory";
import { runShallowAgenticCycle } from "../../kernel/agentic";
import { completeJson } from "../../kernel/routing";
import { isTestStub } from "@/modules/kernel/llm";
import { provenanceSpanSchema } from "../../store/quote-validator";
import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import { newId } from "@/modules/kernel/ids";
import type { AccuracyModuleContext } from "../../kernel/contracts";
import { INVENTORY_PROPOSER_SYSTEM, inventoryProposerUser } from "./prompts";
import { readParseBlocks, readParseBlocksByIds } from "../../store/parse-store";

const tacticStatusSchema = z.enum(TACTIC_STATUSES);
const tacticTypeSchema = z.enum(TACTIC_TYPES);

/** One inventory tactic after judge (stable id + validated shape). */
export const inventoryTacticSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: tacticTypeSchema,
  status: tacticStatusSchema,
  evidence_question: z.string().min(1),
  origin: z.literal("inventory"),
  provenance: z.array(provenanceSpanSchema).min(1),
});

export type InventoryTactic = z.infer<typeof inventoryTacticSchema>;

export const inventoryExtractOutputSchema = z.object({
  workspace_id: z.string(),
  source_file_id: z.string(),
  tactics: z.array(inventoryTacticSchema),
});

export type InventoryExtractOutput = z.infer<typeof inventoryExtractOutputSchema>;

const proposerTacticSchema = z.object({
  name: z.string(),
  type: z.string(),
  status: z.string(),
  evidence_question: z.string(),
  origin: z.literal("inventory").optional(),
  provenance: z.array(provenanceSpanSchema).optional(),
});

type InventoryDraft = {
  tactics: z.infer<typeof proposerTacticSchema>[];
};

function critiqueDraft(draft: InventoryDraft, source_file_id: string): { score: number; issues: string[] } {
  const issues: string[] = [];
  if (draft.tactics.length === 0) {
    issues.push("no_tactics_proposed");
  }
  const names = new Set<string>();
  for (const [index, tactic] of draft.tactics.entries()) {
    const subject = tactic.name?.trim() || `tactic_${index}`;
    if (!tactic.name?.trim()) issues.push(`${subject}:missing_name`);
    if (tactic.origin && tactic.origin !== "inventory") {
      issues.push(`${subject}:wrong_origin`);
    }
    if (!tactic.provenance?.length) {
      issues.push(`${subject}:no_quote`);
    } else {
      for (const span of tactic.provenance) {
        if (span.source_file_id !== source_file_id) {
          issues.push(`${subject}:source_file_mismatch`);
        }
        if (!span.quote?.trim()) issues.push(`${subject}:empty_quote`);
      }
    }
    const key = tactic.name?.trim().toLowerCase();
    if (key) {
      if (names.has(key)) issues.push(`${subject}:duplicate`);
      names.add(key);
    }
  }
  const score = draft.tactics.length === 0 ? 0 : Math.max(0, 1 - issues.length * 0.15);
  return { score, issues };
}

function normalizeDraft(raw: unknown, source_file_id: string): InventoryDraft {
  const parsed = z
    .object({ tactics: z.array(proposerTacticSchema).default([]) })
    .safeParse(raw);
  if (!parsed.success) return { tactics: [] };
  return {
    tactics: parsed.data.tactics.map((t) => ({
      ...t,
      origin: "inventory" as const,
      provenance: (t.provenance ?? []).map((p) => ({
        ...p,
        source_file_id: p.source_file_id || source_file_id,
      })),
    })),
  };
}

function judgeDraft(draft: InventoryDraft): InventoryExtractOutput["tactics"] {
  const out: InventoryTactic[] = [];
  for (const tactic of draft.tactics) {
    const parsed = inventoryTacticSchema.safeParse({
      id: newId("tac"),
      name: tactic.name.trim(),
      type: tactic.type,
      status: tactic.status,
      evidence_question: tactic.evidence_question.trim(),
      origin: "inventory",
      provenance: tactic.provenance ?? [],
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

async function loadBlocksForPrompt(input: {
  workspace_id: string;
  source_file_id: string;
  block_ids: string[];
}) {
  const rows =
    input.block_ids.length > 0
      ? await readParseBlocksByIds(input.workspace_id, input.block_ids)
      : await readParseBlocks(input.workspace_id, input.source_file_id);
  return rows
    .filter((row) => row.source_file_id === input.source_file_id)
    .map((row) => ({
      id: row.id,
      heading: row.heading,
      text: row.text,
    }));
}

async function proposeInventory(
  ctx: AccuracyModuleContext,
  input: { workspace_id: string; source_file_id: string; block_ids: string[] },
  round: number,
  prior: InventoryDraft | null,
  critiques: string[],
): Promise<InventoryDraft> {
  if (isTestStub()) {
    return { tactics: [] };
  }
  const blocks = await loadBlocksForPrompt(input);
  const block_ids = input.block_ids.length > 0 ? input.block_ids : blocks.map((b) => b.id);
  const raw = await completeJson(ctx.complete, {
    system: INVENTORY_PROPOSER_SYSTEM,
    user: inventoryProposerUser({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      block_ids,
      blocks,
      hints: "",
      critiques: round === 0 ? [] : critiques,
    }),
    purpose: `inventory_extract:proposer:r${round}`,
  });
  if (round > 0 && prior && (!raw || (raw as { tactics?: unknown[] }).tactics?.length === 0)) {
    return prior;
  }
  return normalizeDraft(raw, input.source_file_id);
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
  }),
  outputSchema: inventoryExtractOutputSchema,
  run: async (input, ctx) => {
    const stub = isTestStub();

    const cycle = await runShallowAgenticCycle<InventoryDraft>({
      proposer: (round, prior, critiques) =>
        proposeInventory(ctx, input, round, prior, critiques),
      critic: async (draft) => {
        if (stub) return { score: 1, issues: [] };
        return critiqueDraft(draft, input.source_file_id);
      },
      judge: async (draft) => draft,
    });

    ctx.run.note("agentic:trace", cycle.trace);

    const tactics = stub ? [] : judgeDraft(cycle.final);
    const output = {
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      tactics,
    };

    return {
      output,
      summary: stub
        ? "Inventory extract (SYNAPSE_TEST_STUB_LLM — empty tactics)"
        : `Inventory extract — ${output.tactics.length} tactic(s)`,
    };
  },
});
