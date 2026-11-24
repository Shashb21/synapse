import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/iegp/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iegp/store")>();
  return { ...actual, commitExtractedRecords: vi.fn(actual.commitExtractedRecords) };
});

import "@/modules";
import { ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import { runStage } from "@/modules/kernel/run";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";
import { commitExtractedRecords, loadState, resetDemoSetup } from "@/lib/iegp/store";
import { tacticExtractModule } from "@/modules/stages/s3-tactic-extract/module";

/**
 * The model path of S3, with a scripted model in place of a provider: the
 * model proposes, a model critic reviews every candidate, a model judge decides
 * acceptance and duplicates, and nothing the model gets wrong is filled in.
 */

const ACTOR = { name: "S3 LLM Test", function: "medical_affairs" as const };

type Call = { purpose: string; body: Record<string, unknown> | null; user: string };
type Script = (call: Call) => unknown;

function route(connected: boolean): ResolvedRoute {
  return {
    stage: "S3",
    provider_id: "anthropic-claude",
    provider_label: "Claude",
    model: "claude-test",
    auth: connected ? "api_key" : "none",
    connected,
    params: { temperature: 0, max_tokens: 4096 },
    fallbacks: [],
    degraded: false,
    reason: connected ? null : "No LLM provider has an API key. Set one in the server environment (status in /admin/control).",
  };
}

function context(script: Script, connected = true): { ctx: ModuleContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: ModuleContext = {
    ai: true,
    workspace_id: "default",
    actor: ACTOR,
    role: "medical_affairs",
    route: route(connected),
    run: { id: "s3-test", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    complete: async ({ purpose, user }) => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(user) as Record<string, unknown>;
      } catch {
        body = null;
      }
      const call = { purpose, body, user };
      calls.push(call);
      return script(call);
    },
  };
  return { ctx, calls };
}

const QUOTE = "The ongoing VELA registry follows 800 patients for five years.";
const good = (overrides: Record<string, unknown> = {}) => ({
  name: "VELA registry",
  type: "registry",
  status: "ongoing",
  evidence_question: "What is long-term real-world safety in treated patients?",
  source_quote: QUOTE,
  ...overrides,
});

const idsOf = (call: Call, key: string) =>
  ((call.body?.[key] as { id: string }[] | undefined) ?? []).map((row) => row.id);
const keepAll = (call: Call) => ({
  reviews: idsOf(call, "candidates").map((id) => ({ id, verdict: "keep", confidence: 80, note: `holds: ${id}` })),
});
const acceptAll = (call: Call) => ({
  decisions: idsOf(call, "decide").map((id) => ({
    id,
    verdict: "accept",
    match: "new", target_tactic_id: null, duplicate_of: null,
    confidence: 75,
    reason: `model accepts ${id}`,
  })),
});

describe("S3 on the model path", () => {
  let documentId = "";
  let libraryId = "";
  let savedStub: string | undefined;

  beforeAll(async () => {
    await resetDemoSetup();
    await ensurePlatformSchema(tacticExtractModule.migrations ?? []);
    await wipePlatform(["source_files", "parsed_documents", "gap_candidates", "tactic_candidates"]);
    await runStage({ stage: "S0", input: { demo_ids: ["heor-interview"] }, actor: ACTOR, role: "medical_affairs" });
    await runStage({ stage: "S1", input: {}, actor: ACTOR, role: "medical_affairs" });
    const state = await loadState();
    const source = state.sources[0]!;
    const { listParsedDocuments } = await import("@/modules/stages/s1-parse/module");
    documentId = (await listParsedDocuments())[0]!.id;
    const committed = await commitExtractedRecords({
      source_id: source.id,
      title: source.title,
      stakeholder_function: ACTOR.function,
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
      needs: [],
      gaps: [],
      tactics: [
        {
          id: "seed-1",
          name: "Existing payer SLR",
          type: "slr",
          status: "completed",
          evidence_question: "What comparative effectiveness evidence exists versus standard of care?",
          source_id: source.id,
          source_quote: "A systematic literature review was completed last year.",
          duplicate_of: null,
        },
      ],
      apply_mappings: false,
    });
    libraryId = committed.tactic_ids[0]!;
    expect(libraryId).toBeTruthy();
  }, 120_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    vi.mocked(commitExtractedRecords).mockClear();
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const input = (dry_run = true) => tacticExtractModule.inputSchema.parse({ document_ids: [documentId], dry_run });

  it("throws before doing anything when no LLM is connected", async () => {
    const { ctx, calls } = context(() => ({}), false);
    await expect(tacticExtractModule.run(input(), ctx)).rejects.toBeInstanceOf(NoRouteError);
    await expect(tacticExtractModule.run(input(), ctx)).rejects.toThrow(/control/);
    expect(calls).toHaveLength(0);
  });

  it("uses the model as critic and judge on every candidate, three exchanges", async () => {
    const { ctx, calls } = context((call) => {
      if (call.purpose.startsWith("tactic-proposer:")) {
        return { tactics: [good(), good({ name: "HCRU claims study", type: "hcru_study", status: "planned" })] };
      }
      if (call.purpose === "tactic-critic") return keepAll(call);
      if (call.purpose === "tactic-judge") {
        return {
          decisions: idsOf(call, "decide").map((id, index) => ({
            id,
            verdict: index === 0 ? "accept" : "reject",
            match: "new", target_tactic_id: null, duplicate_of: null,
            confidence: index === 0 ? 90 : 30,
            reason: index === 0 ? "model: real registry" : "model: not described as a tactic",
          })),
        };
      }
      throw new Error(`unexpected call ${call.purpose}`);
    });
    const { output } = await tacticExtractModule.run(input(), ctx);
    expect(output.mode).toBe("llm");
    const critic = calls.filter((call) => call.purpose === "tactic-critic");
    expect(critic).toHaveLength(3);
    for (const call of critic) {
      expect(idsOf(call, "candidates")).toHaveLength(2);
      expect((call.body!.library as { id: string }[]).map((row) => row.id)).toContain(libraryId);
      expect((call.body!.library as Record<string, unknown>[]).find(row => row.id === libraryId)).toMatchObject({population: "", outcomes: "", study_design: "", lock: {locked: false}});
    }
    // No objections, so no revision calls.
    expect(calls.some((call) => call.purpose.startsWith("tactic-proposer-revise"))).toBe(false);
    expect(output.accepted.map((row) => [row.name, row.score, row.critic_note])).toEqual([
      ["VELA registry", 90, "model: real registry"],
    ]);
    expect(output.rejected.map((row) => row.critic_note)).toEqual(["model: not described as a tactic"]);
  });

  it("sends a critic objection back to the model and takes its revision or withdrawal", async () => {
    let criticRound = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose.startsWith("tactic-proposer:")) {
        return { tactics: [good(), good({ name: "Wish list item", type: "rwe_study", status: "proposed" })] };
      }
      if (call.purpose === "tactic-critic") {
        criticRound += 1;
        return {
          reviews: idsOf(call, "candidates").map((id) => ({
            id,
            verdict: criticRound === 1 ? (id.endsWith("LT001") ? "revise" : "drop") : "keep",
            confidence: 60,
            note: id.endsWith("LT001") ? "status should be planned per the quote" : "this is a gap, not a tactic",
          })),
        };
      }
      if (call.purpose.startsWith("tactic-proposer-revise:")) {
        const rows = call.body!.rows as { id: string; objection: string }[];
        return {
          tactics: rows.map((row) =>
            row.id.endsWith("LT001")
              ? { id: row.id, ...good({ status: "planned" }) }
              : { id: row.id, withdraw: true, reason: "conceded: a gap" },
          ),
        };
      }
      if (call.purpose === "tactic-judge") return acceptAll(call);
      throw new Error(`unexpected call ${call.purpose}`);
    });
    const { output } = await tacticExtractModule.run(input(), ctx);
    const revise = calls.filter((call) => call.purpose.startsWith("tactic-proposer-revise:"));
    expect(revise).toHaveLength(1);
    expect((revise[0]!.body!.rows as { objection: string }[]).map((row) => row.objection)).toEqual([
      "revise: status should be planned per the quote",
      "drop: this is a gap, not a tactic",
    ]);
    expect(output.accepted).toHaveLength(1);
    expect(output.accepted[0]).toMatchObject({ name: "VELA registry", status: "planned" });
  });

  it("re-asks for an invalid type and a missing quote instead of guessing them", async () => {
    let fixes = 0;
    const { ctx, calls } = context((call) => {
      if (call.purpose.startsWith("tactic-proposer:")) {
        return {
          tactics: [good({ type: "observational thing" }), good({ name: "HCRU claims study", source_quote: "" })],
        };
      }
      if (call.purpose.startsWith("tactic-proposer-fix:")) {
        fixes += 1;
        const rows = call.body!.rows as { id: string; problem: string }[];
        if (fixes === 1) {
          // First fix only repairs the type; the quote is still missing.
          return { tactics: rows.map((row) => ({ id: row.id, ...good({ source_quote: row.id.endsWith("LT002") ? "" : QUOTE }) })) };
        }
        return {
          tactics: rows.map((row) => ({
            id: row.id,
            ...good({ name: "HCRU claims study", type: "hcru_study", source_quote: "A claims analysis is planned." }),
          })),
        };
      }
      if (call.purpose === "tactic-critic") return keepAll(call);
      if (call.purpose === "tactic-judge") return acceptAll(call);
      throw new Error(`unexpected call ${call.purpose}`);
    });
    const { output } = await tacticExtractModule.run(input(), ctx);
    const fixCalls = calls.filter((call) => call.purpose.startsWith("tactic-proposer-fix:"));
    expect(fixCalls).toHaveLength(2);
    const firstRows = fixCalls[0]!.body!.rows as { id: string; problem: string }[];
    expect(firstRows.map((row) => row.id)).toEqual([`${documentId}-LT001`, `${documentId}-LT002`]);
    expect(firstRows[0]!.problem).toMatch(/type "observational thing" is not one of/);
    expect(firstRows[1]!.problem).toMatch(/source_quote is missing/);
    const secondRows = fixCalls[1]!.body!.rows as { id: string; problem: string }[];
    expect(secondRows.map((row) => row.id)).toEqual([`${documentId}-LT002`]);
    expect(secondRows[0]!.problem).toMatch(/source_quote is missing/);
    expect(output.accepted.map((row) => [row.type, row.source_quote])).toEqual([
      ["registry", QUOTE],
      ["hcru_study", "A claims analysis is planned."],
    ]);
  });

  it("fails the run when the model never gives a valid type", async () => {
    const { ctx } = context((call) => {
      if (call.purpose.startsWith("tactic-proposer")) {
        const rows = (call.body?.rows as { id: string }[] | undefined) ?? [{ id: "" }];
        return { tactics: rows.map((row) => ({ id: row.id, ...good({ type: "unknown" }) })) };
      }
      if (call.purpose === "tactic-critic") return keepAll(call);
      return acceptAll(call);
    });
    await expect(tacticExtractModule.run(input(), ctx)).rejects.toThrow(/did not return a complete tactic/);
  });

  it("fails the run when the model critic never reviews a candidate", async () => {
    const { ctx } = context((call) => {
      if (call.purpose.startsWith("tactic-proposer:")) return { tactics: [good()] };
      if (call.purpose === "tactic-critic") return { reviews: [] };
      return acceptAll(call);
    });
    await expect(tacticExtractModule.run(input(), ctx)).rejects.toThrow(/did not return a complete review/);
  });

  it("passes the judge's duplicate_of to the commit and re-asks for an invalid one", async () => {
    let judgeCalls = 0;
    const { ctx } = context((call) => {
      if (call.purpose.startsWith("tactic-proposer:")) {
        return {
          tactics: [
            good({ name: "Payer SLR update", type: "slr", status: "completed" }),
            good(),
            good({ name: "VELA registry (5y)" }),
          ],
        };
      }
      if (call.purpose === "tactic-critic") return keepAll(call);
      if (call.purpose === "tactic-judge") {
        judgeCalls += 1;
        const [a, b, c] = [`${documentId}-LT001`, `${documentId}-LT002`, `${documentId}-LT003`];
        if (judgeCalls === 1) {
          return {
            decisions: [
              { id: a, verdict: "accept", match: "same", target_tactic_id: libraryId, duplicate_of: libraryId, confidence: 85, reason: "same SLR as the library" },
              { id: b, verdict: "accept", match: "new", target_tactic_id: null, duplicate_of: null, confidence: 80, reason: "new registry" },
              // Invalid: accepting a repeat of a sibling. Asked again.
              { id: c, verdict: "accept", match: "new", target_tactic_id: null, duplicate_of: b, confidence: 70, reason: "repeat" },
            ],
          };
        }
        expect(idsOf(call, "decide")).toEqual([c]);
        return { decisions: [{ id: c, verdict: "reject", match: "new", target_tactic_id: null, duplicate_of: b, confidence: 70, reason: "repeats LT002" }] };
      }
      throw new Error(`unexpected call ${call.purpose}`);
    });
    const { output } = await tacticExtractModule.run(input(false), ctx);
    expect(judgeCalls).toBe(2);
    expect(output.accepted.map((row) => [row.name, row.duplicate_of])).toEqual([
      ["Payer SLR update", libraryId],
      ["VELA registry", null],
    ]);
    expect(output.rejected.map((row) => [row.name, row.duplicate_of])).toEqual([
      ["VELA registry (5y)", `${documentId}-LT002`],
    ]);
    const commits = vi.mocked(commitExtractedRecords).mock.calls;
    expect(commits).toHaveLength(1);
    expect(commits[0]![0].tactics.map((row) => [row.name, row.duplicate_of])).toEqual([
      ["Payer SLR update", libraryId],
      ["VELA registry", null],
    ]);
  });
  it("returns explicit same/new classifications and publishes a changed manifest", async () => {
    const {ctx} = context(call => {
      if (call.purpose.startsWith("tactic-proposer:")) return {tactics: [good()]};
      if (call.purpose === "tactic-critic") return keepAll(call);
      return acceptAll(call);
    });
    const {output} = await tacticExtractModule.run(input(), ctx);
    expect(output.accepted[0]).toMatchObject({match: "new", target_tactic_id: null});
    expect(tacticExtractModule.manifest.version).toBe("3.1.0");
  });
  it.each([
    {match: "same", target_tactic_id: null},
    {match: "overlaps", target_tactic_id: "unknown"},
    {match: "new", target_tactic_id: "known"},
    {match: "invented", target_tactic_id: null},
  ])("rejects invalid matching payload %j through existing repair retries", async match => {
    const {ctx} = context(call => {
      if (call.purpose.startsWith("tactic-proposer:")) return {tactics: [good()]};
      if (call.purpose === "tactic-critic") return keepAll(call);
      return {decisions: idsOf(call, "decide").map(id => ({id, verdict: "accept", duplicate_of: null, confidence: 80, reason: "Attempted match", ...match}))};
    });
    await expect(tacticExtractModule.run(input(), ctx)).rejects.toThrow(/complete judge decision/);
  });

  it("claims each tactic once and preserves different studies supported by one sentence", async () => {
    const quote = "Finch sponsors an outcomes registry and an economic review.";
    const run = (withReview: boolean) => {
      const { ctx } = context(call => {
        if (call.purpose.startsWith("tactic-proposer:")) return { tactics: [
          good({ source_quote: quote }), good({ source_quote: quote }),
          ...(withReview ? [good({ name: "Economic review", type: "slr", evidence_question: "What are the costs?", source_quote: quote })] : []),
        ] };
        return call.purpose === "tactic-critic" ? keepAll(call) : acceptAll(call);
      });
      return tacticExtractModule.run(input(false), ctx);
    };
    expect((await run(false)).output.committed_tactic_ids).toHaveLength(1);
    expect((await run(true)).output.committed_tactic_ids).toHaveLength(1);
    expect((await run(true)).output.committed_tactic_ids).toEqual([]);
  });

  it.each([
    { batch: "one batch", activities: ["Alpha", "Beta"] },
    { batch: "separate batches", activities: ["Gamma", "Delta"] },
  ])("persists named registries from a shared quotation in $batch", async ({ batch, activities }) => {
    const quote = `The ${activities.join(" and ")} registries will evaluate long-term safety.`;
    const names = activities.map(activity => `${activity} registry`);
    const run = (activityNames: string[]) => {
      const { ctx } = context(call => {
        if (call.purpose.startsWith("tactic-proposer:")) return { tactics:
          activityNames.map(name => good({ name, status: "planned", source_quote: quote })),
        };
        return call.purpose === "tactic-critic" ? keepAll(call) : acceptAll(call);
      });
      return tacticExtractModule.run(input(false), ctx);
    };
    const batches = batch === "one batch" ? [names] : names.map(name => [name]);
    const committed: string[] = [];
    for (const activityNames of batches) {
      const { output } = await run(activityNames);
      expect(output.accepted.map(candidate => candidate.name)).toEqual(activityNames);
      committed.push(...output.committed_tactic_ids);
    }
    const state = await loadState();
    expect(state.tactics.filter(tactic => committed.includes(tactic.id)).map(tactic => tactic.name))
      .toEqual(names);
    expect((await run(names)).output.committed_tactic_ids).toEqual([]);
  });

  it("lets a mapping transaction lock the source while extraction waits for its tactic", async () => {
    const postgres = (await import("postgres")).default;
    const { currentSchemaName } = await import("@/lib/iegp/db");
    const { listParsedDocuments } = await import("@/modules/stages/s1-parse/module");
    const { listTacticSourceReferences } = await import("@/modules/stages/s3-tactic-extract/suggestions");
    const { source_id: sourceId } = (await listParsedDocuments([documentId]))[0]!;
    const schema = await currentSchemaName();
    const quote = "Aster's payer review confirms the existing comparative analysis.";
    const { ctx } = context(call => {
      if (call.purpose.startsWith("tactic-proposer:")) {
        return { tactics: [good({ name: "Aster payer review", type: "slr", source_quote: quote })] };
      }
      if (call.purpose === "tactic-critic") return keepAll(call);
      return { decisions: idsOf(call, "decide").map(id => ({
        id, verdict: "accept", match: "same", target_tactic_id: libraryId, confidence: 90, reason: "Same review.",
      })) };
    });
    const connection = postgres(process.env.DATABASE_URL!, { max: 1 });
    let extraction: Promise<unknown> | undefined;
    try {
      await connection.begin(async tx => {
        await tx`set local lock_timeout = '2s'`;
        await tx`select id from ${tx(schema)}.tactics where id = ${libraryId} for update`;
        extraction = tacticExtractModule.run(input(false), ctx);
        void extraction.catch(() => {});
        await vi.waitFor(async () => {
          const [lock] = await tx`select exists (
            select 1 from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid))
          ) as blocked`;
          expect(lock?.blocked).toBe(true);
        }, { timeout: 5_000, interval: 20 });
        await tx`select id from ${tx(schema)}.sources where id = ${sourceId} for update`;
      });
      await extraction;
      expect(await listTacticSourceReferences(libraryId)).toContainEqual(expect.objectContaining({ source_quote: quote }));
    } finally {
      await extraction?.catch(() => {});
      await connection.end();
    }
  });

  it("rejects a tactic commit when a reviewer updates the source during judging", async () => {
    const { editSourceBlock, listSourceBlocks } = await import("@/lib/iegp/source-blocks");
    const { listParsedDocuments } = await import("@/modules/stages/s1-parse/module");
    const sourceId = (await listParsedDocuments([documentId]))[0]!.source_id;
    const block = (await listSourceBlocks(sourceId))[0]!;
    const { ctx } = context(async call => {
      if (call.purpose.startsWith("tactic-proposer:")) return { tactics: [good({ source_quote: block.text })] };
      if (call.purpose === "tactic-critic") return keepAll(call);
      await editSourceBlock({ block_id: block.id, text: block.text + " Revised.", actor: ACTOR, rationale: "Correct the source." });
      return acceptAll(call);
    });
    const before = await loadState();
    await expect(tacticExtractModule.run(input(false), ctx)).rejects.toThrow(/source.*changed/i);
    expect((await loadState()).tactics).toEqual(before.tactics);
  });

  const scope = {name: "SLR subgroup", evidence_question: "What safety evidence exists in subgroup?", population: "Subgroup", outcomes: "", geography: "", data_cut: "", analysis: "Post-hoc subgroup", instrument: "", study_design: "Retrospective analysis", gap_coverage: "Subgroup evidence", cost_effort: "Source does not specify", timing: "Source does not specify", feasibility_risks: "Requires source review", post_hoc: true, prospective_enrolment: false, protocol_amendment: false, start_date: null, evidence_available: null};

  it("persists valid overlaps as source review only and retains edited review on rerun", async () => {
    const {listTacticSuggestions, editTacticSuggestion} = await import("@/modules/stages/s3-tactic-extract/suggestions");
    const {ctx} = context(call => {
      if (call.purpose.startsWith("tactic-proposer:")) return {tactics: [good({type: "slr", status: "planned", source_quote: "The Vega review includes a new subgroup."})]};
      if (call.purpose === "tactic-critic") return keepAll(call);
      return {decisions: idsOf(call, "decide").map(id => ({id, verdict: "accept", match: "overlaps", target_tactic_id: libraryId, shared_scope: "Existing SLR", new_scope: "Subgroup evidence", expansion: scope, separate: {name: "Independent subgroup SLR", type: "slr", status: "planned", evidence_question: scope.evidence_question}, confidence: 80, reason: "Shared SLR and added subgroup"}))};
    });
    const { listParsedDocuments } = await import("@/modules/stages/s1-parse/module");
    const { addSourceBlock, editSourceBlock } = await import("@/lib/iegp/source-blocks");
    const doc = (await listParsedDocuments([documentId]))[0]!;
    const block = await addSourceBlock({ source_id: doc.source_id, text: "The Vega review includes a new subgroup.", actor: ACTOR, rationale: "Record source review." });
    const before = await loadState();
    const {output} = await tacticExtractModule.run(input(false), ctx);
    expect(output.accepted[0]).toMatchObject({match: "overlaps", target_tactic_id: libraryId, expansion: scope});
    expect(output.committed_tactic_ids).toEqual([]); expect(await loadState()).toEqual(before);
    const suggestion = (await listTacticSuggestions()).find(r => r.target_tactic_id === libraryId)!;
    const edited = await editTacticSuggestion({id: suggestion.id, expansion: {...scope, name: "Human subgroup review"}, rationale: "Source reviewed", actor: ACTOR});
    await tacticExtractModule.run(input(false), ctx);
    expect((await listTacticSuggestions()).find(r => r.id === suggestion.id)).toEqual(edited);
    const {decideTacticSuggestion} = await import("@/modules/stages/s3-tactic-extract/suggestions");
    const decided = await decideTacticSuggestion({id: edited.id, decision: "reject", actor: ACTOR, rationale: "Subgroup review declined."});
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    try {
      await runStage({ stage: "S1", input: { file_ids: [doc.file_id] }, actor: ACTOR, role: ACTOR.function });
    } finally { delete process.env.SYNAPSE_TEST_STUB_LLM; }
    const current = (await listParsedDocuments()).find(row => row.source_id === doc.source_id)!;
    expect(current.id).not.toBe(documentId);
    await editSourceBlock({ block_id: block.id, text: block.text + " A distinct Vega registry enrolls children.", actor: ACTOR, rationale: "Add the new registry." });
    const rerun = context(call => {
      if (call.purpose.startsWith("tactic-proposer:")) return {tactics: [
        good({name: "Vega subgroup", type: "registry", evidence_question: "What evidence is available on long-term real-world safety in treated patients?", source_quote: suggestion.source_quote}),
        good({name: "New Vega registry", source_quote: "A distinct Vega registry enrolls children."}),
        good({name: "Vega subgroup", type: "slr", source_quote: suggestion.source_quote}),
      ]};
      if (call.purpose === "tactic-critic") return keepAll(call);
      return acceptAll(call);
    });
    rerun.ctx.run.id = "repeated-tactic-run";
    const repeats = await Promise.all([tacticExtractModule.run(input(false), rerun.ctx), tacticExtractModule.run(input(false), rerun.ctx)]);
    expect(repeats.flatMap(run => run.output.committed_tactic_ids)).toHaveLength(1);
    expect(repeats[0]!.output.accepted.every(row => row.document_id === current.id)).toBe(true);
    expect((await tacticExtractModule.run(input(false), rerun.ctx)).output.committed_tactic_ids).toEqual([]);
    expect((await listTacticSuggestions()).find(r => r.id === suggestion.id)).toEqual(decided);
    expect((await loadState()).tactics.length).toBe(before.tactics.length + 1);

    // Historical suggestions predate the immutable key. Their candidate still records the source question.
    const { db } = await import("@/lib/iegp/db");
    const { sql } = await import("drizzle-orm");
    await db().execute(sql`UPDATE tactic_suggestions SET payload = payload - 'finding_key' WHERE id = ${suggestion.id}`);
    expect((await tacticExtractModule.run(input(false), rerun.ctx)).output.committed_tactic_ids).toEqual([]);

  });

  it("queues distinct same-run overlap alternatives supported by one passage and question", async () => {
    const { listTacticSuggestions } = await import("@/modules/stages/s3-tactic-extract/suggestions");
    const { addSourceBlock } = await import("@/lib/iegp/source-blocks");
    const { listParsedDocuments } = await import("@/modules/stages/s1-parse/module");
    const doc = (await listParsedDocuments([documentId]))[0]!;
    const quote = "A registry and a systematic review will both examine subgroup safety.";
    const alternatives = [
      { name: "Subgroup registry", type: "registry", status: "planned", evidence_question: scope.evidence_question },
      { name: "Subgroup systematic review", type: "slr", status: "planned", evidence_question: scope.evidence_question },
    ];
    await addSourceBlock({ source_id: doc.source_id, text: quote, actor: ACTOR, rationale: "Document both studies." });
    const { ctx } = context(call => {
      if (call.purpose.startsWith("tactic-proposer:")) {
        return { tactics: alternatives.map(option => good({ ...option, source_quote: quote })) };
      }
      if (call.purpose === "tactic-critic") return keepAll(call);
      return { decisions: idsOf(call, "decide").map((id, i) => ({
        id, verdict: "accept", match: "overlaps", target_tactic_id: libraryId, shared_scope: "Subgroup safety",
        new_scope: alternatives[i]!.name, expansion: { ...scope, name: alternatives[i]!.name }, separate: alternatives[i],
        confidence: 90, reason: "The passage documents both studies.",
      })) };
    });
    const { output } = await tacticExtractModule.run(input(false), ctx);
    expect(output.accepted.map(candidate => candidate.type)).toEqual(["registry", "slr"]);
    const rows = (await listTacticSuggestions()).filter(row => row.target_tactic_id === libraryId && row.source_quote === quote);
    expect(rows).toHaveLength(2);
    for (const option of alternatives) {
      expect(rows).toContainEqual(expect.objectContaining({ new_scope: option.name, original_separate: option, status: "pending" }));
    }
  });

});
