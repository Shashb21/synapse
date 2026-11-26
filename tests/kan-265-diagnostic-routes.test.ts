import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildSeed } from "@/lib/iegp/seed";
import * as parser from "@/modules/stages/s1-parse/module";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";
import { tacticExtractModule } from "@/modules/stages/s3-tactic-extract/module";
import { POST as harness } from "@/app/api/modules/evals/route";
import { POST as adminHarness } from "@/app/api/admin/modules/evals/route";
import { POST as adminSweep } from "@/app/api/admin/modules/hillclimb/route";
import * as admin from "@/modules/workspaces/admin-context";
import { POST as sweep } from "@/app/api/modules/hillclimb/route";
import * as owner from "@/modules/auth/owner";
import * as auth from "@/modules/auth/request";
import * as switches from "@/modules/kernel/ai-switch";
import * as data from "@/modules/kernel/db";
import * as registry from "@/modules/kernel/registry";
import * as revisions from "@/modules/kernel/prompt-revisions";
import * as traces from "@/modules/kernel/observability";
import * as signals from "@/modules/kernel/hillclimb";
import { activePromptVersion } from "@/modules/kernel/prompt-variant";
import * as observations from "@/modules/kernel/baselines";
import * as routes from "@/modules/kernel/approved-evaluation-route";
import * as routing from "@/modules/kernel/routing";
import * as llm from "@/modules/kernel/llm";
import * as workspace from "@/modules/workspaces/store";
import { runInWorkspace } from "@/modules/workspaces/context";
import { availableDiagnosticSweeps } from "@/modules/kernel/hillclimb-loop";
import { inEvaluationIsolation } from "@/modules/kernel/evaluation-isolation";
import { saveReplaySnapshot } from "@/modules/kernel/decision-replay";
import { similarExamples } from "@/modules/kernel/decision-examples";
import type { JsonCompletion, SynapseModule } from "@/modules/kernel/contracts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function request(stage: string, workspace_id = "fiction") {
  return new Request("http://localhost/api/modules/evals", {
    method: "POST",
    body: JSON.stringify({ stage, workspace_id }),
    headers: { "Content-Type": "application/json" },
  });
}
const inScope = <T>(fn: () => Promise<T>) => runInWorkspace({ workspace_id: "fiction", schema: "public" }, fn);
function setup() {
  vi.spyOn(owner, "ownerGate").mockResolvedValue(null);
  vi.spyOn(auth, "requestIdentity").mockResolvedValue({
    role: "medical_affairs",
    actor: { name: "Owner", function: "medical_affairs" },
    demo: false,
    signed_in: true,
  });
  vi.spyOn(switches, "aiEnabled").mockResolvedValue(true);
  vi.spyOn(switches, "aiSectionEnabled").mockResolvedValue(true);
  vi.spyOn(workspace, "getWorkspace").mockResolvedValue({
    id: "fiction",
    schema_name: "public",
    demo_mode: false,
  } as workspace.Workspace);
  vi.spyOn(data, "ensurePlatformSchema").mockResolvedValue();
  const insert = vi.fn(() => ({ values: vi.fn().mockResolvedValue([]) }));
  vi.spyOn(data, "sharedDb").mockReturnValue({ insert } as unknown as ReturnType<typeof data.sharedDb>);
  vi.spyOn(revisions, "activeRevisionPointer").mockResolvedValue({ revision_id: null, generation: 0 });
  const provider = vi.fn<JsonCompletion>().mockResolvedValue({});
  let receipt = 0;
  vi.spyOn(routing, "completionFor").mockImplementation((_route, _run, options) => async (call) => {
    const reply = await provider(call);
    options?.onReceipt?.({ attempt: 1, id: `scripted-receipt-${++receipt}` });
    return reply;
  });
  const open = vi.spyOn(traces, "openRun").mockResolvedValue();
  const close = vi.spyOn(traces, "closeRun").mockResolvedValue();
  const signal = vi.spyOn(signals, "recordSignal");
  const freeze = vi.fn(async () => ({ fixture: "immutable" }));
  const implementation: SynapseModule<unknown, unknown> = {
    manifest: {
      id: "fictional",
      version: "1",
      stage: "S8",
      title: "Fixture",
      summary: "Fixture",
      agentic: true,
      contract: 1,
      capabilities: [],
    },
    inputSchema: z.object({ dry_run: z.literal(true), persist: z.literal(false) }),
    outputSchema: z.object({}),
    freeze,
    evals: {
      cases: vi.fn(async () => [{ name: "fixture", input: {} }]),
      score: () => [{ name: "format", value: 1, target: 1 }],
    },
    run: vi.fn(async (input, ctx) => {
      expect(inEvaluationIsolation()).toBe(true);
      expect(ctx.replay).toMatchObject({ evaluation: true, facts: { fixture: "immutable" } });
      expect(input).toEqual({ dry_run: true, persist: false });
      expect(
        await similarExamples({ stage: "S8", workspace_id: "fiction", kinds: ["s8_band"], text: "fiction" }),
      ).toEqual([]);
      await saveReplaySnapshot(ctx, "S8", []);
      return {
        output: {},
        summary: "Diagnostic",
        signals: [{ stage: "S8" as const, subject: "x", kind: "eval_regression" as const, rationale: "Fixture" }],
      };
    }),
  };
  vi.spyOn(registry, "activeModule").mockResolvedValue(implementation);
  return { implementation, provider, open, close, signal, freeze };
}
describe("owner diagnostics", () => {
  it("keeps both owner gates ahead of body processing and stage execution", async () => {
    const { NextResponse } = await import("next/server");
    vi.spyOn(owner, "ownerGate").mockResolvedValue(NextResponse.json({}, { status: 403 }));
    const active = vi.spyOn(registry, "activeModule");
    for (const route of [harness, sweep]) expect((await route(request("S8"))).status).toBe(403);
    expect(active).not.toHaveBeenCalled();
  });
  it("binds both outer diagnostic handlers to the owner selection before the body can choose a workspace", async () => {
    const { implementation, provider } = setup();
    const selected = vi.spyOn(admin, "withAdminWorkspace").mockImplementation(async (fn, override) => {
      expect(override).toBeNull();
      return inScope(() =>
        fn({ id: "fiction", name: "Fixture A", schema_name: "public", demo: false, source: "picked" }),
      );
    });
    const active = vi.mocked(registry.activeModule);
    vi.mocked(workspace.getWorkspace).mockImplementation(
      async (id) => ({ id, schema_name: "public", demo_mode: false }) as workspace.Workspace,
    );
    for (const handler of [adminHarness, adminSweep]) {
      for (const id of ["existing-workspace-b", "unknown-id", 123, null]) {
        const response = await handler(
          new Request("http://localhost", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: "S8", workspace_id: id }),
          }),
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ safe_error: true });
      }
    }
    expect(active).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(vi.mocked(data.sharedDb)().insert).not.toHaveBeenCalled();
    for (const handler of [adminHarness, adminSweep]) {
      expect((await handler(request("S8"))).ok).toBe(true);
      expect(
        (
          await handler(
            new Request("http://localhost", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: '{"stage":"S8"}',
            }),
          )
        ).ok,
      ).toBe(true);
    }
    expect(implementation.run).toHaveBeenCalledTimes(2);
    const { NextResponse } = await import("next/server");
    vi.mocked(owner.ownerGate).mockResolvedValue(NextResponse.json({}, { status: 403 }));
    selected.mockClear();
    for (const handler of [adminHarness, adminSweep]) expect((await handler(request("S8"))).status).toBe(403);
    expect(selected).not.toHaveBeenCalled();
  });
  it("runs a synthetic diagnostic without learning, live writes, provider calls or a quality verdict", async () => {
    const { implementation, provider, open, close, signal, freeze } = setup();
    const response = await inScope(() => harness(request("S8")));
    expect(await response.json()).toMatchObject({ ok: true, cases: 1, passed: null, group_id: expect.any(String) });
    expect(implementation.run).toHaveBeenCalledOnce();
    expect(freeze).toHaveBeenCalledOnce();
    for (const spy of [open, close, provider, signal]) expect(spy).not.toHaveBeenCalled();
    const inserts = vi.mocked(data.sharedDb)().insert;
    expect(inserts).toHaveBeenCalledTimes(2);
    const records = vi.mocked(inserts).mock.results.map((call) => vi.mocked(call.value.values).mock.calls[0][0]);
    expect(records).toMatchObject([
      {
        kind: "harness_case",
        workspace_id: "fiction",
        passed: null,
        group_id: expect.any(String),
        lineage: { case_name: "fixture", execution: "synthetic" },
      },
      { kind: "harness_summary", workspace_id: "fiction", passed: null, lineage: { execution: "synthetic" } },
    ]);
    expect(records[0]).toHaveProperty("group_id", (records[1] as { group_id: string }).group_id);
  });
  it("rejects foreign workspaces, replay and fallback before execution", async () => {
    const { implementation, provider } = setup();
    expect((await inScope(() => harness(request("S8", "foreign")))).ok).toBe(false);
    vi.mocked(workspace.getWorkspace).mockResolvedValueOnce({
      id: "fiction",
      schema_name: "public",
      demo_mode: true,
    } as workspace.Workspace);
    expect((await inScope(() => harness(request("S8")))).ok).toBe(false);
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    const fallback = vi.spyOn(routes, "approvedEvaluationRoute").mockResolvedValue({
      stage: "S8",
      provider_id: "alternate",
      model: "fiction",
      provider_label: "Alternate",
      connected: true,
      auth: "api_key",
      degraded: true,
      reason: null,
      params: { temperature: 0, max_tokens: 10 },
      fallbacks: [],
    });
    expect((await inScope(() => harness(request("S8")))).ok).toBe(false);
    expect(fallback).toHaveBeenCalledOnce();
    expect(implementation.run).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it("skips identical prompts and cases without a gold target before routing", async () => {
    const { implementation, provider } = setup();
    implementation.manifest.stage = "S2";
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    const resolve = vi.spyOn(routes, "approvedEvaluationRoute");
    implementation.evals!.variantInstruction = () => "same";
    const identical = await inScope(() => sweep(request("S2")));
    expect(await identical.json()).toMatchObject({ ok: true, champion: null, variants: [] });
    expect(implementation.evals!.cases).not.toHaveBeenCalled();
    implementation.evals!.variantInstruction = (v) => v;
    const unscored = await inScope(() => sweep(request("S2")));
    expect(await unscored.json()).toMatchObject({ ok: true, champion: null, variants: [] });
    expect(implementation.run).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it("compares frozen curated cases on the actual routed prompts and withholds a result for an effective no-op", async () => {
    const { implementation, freeze, signal, provider } = setup();
    implementation.manifest.stage = "S2";
    const tests = vi.fn(async () => [
      { name: "fiction", input: {}, gold: { pack: "fiction", source_id: "fixture", must_match: ["fictional target"] } },
    ]);
    implementation.evals = {
      variantInstruction: (v) => v,
      cases: tests,
      score: ({ output }) => [{ name: "curated_must_match", target: 0.5, value: (output as { value: number }).value }],
    };

    implementation.outputSchema = z.object({ value: z.number() });
    implementation.run = async (_, ctx) => {
      expect(ctx.replay?.evaluation).toBe(true);
      await ctx.complete({
        system: "Fictional proposer",
        user: "Fictional case instruction " + activePromptVersion(),
        purpose: "fixture",
      });
      return { output: { value: activePromptVersion() === "v1.1-atomic" ? 1 : 0 }, summary: "Fictional observation" };
    };
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.spyOn(routes, "approvedEvaluationRoute").mockResolvedValue({
      stage: "S2",
      provider_id: "fixture",
      provider_label: "Fixture",
      model: "fixture-model",
      connected: true,
      degraded: false,
      auth: "api_key",
      params: { temperature: 0, max_tokens: 10 },
      fallbacks: [],
      reason: null,
    });
    const history = vi.spyOn(observations, "recordPromptBaseline").mockResolvedValue(null);
    const run = await inScope(() => sweep(request("S2")));
    expect(await run.json()).toMatchObject({ ok: true, champion: "v1.1-atomic" });
    expect(tests).toHaveBeenCalledOnce();
    expect(freeze).toHaveBeenCalledOnce();
    expect(new Set(history.mock.calls.map(([lineage]) => lineage.prompt_hash)).size).toBe(3);
    expect(new Set(history.mock.calls.map(([lineage]) => lineage.case_hash)).size).toBe(1);
    // Distinct first cases cannot spend anything if a later frozen case has an effective duplicate.
    tests.mockResolvedValue(
      ["first", "later"].map((name) => ({
        name,
        input: { name },
        gold: { pack: "fiction", source_id: name, must_match: ["target"] },
      })),
    );
    implementation.inputSchema = z.object({ name: z.string() });
    implementation.run = async (input, ctx) => {
      const name = (input as { name: string }).name;
      await ctx.complete({
        system: "Shared system",
        user: name === "later" ? "identical" : activePromptVersion(),
        purpose: "fixture",
      });
      return { output: { value: 1 }, summary: "Fixture" };
    };
    provider.mockClear();
    history.mockClear();
    const duplicate = await inScope(() => sweep(request("S2")));
    expect(await duplicate.json()).toMatchObject({ ok: true, champion: null, variants: [] });
    expect(provider).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();

    implementation.run = async (input, ctx) => {
      if ((input as { name: string }).name !== "later") {
        await ctx.complete({ system: "Shared", user: activePromptVersion(), purpose: "fixture" });
      }
      return { output: { value: 1 }, summary: "Fixture" };
    };
    const missing = await inScope(() => sweep(request("S2")));
    expect(await missing.json()).toMatchObject({ ok: true, champion: null, variants: [] });
    expect(provider).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();

    // Changing even the user-only instruction between preview and dispatch invalidates the first send.
    let requests = 0;
    implementation.run = async (_, ctx) => {
      await ctx.complete({ system: "Same system", user: `${activePromptVersion()}-${requests++}`, purpose: "fixture" });
      return { output: { value: 1 }, summary: "Fixture" };
    };
    expect((await inScope(() => sweep(request("S2")))).ok).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();

    implementation.run = async (_, ctx) => {
      await ctx.complete({ system: "Identical", user: "Identical", purpose: "fixture" });
      return { output: { value: 1 }, summary: "Fixture" };
    };

    provider.mockClear();
    const same = await inScope(() => sweep(request("S2")));
    expect(await same.json()).toMatchObject({ ok: true, champion: null });
    expect(provider).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });
  it.each([gapExtractModule, tacticExtractModule])(
    "checks the exact curated facts before previewing the registered $manifest.stage proposer",
    async (original) => {
      const { implementation: inactive, provider } = setup();
      const stage = original.manifest.stage;
      const seed = buildSeed();
      const source = seed.sources.find((row) => row.id === "SRC-INT-MED")!;
      const blocks = seed.blocks.filter((row) => row.source_id === source.id);
      const document = {
        id: "fiction-doc",
        file_id: "fiction-file",
        source_id: source.id,
        blocks,
      } as parser.ParsedDocumentRecord;
      const facts = { documents: [document], state: { gaps: [], tactics: [], sources: [source], needs: [] } };
      const freeze = vi.fn(async () => facts);
      vi.spyOn(parser, "listParsedDocuments").mockResolvedValue([document]);
      const implementation = { ...original, freeze };
      vi.mocked(registry.activeModule).mockImplementation(async (requested) =>
        requested === stage ? (implementation as unknown as SynapseModule<unknown, unknown>) : inactive,
      );
      vi.spyOn(llm, "isTestStub").mockReturnValue(false);
      const route = vi.spyOn(routes, "approvedEvaluationRoute").mockResolvedValue({
        stage,
        provider_id: "fiction",
        model: "fiction",
        provider_label: "Fixture",
        auth: "api_key",
        connected: true,
        degraded: false,
        params: { temperature: 0, max_tokens: 100 },
        fallbacks: [],
        reason: null,
      });
      const history = vi.spyOn(observations, "recordPromptBaseline").mockResolvedValue(null);
      provider.mockImplementation(async (call) => {
        if (call.purpose.endsWith("proposer:fiction-doc")) {
          const malformed = { name: "Fictional candidate", domain: "generated-term", type: "generated-term" };
          return { gaps: [malformed], tactics: [malformed] };
        }
        if (call.repairGuidance?.length) {
          expect(call.user).toContain("generated-term");
          expect(call.repairGuidance.join(" ")).toContain("source_quote is missing");
          expect(call.repairGuidance.join(" ")).toContain("<model value>");
          expect(call.repairGuidance.join(" ")).not.toContain("generated-term");
          const { candidates, rows } = JSON.parse(call.user);
          const withdrawn = (candidates ?? rows).map((row: { id: string }) => ({
            id: row.id,
            withdraw: true,
            reason: "Fictional withdrawal",
          }));
          return { gaps: withdrawn, tactics: withdrawn };
        }
        return { decisions: [], reviews: [], critiques: [] };
      });
      const response = await inScope(() => sweep(request(stage)));
      const body = await response.json();
      expect(response.ok, JSON.stringify(body)).toBe(true);
      expect(body.variants).toHaveLength(3);
      expect(body.variants[0]).toMatchObject({ passed: false, composite: 0 });
      expect(body.champion).toBeNull();
      expect(history).toHaveBeenCalledTimes(3);
      expect(provider.mock.calls.filter(([call]) => call.repairGuidance?.length)).toHaveLength(3);
      const sent = provider.mock.calls;
      const proposers = sent.filter(([r]) => r.purpose.endsWith("proposer:fiction-doc"));
      expect(proposers).toHaveLength(3);
      expect(new Set(proposers.map(([r]) => r.system)).size).toBe(3);
      expect(proposers.every(([r]) => r.user.includes("KOLs need to know intracranial outcomes"))).toBe(true);
      expect(await inScope(() => availableDiagnosticSweeps("fiction"))).toContain(stage);

      const editedBlock = { ...blocks[0], text: `${blocks[0].text} An additional owner review question.` };
      const edited = { ...facts, documents: [{ ...document, blocks: [editedBlock, ...blocks.slice(1)] }] };
      const replaced = { ...facts, state: { ...facts.state, sources: [{ ...source, ingested_at: "2026-10-01" }] } };
      const reordered = { ...facts, documents: [{ ...document, blocks: [...blocks].reverse() }] };
      for (const changed of [edited, replaced, reordered]) {
        freeze.mockResolvedValue(changed);
        provider.mockClear();
        route.mockClear();
        history.mockClear();
        expect(await inScope(() => availableDiagnosticSweeps("fiction"))).not.toContain(stage);
        const rejected = await inScope(() => sweep(request(stage)));
        expect(await rejected.json()).toMatchObject({ ok: true, variants: [], champion: null });
        for (const spy of [route, provider, history]) expect(spy).not.toHaveBeenCalled();
      }
      freeze.mockResolvedValue(edited);
      const diagnostic = await inScope(() => harness(request(stage)));
      const descriptive = await diagnostic.json();
      expect(descriptive).toMatchObject({ ok: true, cases: 1, passed: null, composite: null });
      expect(descriptive.metrics.find(({ name }: { name: string }) => name === "curated_must_match")).not.toHaveProperty("target");
      expect(provider.mock.calls.some(([call]) => call.user.includes("An additional owner review question"))).toBe(true);
    },
  );
  it.each(["changed_system_retry", "missing_receipt"] as const)(
    "withholds sweep ranking and baseline history if the last variant has %s",
    async (issue) => {
      const { implementation } = setup();
      vi.mocked(routing.completionFor).mockRestore();
      vi.stubEnv("OPENAI_API_KEY", "scripted-test-key");
      vi.spyOn(llm, "isTestStub").mockReturnValue(false);
      vi.spyOn(routes, "approvedEvaluationRoute").mockResolvedValue({
        stage: "S2", provider_id: "openai", provider_label: "Fixture", model: "gpt-4.1",
        auth: "api_key", connected: true, degraded: false, reason: null,
        params: { temperature: 0, max_tokens: 20 }, fallbacks: [],
      });
      const history = vi.spyOn(observations, "recordPromptBaseline").mockResolvedValue(null);
      implementation.manifest.stage = "S2";
      implementation.outputSchema = z.object({ value: z.number() });
      implementation.evals = {
        variantInstruction: (variant) => variant,
        cases: async () => [{ name: "fixture", input: {}, gold: { pack: "fixture", source_id: "fixture", must_match: ["target"] } }],
        score: ({ output }) => [
          { name: "curated_must_match", target: 0.5, value: (output as { value: number }).value },
          { name: "observations", value: 1 },
        ],
      };
      implementation.run = async (_input, ctx) => ({
        output: await ctx.complete({ system: activePromptVersion(), user: "Fixture input", purpose: "test-proposer" }),
        summary: "Diagnostic",
      });
      const systems: string[] = [];
      const affected = "v1.2-hillclimb-hints";
      const transport = vi.fn(async (_url, request: RequestInit) => {
        const { messages } = JSON.parse(request.body as string) as { messages: { role: string; content: string }[] };
        const system = messages.find((message) => message.role === "system")!.content;
        systems.push(system);
        const content = issue === "changed_system_retry" && system === affected ? "Invalid JSON" : JSON.stringify({ value: Number(system.startsWith(affected)) });
        return Response.json({ choices: [{ message: { content } }] });
      });
      vi.stubGlobal("fetch", transport);
      const dialect = new PgDialect();
      const execute = vi.fn(async (query: SQL) => {
        const { sql, params } = dialect.sqlToQuery(query);
        if (issue === "missing_receipt" && sql.includes("insert into llm_calls") && params.includes(affected))
          throw new Error("Scripted receipt write failure");
        return [];
      });
      const dataStore = vi.mocked(data.sharedDb)();
      vi.mocked(data.sharedDb).mockReturnValue({ ...dataStore, execute } as unknown as ReturnType<typeof data.sharedDb>);
      const unrecorded = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await inScope(() => sweep(request("S2")));
      const body = await response.json();
      expect(response.ok, JSON.stringify(body)).toBe(true);
      expect(body).toMatchObject({ champion: null, reason: expect.stringMatching(/request evidence/) });
      expect(body.variants.slice(0, 2).map(({ composite }: { composite: unknown }) => composite)).toEqual([0, 0]);
      expect(body.variants[2]).toMatchObject({
        prompt_version: affected, composite: null, passed: null, prompt_hash: null,
        metrics: [{ name: "observations", value: 1 }],
      });
      expect(history).not.toHaveBeenCalled();
      expect(systems.slice(0, 3)).toEqual(["v1.0-baseline", "v1.1-atomic", affected]);
      if (issue === "changed_system_retry") {
        expect(systems[3]).toContain("previous reply was not valid JSON");
        expect(transport).toHaveBeenCalledTimes(4);
        expect(unrecorded).not.toHaveBeenCalled();
      } else {
        expect(transport).toHaveBeenCalledTimes(3);
        expect(unrecorded).toHaveBeenCalledOnce();
      }
      const inserts = vi.mocked(dataStore.insert);
      const records = inserts.mock.results.map(({ value }) => vi.mocked(value.values).mock.calls[0][0]);
      expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "sweep_case", passed: null, lineage: expect.objectContaining({ evidence_issue: issue, transcript_hash: null }),
      })]));
    },
  );
  it("treats parser thresholds on a same-name replacement file as descriptive", async () => {
    const { implementation } = setup();
    implementation.manifest.stage = "S1";
    implementation.evals = {
      cases: async () => [
        { name: "fictional.txt", input: {}, gold: { pack: "demo", source_id: "fictional.txt", parse_min_blocks: 1 } },
      ],
      score: () => [{ name: "curated_parse_quality", value: 1, target: 1 }],
    };
    implementation.freeze = async () => ({ name: "fictional.txt", text: "Replacement bytes" });
    implementation.run = async (_, ctx) => {
      await ctx.complete({ system: "Parse", user: String(ctx.replay?.facts.text), purpose: "fixture" });
      return { output: {}, summary: "Fixture" };
    };
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.spyOn(routes, "approvedEvaluationRoute").mockResolvedValue({
      stage: "S1",
      provider_id: "fixture",
      model: "fixture",
      provider_label: "Fixture",
      connected: true,
      degraded: false,
      auth: "api_key",
      params: { temperature: 0, max_tokens: 10 },
      fallbacks: [],
      reason: null,
    });
    const result = await inScope(() => harness(request("S1")));
    expect(await result.json()).toMatchObject({
      ok: true,
      passed: null,
      composite: null,
      metrics: [{ name: "curated_parse_quality", value: 1 }],
    });
  });
});
