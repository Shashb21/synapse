import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import {
  PROPOSER_CRITIC_EXCHANGES,
  hasIssue,
  runAgenticCycle,
  scoreCritic,
  type Critique,
} from "@/modules/kernel/agentic";
import { augmentSystemPrompt } from "@/modules/kernel/prompt-variant";
import { curatedS3Cases } from "@/modules/eval-gold";
import { scoreMustMatch } from "@/modules/eval-gold/types";
import { canPrompt } from "@/modules/kernel/routing";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import {
  TACTIC_STATUSES,
  TACTIC_TYPES,
  type TacticStatus,
  type TacticType,
} from "@/lib/iegp/enums";
import { commitExtractedRecords, loadState } from "@/lib/iegp/store";
import {
  extractCandidateTactics,
  gapNameFromStatement,
  guessTacticStatus,
  guessTacticType,
  similarRecord,
} from "@/lib/iegp/engine";
import { listParsedDocuments, type ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import { TACTIC_CANDIDATES_DDL, tacticCandidates } from "./schema";

const inputSchema = z.object({
  document_ids: z.array(z.string()).optional(),
  dry_run: z.boolean().default(false),
});

const candidateSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  source_id: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  evidence_question: z.string(),
  source_quote: z.string(),
  score: z.number(),
  verdict: z.string(),
  critic_note: z.string(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  accepted: z.array(candidateSchema),
  rejected: z.array(candidateSchema),
  committed_tactic_ids: z.array(z.string()),
});

export type TacticExtractInput = z.infer<typeof inputSchema>;
export type TacticExtractOutput = z.infer<typeof outputSchema>;

type TacticCandidate = {
  id: string;
  document_id: string;
  source_id: string;
  name: string;
  type: TacticType;
  status: TacticStatus;
  evidence_question: string;
  source_quote: string;
};

const TACTIC_PROPOSER_SYSTEM = `You extract tactics already described in pharma evidence-planning source material.

A tactic is a study, analysis, publication or dissemination activity that exists, is running, is planned, or is explicitly proposed in the document. Do not invent tactics and do not turn an evidence gap into a tactic.

Rules:
- type must be one of: ${TACTIC_TYPES.join(", ")}.
- status must be one of: ${TACTIC_STATUSES.join(", ")} and must reflect what the document says.
- evidence_question is the question the tactic answers, in one sentence.
- Return JSON only: {"tactics":[{"name":"","type":"","status":"","evidence_question":"","source_quote":""}]}`;

function localProposals(documents: ParsedDocumentRecord[]): TacticCandidate[] {
  return documents.flatMap((document) =>
    extractCandidateTactics(document.blocks).map((tactic, index) => ({
      id: `${document.id}-T${String(index + 1).padStart(3, "0")}`,
      document_id: document.id,
      source_id: document.source_id,
      name: tactic.name,
      type: tactic.type,
      status: tactic.status,
      evidence_question: tactic.evidence_question,
      source_quote: tactic.source_quote,
    })),
  );
}

async function llmProposals(
  ctx: ModuleContext,
  documents: ParsedDocumentRecord[],
  hints: string,
): Promise<TacticCandidate[]> {
  const out: TacticCandidate[] = [];
  for (const document of documents) {
    const payload = (await ctx.complete({
      system: augmentSystemPrompt(TACTIC_PROPOSER_SYSTEM),
      user: [
        hints,
        `Source: ${document.source_id}`,
        document.blocks.map((block) => `## ${block.heading}\n${block.text}`).join("\n\n").slice(0, 40_000),
      ]
        .filter(Boolean)
        .join("\n\n"),
      purpose: `tactic-proposer:${document.id}`,
    })) as {
      tactics?: {
        name?: string;
        type?: string;
        status?: string;
        evidence_question?: string;
        source_quote?: string;
      }[];
    };
    for (const [index, tactic] of (payload.tactics ?? []).entries()) {
      const question = (tactic.evidence_question ?? "").trim();
      if (!question) continue;
      out.push({
        id: `${document.id}-LT${String(index + 1).padStart(3, "0")}`,
        document_id: document.id,
        source_id: document.source_id,
        name: (tactic.name ?? "").trim() || gapNameFromStatement(question),
        type: TACTIC_TYPES.includes(tactic.type as TacticType)
          ? (tactic.type as TacticType)
          : guessTacticType(question),
        status: TACTIC_STATUSES.includes(tactic.status as TacticStatus)
          ? (tactic.status as TacticStatus)
          : guessTacticStatus(question),
        evidence_question: question,
        source_quote: (tactic.source_quote ?? question).slice(0, 280),
      });
    }
  }
  return out;
}

/** The proposer answering the critic: concede drops, fatten a thin question from its quote. */
function reviseTacticCandidates(args: {
  previous: TacticCandidate[];
  critiques: Critique[];
}): TacticCandidate[] {
  const out: TacticCandidate[] = [];
  for (const candidate of args.previous) {
    const critique = args.critiques.find((item) => item.subject === candidate.id);
    if (critique?.verdict === "drop") continue;
    if (hasIssue(critique, "already_in_library") || hasIssue(critique, "no_quote")) continue;
    let evidence_question = candidate.evidence_question;
    if (hasIssue(critique, "thin_question") && candidate.source_quote.trim().length > evidence_question.length) {
      evidence_question = candidate.source_quote.trim();
    }
    if (evidence_question.split(/\s+/).length < 5) continue;
    out.push({ ...candidate, evidence_question });
  }
  return out;
}

function tacticRevisionBrief(args: { round: number; critiques: Critique[] }): string {
  const objections = args.critiques.filter((critique) => critique.verdict !== "keep");
  if (objections.length === 0) {
    return `Exchange ${args.round} of ${PROPOSER_CRITIC_EXCHANGES}: nothing was objected to. Sharpen wording only.`;
  }
  return [
    `Exchange ${args.round} of ${PROPOSER_CRITIC_EXCHANGES}. Answer the critic, keeping the id of anything you retain:`,
    ...objections.map(
      (critique) => `- ${critique.subject} (${critique.verdict}, ${critique.score}/100): ${critique.note}`,
    ),
  ].join("\n");
}

export const tacticExtractModule: SynapseModule<TacticExtractInput, TacticExtractOutput> = {
  manifest: {
    id: "s3-tactic-extract.pcj",
    stage: "S3",
    version: "1.0.0",
    title: "Tactic extraction (proposer → critic → judge)",
    summary:
      "Proposes tactics described in the source material, critiques type/status fidelity, judges what enters the library.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "local-proposer", "hillclimb-hints"],
  },
  inputSchema,
  outputSchema,
  migrations: [TACTIC_CANDIDATES_DDL],
  async run(input, ctx) {
    const documents = await listParsedDocuments(input.document_ids);
    if (documents.length === 0) {
      return {
        output: { mode: "deterministic", proposed: 0, accepted: [], rejected: [], committed_tactic_ids: [] },
        summary: "No parsed documents to extract from",
      };
    }
    const state = await loadState();
    const library = state.tactics.map((tactic) => ({
      name: tactic.name,
      question: tactic.evidence_question,
    }));

    const outcome = await runAgenticCycle<TacticCandidate>(ctx, "S3", {
      subjectOf: (candidate) => candidate.id,
      proposer: {
        local: ({ round, previous, critiques }) =>
          round === 1 ? localProposals(documents) : reviseTacticCandidates({ previous, critiques }),
        llm: canPrompt(ctx.route)
          ? ({ hints, round, critiques }) =>
              llmProposals(
                ctx,
                documents,
                round === 1
                  ? hints
                  : [hints, tacticRevisionBrief({ round, critiques })].filter(Boolean).join("\n\n"),
              )
          : undefined,
      },
      critic: scoreCritic<TacticCandidate>(
        (candidate) => candidate.id,
        (candidate) => {
          let score = 65;
          const notes: string[] = [];
          const issues: string[] = [];
          if (candidate.evidence_question.split(/\s+/).length < 5) {
            score -= 25;
            notes.push("evidence question too thin");
            issues.push("thin_question");
          }
          if (candidate.status === "proposed") {
            score -= 8;
            notes.push("status only proposed — does not close a gap");
            issues.push("status_proposed");
          }
          if (
            library.some(
              (item) =>
                similarRecord(item.name, candidate.name) ||
                similarRecord(item.question, candidate.evidence_question, 0.45),
            )
          ) {
            score -= 30;
            notes.push("already in the tactic library");
            issues.push("already_in_library");
          }
          if (!candidate.source_quote.trim()) {
            score -= 15;
            notes.push("no source quote");
            issues.push("no_quote");
          }
          return {
            score: Math.max(0, Math.min(100, score)),
            note: notes.length ? notes.join("; ") : "real inventory item with a clear question",
            issues,
          };
        },
      ),
      judge: ({ candidates, critiques }) => {
        const kept: TacticCandidate[] = [];
        return candidates.map((candidate) => {
          const critique = critiques.find((item) => item.subject === candidate.id);
          const score = critique?.score ?? 50;
          const duplicate = kept.some(
            (other) =>
              similarRecord(other.name, candidate.name) ||
              similarRecord(other.evidence_question, candidate.evidence_question, 0.55),
          );
          const accept = critique?.verdict !== "drop" && score >= 45 && !duplicate;
          if (accept) kept.push(candidate);
          return {
            candidate,
            subject: candidate.id,
            verdict: accept ? ("accept" as const) : ("reject" as const),
            score,
            note: duplicate
              ? "Rejected: duplicate of a tactic already accepted in this run."
              : (critique?.note ?? "no critique"),
          };
        });
      },
    });

    const rows = outcome.judged.map((item) => ({
      id: newId("tc"),
      run_id: ctx.run.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      type: item.candidate.type,
      status: item.candidate.status,
      evidence_question: item.candidate.evidence_question,
      source_quote: item.candidate.source_quote,
      score: item.score,
      verdict: item.verdict,
      critic_note: item.note,
      proposer: outcome.mode,
      created_at: nowIso(),
    }));
    if (rows.length > 0) await db().insert(tacticCandidates).values(rows);

    const committed_tactic_ids: string[] = [];
    if (!input.dry_run) {
      for (const document of documents) {
        const accepted = outcome.accepted.filter((candidate) => candidate.document_id === document.id);
        if (accepted.length === 0) continue;
        const source = state.sources.find((row) => row.id === document.source_id);
        const result = await ctx.run.step(`commit:${document.id}`, () =>
          commitExtractedRecords({
            source_id: document.source_id,
            title: source?.title ?? document.source_id,
            stakeholder_function: source?.stakeholder_function ?? ctx.actor.function,
            actor_name: ctx.actor.name,
            actor_function: ctx.actor.function,
            needs: [],
            gaps: [],
            tactics: accepted.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              type: candidate.type,
              status: candidate.status,
              evidence_question: candidate.evidence_question,
              source_id: candidate.source_id,
              source_quote: candidate.source_quote,
            })),
            apply_mappings: false,
          }),
        );
        committed_tactic_ids.push(...result.tactic_ids);
      }
    }

    const toOut = (item: (typeof outcome.judged)[number]) => ({
      id: item.candidate.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      type: item.candidate.type,
      status: item.candidate.status,
      evidence_question: item.candidate.evidence_question,
      source_quote: item.candidate.source_quote,
      score: item.score,
      verdict: item.verdict,
      critic_note: item.note,
    });

    return {
      output: {
        mode: outcome.mode,
        proposed: outcome.proposed.length,
        accepted: outcome.judged.filter((item) => item.verdict === "accept").map(toOut),
        rejected: outcome.rejected.map(toOut),
        committed_tactic_ids,
      },
      summary: `${outcome.accepted.length} of ${outcome.proposed.length} tactic candidate(s) accepted${
        input.dry_run ? " (dry run)" : `, ${committed_tactic_ids.length} added to the library`
      }`,
      evals: outcome.metrics,
    };
  },
  evals: {
    async cases() {
      const curated = await curatedS3Cases();
      if (curated.length > 0) return curated;
      const documents = await listParsedDocuments();
      return documents.slice(0, 3).map((document) => ({
        name: document.source_id,
        input: { document_ids: [document.id], dry_run: true },
      }));
    },
    score({ case: testCase, output }) {
      const accepted = output.accepted;
      const real = accepted.filter((candidate) => candidate.status !== "proposed").length;
      // Nothing accepted means the library already covers the document, which is
      // not a quality failure, so those cases carry no target.
      const curated = scoreMustMatch(
        accepted.map((row) => row.evidence_question),
        testCase.gold?.must_match,
      );
      if (accepted.length === 0) {
        return [
          { name: "curated_must_match", value: curated.value, unit: "ratio", target: testCase.gold?.must_match ? 0.3 : undefined, detail: curated.detail },
          { name: "accepted_with_quote", value: 0, unit: "ratio", detail: "no new candidates" },
          { name: "real_inventory_share", value: 0, unit: "ratio", detail: "no new candidates" },
        ];
      }
      return [
        { name: "curated_must_match", value: curated.value, unit: "ratio", target: testCase.gold?.must_match ? 0.3 : undefined, detail: curated.detail },
        {
          name: "accepted_with_quote",
          value:
            accepted.length === 0
              ? 0
              : Number(
                  (accepted.filter((candidate) => candidate.source_quote.trim().length > 0).length /
                    accepted.length).toFixed(3),
                ),
          unit: "ratio",
          target: 1,
        },
        {
          name: "real_inventory_share",
          value: accepted.length === 0 ? 0 : Number((real / accepted.length).toFixed(3)),
          unit: "ratio",
        },
      ];
    },
  },
};

registerModule(tacticExtractModule);

export async function listTacticCandidates(limit = 200) {
  await ensurePlatformSchema([TACTIC_CANDIDATES_DDL]);
  return db().select().from(tacticCandidates).orderBy(desc(tacticCandidates.created_at)).limit(limit);
}
