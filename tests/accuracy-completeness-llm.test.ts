import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccuracyModuleContext, JsonCompletion } from "@/accuracy/kernel/contracts";
import { completenessAuditModule } from "@/accuracy/modules/completeness-audit/module";
import { judgeCompleteness } from "@/accuracy/modules/completeness-audit/critic";
import { COMPLETENESS_CRITIC_SYSTEM } from "@/accuracy/modules/completeness-audit/prompts";
import { insertClaim } from "@/accuracy/store/claim-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { NoRouteError } from "@/modules/llm/provider";

type Verdict = { missed: boolean; claim_type: "gap" | "tactic" | null; rationale: string };

const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/** A scripted critic: answers each block_id in the prompt from `script`, skipping `omit` once. */
function scriptedCritic(script: Record<string, Verdict>, omitOnce: string[] = []) {
  const omitted = new Set<string>();
  const fn = vi.fn<JsonCompletion>(async ({ user }) => {
    const ids = [...user.matchAll(/block_id=([^\s·]+)/g)].map((m) => m[1]!);
    const verdicts = ids
      .filter((id) => {
        if (omitOnce.includes(id) && !omitted.has(id)) {
          omitted.add(id);
          return false;
        }
        return id in script;
      })
      .map((id) => ({ block_id: id, ...script[id]! }));
    return { raw: JSON.stringify({ verdicts }), usage };
  });
  return fn;
}

function fakeCtx(complete: JsonCompletion, connected = true): AccuracyModuleContext {
  return {
    org_id: "org-test",
    workspace_id: "ws-test",
    actor: { name: "test", function: "medical_affairs" },
    role: "medical_affairs",
    run: { id: "arun-completeness", note: () => {}, step: async (_n, fn) => await fn(), steps: () => [] },
    route: {
      call_kind: "completeness_audit",
      role: "critic",
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

const block = (id: string, index: number, text: string, kind = "prose") => ({
  id,
  source_file_id: "src",
  index,
  kind,
  text,
});

describe("completeness critic (scripted model)", () => {
  let savedStub: string | undefined;
  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  it("throws without a connected LLM instead of applying rules", async () => {
    const complete = scriptedCritic({});
    await expect(
      judgeCompleteness({ ctx: fakeCtx(complete, false), blocks: [block("b1", 0, "text")], claims: [] }),
    ).rejects.toBeInstanceOf(NoRouteError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("takes the model's verdict and claim type, and re-asks for a block it left out", async () => {
    const complete = scriptedCritic(
      {
        b1: { missed: true, claim_type: "tactic", rationale: "An ongoing chart review not in the ledger." },
        b2: { missed: false, claim_type: null, rationale: "Chapter divider." },
      },
      ["b2"],
    );
    const verdicts = await judgeCompleteness({
      ctx: fakeCtx(complete),
      blocks: [block("b1", 0, "Chart review in 65+ is underway."), block("b2", 1, "Evidence gaps: ESCC")],
      claims: [],
    });
    expect(verdicts.get("b1")).toMatchObject({ missed: true, claim_type: "tactic" });
    expect(verdicts.get("b2")?.missed).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0].system).toBe(COMPLETENESS_CRITIC_SYSTEM);
    expect(complete.mock.calls[1]![0].user).toContain("block_id=b2");
    expect(complete.mock.calls[1]![0].user).not.toContain("block_id=b1");
  });

  it("fails rather than fill in a block the model never answers", async () => {
    const complete = scriptedCritic({ b1: { missed: true, claim_type: null, rationale: "no type" } });
    await expect(
      judgeCompleteness({ ctx: fakeCtx(complete), blocks: [block("b1", 0, "x")], claims: [] }),
    ).rejects.toThrow(/did not return a complete completeness verdict for block b1/);
    expect(complete).toHaveBeenCalledTimes(3);
  });
});

describe("completeness audit module (scripted model, stored verdicts)", () => {
  let savedStub: string | undefined;
  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  it("flags model-judged misses, reuses verdicts, and re-asks misses when the ledger changes", async () => {
    const org_id = await createOrganization("Completeness LLM org");
    const workspace_id = await createWorkspace({
      org_id,
      name: "Completeness LLM WS",
      slug: `completeness-llm-${Date.now().toString(36)}`,
    });
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "plan.txt",
      mime: "text/plain",
      checksum: `chk-${Date.now()}`,
      doc_role: "medical",
    });
    const id = (n: string) => `${source.id}-${n}`;
    await persistParseBlocks({
      workspace_id,
      source_file_id: source.id,
      parser: "local_structured",
      blocks: [
        { id: id("B1"), source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Need for real-world pneumonitis monitoring outside academic centres." },
        { id: id("B2"), source_file_id: source.id, index: 1, kind: "heading", heading: null, text: "Transversal gaps across all indications" },
        { id: id("B3"), source_file_id: source.id, index: 2, kind: "prose", heading: null, text: "A chart review in patients aged 65+ is underway." },
      ],
    });
    await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Chart review in patients aged 65+",
      source_file_id: source.id,
      metadata: { provenance: [{ source_file_id: source.id, block_id: id("B3"), quote: "chart review" }] },
    });

    const script: Record<string, Verdict> = {
      [id("B1")]: { missed: true, claim_type: "gap", rationale: "Pneumonitis monitoring need is not in the ledger." },
      [id("B2")]: { missed: false, claim_type: null, rationale: "Chapter divider, not a gap." },
    };
    const complete = scriptedCritic(script);
    const ctx = fakeCtx(complete);
    ctx.workspace_id = workspace_id;

    const first = await completenessAuditModule.run({ workspace_id }, ctx);
    expect(first.output.mode).toBe("llm");
    expect(first.output.cited_blocks).toBe(1);
    expect(first.output.judged_blocks).toBe(2);
    expect(first.output.flags).toHaveLength(1);
    expect(first.output.flags[0]).toMatchObject({
      block_id: id("B1"),
      suggested: "gap",
      reason: "Pneumonitis monitoring need is not in the ledger.",
    });
    expect(first.output.skipped_noise).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);

    // Same text, same ledger: nothing is asked again.
    const second = await completenessAuditModule.run({ workspace_id }, ctx);
    expect(second.output.reused_verdicts).toBe(2);
    expect(second.output.judged_blocks).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);

    // A new claim may cover the open miss: only the miss is re-asked.
    await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Real-world pneumonitis monitoring in community settings",
      source_file_id: source.id,
    });
    script[id("B1")] = { missed: false, claim_type: null, rationale: "Now captured by the new gap claim." };
    const third = await completenessAuditModule.run({ workspace_id }, ctx);
    expect(third.output.judged_blocks).toBe(1);
    expect(third.output.reused_verdicts).toBe(1);
    expect(third.output.flags).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0].user).toContain("Real-world pneumonitis monitoring in community settings");
  });
});
