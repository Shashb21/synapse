import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { runAgenticCycle, type Critique } from "@/modules/kernel/agentic";
import { canPrompt } from "@/modules/kernel/routing";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { EVIDENCE_DOMAINS, type EvidenceDomain } from "@/lib/iegp/enums";
import { commitExtractedRecords, loadState } from "@/lib/iegp/store";
import {
  extractCandidateGaps,
  gapNameFromStatement,
  guessDomain,
  isLiveGap,
  similarRecord,
} from "@/lib/iegp/engine";
import { listParsedDocuments, type ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import { GAP_CANDIDATES_DDL, gapCandidates } from "./schema";
import { GAP_CRITIC_SYSTEM, GAP_PROPOSER_SYSTEM, gapProposerUser } from "./prompts";

const inputSchema = z.object({
  /** Defaults to every parsed document. */
  document_ids: z.array(z.string()).optional(),
  /** Propose and judge without committing to the domain store. Used by evals. */
  dry_run: z.boolean().default(false),
});

const candidateSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  source_id: z.string(),
  name: z.string(),
  statement: z.string(),
  domain: z.string(),
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
  committed_gap_ids: z.array(z.string()),
  committed_need_ids: z.array(z.string()),
});

export type GapExtractInput = z.infer<typeof inputSchema>;
export type GapExtractOutput = z.infer<typeof outputSchema>;

type GapCandidate = {
  id: string;
  document_id: string;
  source_id: string;
  name: string;
  statement: string;
  domain: EvidenceDomain;
  source_quote: string;
};

function asDomain(value: string, fallback: string): EvidenceDomain {
  return EVIDENCE_DOMAINS.includes(value as EvidenceDomain)
    ? (value as EvidenceDomain)
    : guessDomain(fallback);
}

function localProposals(documents: ParsedDocumentRecord[]): GapCandidate[] {
  return documents.flatMap((document) =>
    extractCandidateGaps(document.blocks).map((gap, index) => ({
      id: `${document.id}-G${String(index + 1).padStart(3, "0")}`,
      document_id: document.id,
      source_id: document.source_id,
      name: gap.name,
      statement: gap.statement,
      domain: gap.domain,
      source_quote: gap.source_quote,
    })),
  );
}

async function llmProposals(
  ctx: ModuleContext,
  documents: ParsedDocumentRecord[],
  hints: string,
): Promise<GapCandidate[]> {
  const out: GapCandidate[] = [];
  for (const document of documents) {
    const payload = (await ctx.complete({
      system: GAP_PROPOSER_SYSTEM,
      user: gapProposerUser({
        title: document.blocks[0]?.heading ?? document.source_id,
        blocks: document.blocks,
        hints,
      }),
      purpose: `gap-proposer:${document.id}`,
    })) as { gaps?: { name?: string; statement?: string; domain?: string; source_quote?: string }[] };
    for (const [index, gap] of (payload.gaps ?? []).entries()) {
      const statement = (gap.statement ?? "").trim();
      if (!statement) continue;
      out.push({
        id: `${document.id}-L${String(index + 1).padStart(3, "0")}`,
        document_id: document.id,
        source_id: document.source_id,
        name: (gap.name ?? "").trim() || gapNameFromStatement(statement),
        statement,
        domain: asDomain(gap.domain ?? "", statement),
        source_quote: (gap.source_quote ?? statement).slice(0, 280),
      });
    }
  }
  return out;
}

const TACTIC_SHAPED = /\b(we will (run|conduct)|is (underway|ongoing|planned)|protocol|registry study|manuscript|abstract)\b/i;
const VAGUE = /^(more data|further research|additional evidence)/i;

function heuristicCritique(args: {
  candidate: GapCandidate;
  liveStatements: string[];
  siblings: GapCandidate[];
}): { score: number; note: string } {
  const { candidate } = args;
  let score = 62;
  const notes: string[] = [];
  const words = candidate.statement.split(/\s+/).length;
  if (words < 6) {
    score -= 25;
    notes.push("statement too short to be actionable");
  }
  if (words > 60) {
    score -= 10;
    notes.push("statement bundles several questions");
  }
  if (TACTIC_SHAPED.test(candidate.statement)) {
    score -= 30;
    notes.push("reads as a tactic already in flight, not a gap");
  }
  if (VAGUE.test(candidate.statement)) {
    score -= 20;
    notes.push("too vague to decide against");
  }
  if (candidate.domain === "unmet_need") {
    score -= 5;
    notes.push("domain not specific");
  } else {
    score += 8;
  }
  if (!candidate.source_quote.trim()) {
    score -= 15;
    notes.push("no source quote");
  }
  if (args.liveStatements.some((statement) => similarRecord(statement, candidate.statement))) {
    score -= 18;
    notes.push("duplicates a gap already in the plan");
  }
  const duplicateSibling = args.siblings.find(
    (sibling) => sibling.id !== candidate.id && similarRecord(sibling.statement, candidate.statement, 0.72),
  );
  if (duplicateSibling) {
    score -= 12;
    notes.push(`overlaps candidate ${duplicateSibling.id}`);
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    note: notes.length ? notes.join("; ") : "atomic, decision-relevant, traceable to a quote",
  };
}

async function llmCritique(
  ctx: ModuleContext,
  candidates: GapCandidate[],
): Promise<Map<string, { score: number; note: string; verdict: Critique["verdict"] }>> {
  const payload = (await ctx.complete({
    system: GAP_CRITIC_SYSTEM,
    user: JSON.stringify(
      candidates.map((candidate) => ({
        subject: candidate.id,
        statement: candidate.statement,
        domain: candidate.domain,
        source_quote: candidate.source_quote,
      })),
    ),
    purpose: "gap-critic",
  })) as {
    critiques?: { subject?: string; verdict?: string; score?: number; note?: string }[];
  };
  const map = new Map<string, { score: number; note: string; verdict: Critique["verdict"] }>();
  for (const critique of payload.critiques ?? []) {
    if (!critique.subject) continue;
    const verdict: Critique["verdict"] =
      critique.verdict === "drop" ? "drop" : critique.verdict === "revise" ? "revise" : "keep";
    map.set(critique.subject, {
      score: Math.max(0, Math.min(100, Math.round(critique.score ?? 50))),
      note: (critique.note ?? "").trim() || "no note",
      verdict,
    });
  }
  return map;
}

export const gapExtractModule: SynapseModule<GapExtractInput, GapExtractOutput> = {
  manifest: {
    id: "s2-gap-extract.pcj",
    stage: "S2",
    version: "1.0.0",
    title: "Gap extraction (proposer → critic → judge)",
    summary:
      "Proposes evidence gaps per parsed document, critiques them for atomicity and decision relevance, judges what commits.",
    contract: 1,
    agentic: true,
    capabilities: ["llm-proposer", "local-proposer", "hillclimb-hints"],
  },
  inputSchema,
  outputSchema,
  migrations: [GAP_CANDIDATES_DDL],
  async run(input, ctx) {
    const documents = await listParsedDocuments(input.document_ids);
    if (documents.length === 0) {
      return {
        output: {
          mode: "deterministic",
          proposed: 0,
          accepted: [],
          rejected: [],
          committed_gap_ids: [],
          committed_need_ids: [],
        },
        summary: "No parsed documents to extract from",
      };
    }
    const state = await loadState();
    const liveStatements = state.gaps.filter(isLiveGap).flatMap((gap) => [gap.statement, gap.name]);

    const outcome = await runAgenticCycle<GapCandidate>(ctx, "S2", {
      subjectOf: (candidate) => candidate.id,
      proposer: {
        local: () => localProposals(documents),
        llm: canPrompt(ctx.route)
          ? ({ hints }) => llmProposals(ctx, documents, hints)
          : undefined,
      },
      critic: async (candidates) => {
        const llm = canPrompt(ctx.route)
          ? await llmCritique(ctx, candidates).catch((error) => {
              ctx.run.note("critic:llm_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
              return new Map<string, { score: number; note: string; verdict: Critique["verdict"] }>();
            })
          : new Map<string, { score: number; note: string; verdict: Critique["verdict"] }>();
        return candidates.map((candidate) => {
          const local = heuristicCritique({ candidate, liveStatements, siblings: candidates });
          const remote = llm.get(candidate.id);
          const score = remote ? Math.round((local.score + remote.score) / 2) : local.score;
          const note = remote ? `${remote.note} | local: ${local.note}` : local.note;
          const verdict: Critique["verdict"] =
            remote?.verdict === "drop" || score < 35 ? "drop" : score >= 60 ? "keep" : "revise";
          return { subject: candidate.id, verdict, note, score };
        });
      },
      judge: ({ candidates, critiques }) => {
        const kept: GapCandidate[] = [];
        return candidates.map((candidate) => {
          const critique = critiques.find((item) => item.subject === candidate.id);
          const score = critique?.score ?? 50;
          const duplicateOfKept = kept.some((other) =>
            similarRecord(other.statement, candidate.statement, 0.72),
          );
          const accept = critique?.verdict !== "drop" && score >= 45 && !duplicateOfKept;
          if (accept) kept.push(candidate);
          return {
            candidate,
            subject: candidate.id,
            verdict: accept ? ("accept" as const) : ("reject" as const),
            score,
            note: duplicateOfKept
              ? "Rejected: duplicate of a gap already accepted in this run."
              : (critique?.note ?? "no critique"),
          };
        });
      },
    });

    const rows = outcome.judged.map((item) => ({
      id: newId("gc"),
      run_id: ctx.run.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      statement: item.candidate.statement,
      domain: item.candidate.domain,
      source_quote: item.candidate.source_quote,
      score: item.score,
      verdict: item.verdict,
      critic_note: item.note,
      proposer: outcome.mode,
      committed_gap_id: null as string | null,
      created_at: nowIso(),
    }));
    if (rows.length > 0) await db().insert(gapCandidates).values(rows);

    const committed_gap_ids: string[] = [];
    const committed_need_ids: string[] = [];
    if (!input.dry_run) {
      for (const document of documents) {
        const accepted = outcome.accepted.filter(
          (candidate) => candidate.document_id === document.id,
        );
        if (accepted.length === 0) continue;
        const source = state.sources.find((row) => row.id === document.source_id);
        const result = await ctx.run.step(`commit:${document.id}`, () =>
          commitExtractedRecords({
            source_id: document.source_id,
            title: source?.title ?? document.source_id,
            stakeholder_function: source?.stakeholder_function ?? ctx.actor.function,
            actor_name: ctx.actor.name,
            actor_function: ctx.actor.function,
            needs: accepted.map((candidate) => ({
              id: candidate.id,
              statement: candidate.statement,
              source_quote: candidate.source_quote,
            })),
            gaps: accepted.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              statement: candidate.statement,
              domain: candidate.domain,
              source_id: candidate.source_id,
              source_quote: candidate.source_quote,
            })),
            tactics: [],
            apply_mappings: false,
          }),
        );
        committed_gap_ids.push(...result.gap_ids);
        committed_need_ids.push(...result.need_ids);
      }
    }

    const toOut = (item: (typeof outcome.judged)[number]) => ({
      id: item.candidate.id,
      document_id: item.candidate.document_id,
      source_id: item.candidate.source_id,
      name: item.candidate.name,
      statement: item.candidate.statement,
      domain: item.candidate.domain,
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
        committed_gap_ids,
        committed_need_ids,
      },
      summary: `${outcome.accepted.length} of ${outcome.proposed.length} gap candidate(s) accepted${
        input.dry_run ? " (dry run)" : `, ${committed_gap_ids.length} new gap(s) committed`
      }`,
      evals: outcome.metrics,
    };
  },
  evals: {
    async cases() {
      const documents = await listParsedDocuments();
      return documents.slice(0, 3).map((document) => ({
        name: document.source_id,
        input: { document_ids: [document.id], dry_run: true },
      }));
    },
    score({ output }) {
      const accepted = output.accepted.length;
      const total = accepted + output.rejected.length;
      if (accepted === 0) {
        return [
          { name: "gold_accept_rate", value: 0, unit: "ratio", detail: "no new candidates" },
          { name: "accepted_with_quote", value: 0, unit: "ratio", detail: "no new candidates" },
        ];
      }
      return [
        { name: "gold_accept_rate", value: total === 0 ? 0 : Number((accepted / total).toFixed(3)), unit: "ratio", target: 0.3 },
        { name: "accepted_with_quote", value: accepted === 0 ? 0 : Number((output.accepted.filter((c) => c.source_quote.trim().length > 0).length / accepted).toFixed(3)), unit: "ratio", target: 1 },
      ];
    },
  },
};

registerModule(gapExtractModule);

export async function listGapCandidates(limit = 200) {
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  return db().select().from(gapCandidates).orderBy(desc(gapCandidates.created_at)).limit(limit);
}

export async function gapCandidatesForRun(run_id: string) {
  await ensurePlatformSchema([GAP_CANDIDATES_DDL]);
  return db().select().from(gapCandidates).where(eq(gapCandidates.run_id, run_id));
}
