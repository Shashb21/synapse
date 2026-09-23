import { z } from "zod";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { completeJson } from "@/accuracy/kernel/routing";
import { gapsEligibleForIdeation } from "@/accuracy/domain/iegp-semantics";
import { TACTIC_TYPES } from "@/lib/iegp/enums";
import { IDEATE_PROPOSER_SYSTEM, ideateProposerUser } from "./prompts";
import { ideateRouteAllowsLlm } from "./route-allows";
import {
  ideationProposalSchema,
  type IdeateInput,
  type IdeateOutput,
  type IdeationProposal,
} from "./schema";

const llmEnvelopeSchema = z.object({
  proposals: z.array(z.record(z.string(), z.unknown())).default([]),
});

/** Mechanical stub: user-supplied title + rationale for one high open gap. */
export function mechanicalIdeateProposal(args: {
  gap_id: string;
  title: string;
  rationale: string;
  type?: IdeationProposal["type"];
}): IdeationProposal {
  return ideationProposalSchema.parse({
    gap_id: args.gap_id,
    name: args.title.trim(),
    type: args.type ?? "rwe_study",
    origin: "ideated",
    status: "proposed",
    design_summary: args.rationale.trim(),
    not_from_reference: true,
    rationale: args.rationale.trim(),
  });
}

function lockProposal(args: {
  gap_id: string;
  raw: Record<string, unknown>;
  existing_names: Set<string>;
}): IdeationProposal | null {
  const name = String(args.raw.name ?? "").trim();
  if (!name || args.existing_names.has(name.toLowerCase())) return null;
  const typeRaw = String(args.raw.type ?? "rwe_study");
  const type = (TACTIC_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as IdeationProposal["type"])
    : "rwe_study";
  const rationale = String(args.raw.rationale ?? args.raw.design_summary ?? "").trim();
  const design_summary = String(args.raw.design_summary ?? rationale).trim();
  const parsed = ideationProposalSchema.safeParse({
    gap_id: args.gap_id,
    name,
    type,
    origin: "ideated",
    status: "proposed",
    design_summary,
    not_from_reference: true,
    rationale: rationale || design_summary,
  });
  return parsed.success ? parsed.data : null;
}

function eligibleFocused(input: IdeateInput) {
  const eligible = gapsEligibleForIdeation(input.gaps);
  if (!input.focus_gap_id) return eligible;
  return eligible.filter((g) => g.id === input.focus_gap_id);
}

/**
 * Live LLM ideation when OAuth/api_key route is connected; otherwise mechanical stub.
 * Product lock: only validated high-priority open gaps (caller must enforce validated).
 */
export async function runIdeate(
  input: IdeateInput,
  ctx: AccuracyModuleContext,
): Promise<{ output: IdeateOutput; summary: string }> {
  const eligible = eligibleFocused(input);
  ctx.run.note(
    "ideate:eligible_high_open",
    eligible.map((g) => g.id),
  );

  if (process.env.SYNAPSE_TEST_STUB_LLM === "1" || !ideateRouteAllowsLlm(ctx.route)) {
    const title = input.mechanical?.title?.trim() ?? "";
    const rationale = input.mechanical?.rationale?.trim() ?? "";
    const focusId = input.focus_gap_id ?? eligible[0]?.id;
    if (focusId && title.length >= 8 && rationale.length >= 3 && eligible.some((g) => g.id === focusId)) {
      const proposal = mechanicalIdeateProposal({
        gap_id: focusId,
        title,
        rationale,
      });
      return {
        output: { mode: "stub", proposals: [proposal] },
        summary: `Ideation stub — 1 proposal for ${focusId}`,
      };
    }
    return {
      output: { mode: "stub", proposals: [] },
      summary: `Ideation stub — ${eligible.length} high-priority open gap(s) eligible (no mechanical title)`,
    };
  }

  if (eligible.length === 0) {
    return {
      output: { mode: "llm", proposals: [] },
      summary: "No high-priority open gaps eligible for ideation",
    };
  }

  const existing = new Set(
    input.existing_tactic_names.map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  const proposals: IdeationProposal[] = [];

  for (const gap of eligible) {
    const gapRow = input.gaps.find((g) => g.id === gap.id) ?? gap;
    const raw = await completeJson(ctx.complete, {
      system: IDEATE_PROPOSER_SYSTEM,
      user: ideateProposerUser({
        focus: {
          id: gap.id,
          statement: "statement" in gapRow ? gapRow.statement : undefined,
          status: gap.status,
          priority_band: gap.priority_band ?? null,
        },
        existing_tactic_names: input.existing_tactic_names,
        allowed_types: [...TACTIC_TYPES],
        hints: input.mechanical,
      }),
      purpose: `ideate:proposer:${gap.id}`,
    });
    const envelope = llmEnvelopeSchema.safeParse(raw);
    const candidates = envelope.success ? envelope.data.proposals : [];
    let locked: IdeationProposal | null = null;
    for (const candidate of candidates) {
      locked = lockProposal({ gap_id: gap.id, raw: candidate, existing_names: existing });
      if (locked) break;
    }
    // Single-object responses (no proposals array)
    if (!locked && raw && typeof raw === "object" && !Array.isArray(raw) && "name" in (raw as object)) {
      locked = lockProposal({
        gap_id: gap.id,
        raw: raw as Record<string, unknown>,
        existing_names: existing,
      });
    }
    if (locked) {
      proposals.push(locked);
      existing.add(locked.name.toLowerCase());
    }
  }

  return {
    output: { mode: "llm", proposals },
    summary: `Ideation LLM — ${proposals.length} proposal(s) for ${eligible.length} eligible gap(s)`,
  };
}
