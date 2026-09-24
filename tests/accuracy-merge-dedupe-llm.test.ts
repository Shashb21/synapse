import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccuracyModuleContext, JsonCompletion } from "@/accuracy/kernel/contracts";
import {
  equivalenceQuestions,
  type MergeCandidate,
} from "@/accuracy/modules/merge-dedupe/engine";
import { judgeEquivalence } from "@/accuracy/modules/merge-dedupe/judge";
import { mergeDedupeModule } from "@/accuracy/modules/merge-dedupe/module";
import { MERGE_EQUIVALENCE_SYSTEM } from "@/accuracy/modules/merge-dedupe/prompts";
import { claimMetadata, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { NoRouteError } from "@/modules/llm/provider";

const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function fakeCtx(complete: JsonCompletion, connected = true): AccuracyModuleContext {
  return {
    org_id: "org-test",
    workspace_id: "ws-test",
    actor: { name: "test", function: "medical_affairs" },
    role: "medical_affairs",
    run: { id: "arun-merge", note: () => {}, step: async (_n, fn) => await fn(), steps: () => [] },
    route: {
      call_kind: "merge_dedupe",
      role: "judge",
      provider_id: connected ? "xai-grok" : "none",
      provider_label: connected ? "Grok" : "None",
      model: connected ? "grok" : "none",
      auth: connected ? "oauth" : "none",
      connected,
      params: { temperature: 0, max_tokens: 8192 },
      fallbacks: [],
      degraded: false,
      reason: null,
    },
    complete,
    noteCost: () => {},
  };
}

/** Answers each pair_id in the prompt: same when both statements appear in `same`. */
function scriptedJudge(same: (user: string, pairBlock: string) => boolean, omitFirst = false) {
  let calls = 0;
  return vi.fn<JsonCompletion>(async ({ user }) => {
    calls += 1;
    const blocks = user.split("### ").filter(Boolean);
    const decisions = blocks
      .map((pairBlock) => {
        const pair_id = pairBlock.match(/pair_id=(\S+)/)?.[1];
        return { pair_id, same: same(user, pairBlock), rationale: "scripted" };
      })
      .filter((_d, index) => !(omitFirst && calls === 1 && index === 0));
    return { raw: JSON.stringify({ decisions }), usage };
  });
}

const shared = (quote: string) => [{ source_file_id: "s", block_id: "row-1", quote }];

function candidate(
  partial: Partial<MergeCandidate> & Pick<MergeCandidate, "id" | "claim_type" | "statement">,
): MergeCandidate {
  return {
    validated: false,
    status: "draft",
    source_file_id: "s",
    reference_pack_id: null,
    external_id: null,
    tactic_status: null,
    provenance: [],
    created_at: "2026-09-23T00:00:00.000Z",
    ...partial,
  };
}

describe("merge equivalence judge (scripted model)", () => {
  let savedStub: string | undefined;
  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  const candidates = [
    candidate({ id: "g1", claim_type: "gap", statement: "Need OS data in elderly", provenance: shared("OS elderly") }),
    candidate({ id: "g2", claim_type: "gap", statement: "Overall survival evidence for patients 75+", provenance: shared("75+") }),
    candidate({ id: "g3", claim_type: "gap", statement: "Need PFS data in elderly", provenance: shared("PFS") }),
  ];

  it("throws without a connected LLM when there is a pair to decide", async () => {
    const complete = scriptedJudge(() => true);
    await expect(
      judgeEquivalence({ ctx: fakeCtx(complete, false), questions: equivalenceQuestions(candidates), candidates }),
    ).rejects.toBeInstanceOf(NoRouteError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns only the pairs the model calls the same, re-asking one it skipped", async () => {
    const complete = scriptedJudge(
      (_user, pairBlock) => pairBlock.includes("Need OS data in elderly") && pairBlock.includes("75+"),
      true,
    );
    const equivalent = await judgeEquivalence({
      ctx: fakeCtx(complete),
      questions: equivalenceQuestions(candidates),
      candidates,
    });
    expect(equivalent).toEqual([{ a_id: "g1", b_id: "g2", rationale: "scripted" }]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0].system).toBe(MERGE_EQUIVALENCE_SYSTEM);
    // The retry asks only for the pair left out.
    expect(complete.mock.calls[1]![0].user.match(/pair_id=/g)).toHaveLength(1);
  });

  it("fails rather than guess when the model never answers", async () => {
    const complete = vi.fn<JsonCompletion>(async () => ({ raw: "{}", usage }));
    await expect(
      judgeEquivalence({ ctx: fakeCtx(complete), questions: equivalenceQuestions(candidates), candidates }),
    ).rejects.toThrow(/did not return a complete dedupe decision/);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("module persists a judged merge with the model's rationale", async () => {
    const org_id = await createOrganization("Merge LLM org");
    const workspace_id = await createWorkspace({
      org_id,
      name: "Merge LLM WS",
      slug: `merge-llm-${Date.now().toString(36)}`,
    });
    const a = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS data in elderly",
      metadata: { provenance: shared("OS elderly") },
    });
    const b = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Overall survival evidence for patients 75+",
      metadata: { provenance: shared("75+") },
    });
    const complete = scriptedJudge(() => true);
    const ctx = fakeCtx(complete);
    ctx.workspace_id = workspace_id;
    const result = await mergeDedupeModule.run({ workspace_id }, ctx);
    expect(result.output.mode).toBe("llm");
    expect(result.output.judged_pairs).toBe(1);
    expect(result.output.merged).toBe(1);
    expect(result.output.merges[0]?.reason).toBe("model_equivalence");

    const claims = await listClaims(workspace_id);
    const merged = claims.find((c) => c.status === "merged");
    expect([a.id, b.id]).toContain(merged?.id);
    expect(claimMetadata(merged!).merge_rationale).toBe("scripted");
  });
});
