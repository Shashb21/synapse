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
import { commitExtractedRecords, loadState, resetSeed } from "@/lib/iegp/store";
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
    reason: connected ? null : "No LLM provider is connected. Log in at /control.",
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
    duplicate_of: null,
    confidence: 75,
    reason: `model accepts ${id}`,
  })),
});

describe("S3 on the model path", () => {
  let documentId = "";
  let libraryId = "";
  let savedStub: string | undefined;

  beforeAll(async () => {
    await resetSeed();
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
            duplicate_of: null,
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
              { id: a, verdict: "accept", duplicate_of: libraryId, confidence: 85, reason: "same SLR as the library" },
              { id: b, verdict: "accept", duplicate_of: null, confidence: 80, reason: "new registry" },
              // Invalid: accepting a repeat of a sibling. Asked again.
              { id: c, verdict: "accept", duplicate_of: b, confidence: 70, reason: "repeat" },
            ],
          };
        }
        expect(idsOf(call, "decide")).toEqual([c]);
        return { decisions: [{ id: c, verdict: "reject", duplicate_of: b, confidence: 70, reason: "repeats LT002" }] };
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
});
