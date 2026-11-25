import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({ scope: "demo", enabled: true }));
vi.mock("@/modules/workspaces/context", () => ({ scopedWorkspaceId: async () => state.scope }));
vi.mock("@/modules/workspaces/store", () => ({
  getWorkspace: async (id: string) => ({ id, demo_mode: id === "demo" && state.enabled }),
}));
vi.mock("@/modules/llm/api-keys", async importOriginal => ({
  ...await importOriginal<typeof import("@/modules/llm/api-keys")>(),
  providerConfigured: () => true,
}));

import { demoExecutionFor, isDemoModeWorkspace } from "@/lib/demo/mode";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { parseWithLlm } from "@/lib/ingest/llm-structure";
import { completionFor, resolveRoute, type RouteConfig } from "@/modules/kernel/routing";
import type { ModuleContext, RunHandle } from "@/modules/kernel/contracts";
import * as database from "@/modules/kernel/db";
import { tracedCompletion } from "@/modules/kernel/llm-calls";
import { RunRecorder } from "@/modules/kernel/observability";
import { DemoRecordingWriteError, TrustedApplicationError } from "@/modules/kernel/stage-errors";
import type { LlmProvider } from "@/modules/llm/provider";
import * as upload from "@/modules/stages/s0-upload/module";
import { parseModule } from "@/modules/stages/s1-parse/module";

const config: RouteConfig = {
  stage: "S8", provider_id: "xai-grok", model: "grok-4", params: { temperature: 0, max_tokens: 16000 },
  fallbacks: [], updated_by: "fixture", updated_at: "2026-11-25T00:00:00.000Z",
};

afterEach(() => {
  state.scope = "demo";
  state.enabled = true;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("KAN-263 explicit customer demo routing", () => {
  it("resolves ordinary callers to live routing even when the scoped workspace enabled the demo", async () => {
    expect(await resolveRoute("S8", config)).toMatchObject({ provider_id: "xai-grok" });
    expect(await resolveRoute("S8", config, demoExecutionFor({ id: "demo", demo_mode: true }))).toMatchObject({
      provider_id: "demo-replay", auth: "none", model: "recorded", fallbacks: [],
      demo: { fixture: "velmara-client-demo", workspace_id: "demo", mode: "replay" },
    });
  });

  it("requires agreement with both current workspace scope and the saved switch", async () => {
    const demo = demoExecutionFor({ id: "demo", demo_mode: true })!;
    state.scope = "customer";
    await expect(resolveRoute("S8", config, demo)).rejects.toMatchObject({ code: "demo_replay_miss" });
    await expect(resolveRoute("S8", config, { ...demo, workspace_id: "customer" })).rejects.toMatchObject({ code: "demo_replay_miss" });
    state.scope = "demo";
    state.enabled = false;
    await expect(resolveRoute("S8", config, demo)).rejects.toMatchObject({ code: "demo_replay_miss" });
  });

  it("observes cross-worker updates without retaining a stale workspace demo flag", async () => {
    state.enabled = false;
    expect(await isDemoModeWorkspace()).toBe(false);
    state.enabled = true;
    expect(await isDemoModeWorkspace()).toBe(true);
    state.enabled = false;
    expect(await isDemoModeWorkspace()).toBe(false);
  });

  it("uses an explicit live recording route only in a non-production recording run", async () => {
    vi.stubEnv("SYNAPSE_DEMO_RECORD", "1");
    const workspace = { id: "demo", demo_mode: true };
    expect(() => demoExecutionFor(workspace)).toThrow(/recording ID/);
    const recording_id = "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2";
    vi.stubEnv("SYNAPSE_DEMO_RECORDING_ID", recording_id);
    const execution = demoExecutionFor(workspace);
    expect(await resolveRoute("S8", config, execution)).toMatchObject({
      provider_id: "xai-grok", demo: { mode: "record", recording_id },
    });
    vi.stubEnv("SYNAPSE_DEMO_RECORDING_ID", "3d0b1f0f-e816-4f34-8ec4-6f4b73f4a5d1");
    await expect(resolveRoute("S8", config, execution)).rejects.toMatchObject({ code: "demo_replay_miss" });
    vi.stubEnv("NODE_ENV", "production");
    expect(await resolveRoute("S8", config, demoExecutionFor(workspace))).toMatchObject({ provider_id: "demo-replay" });
  });

  it("refuses a substitute completion executor on a demo replay route", async () => {
    const route = await resolveRoute("S8", config, demoExecutionFor({ id: "demo", demo_mode: true }));
    const completeRaw = vi.fn().mockResolvedValue("{}");
    const complete = completionFor(route, { workspace_id: "demo" } as RunHandle, { completeRaw });
    await expect(complete({ system: "fictional system", user: "fictional input", purpose: "priority-suggester" }))
      .rejects.toMatchObject({ code: "demo_replay_miss" });
    expect(completeRaw).not.toHaveBeenCalled();
  });

  it("fails a verified recording when the call insert fails and preserves live best effort", async () => {
    const recordingId = "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2";
    vi.stubEnv("SYNAPSE_DEMO_RECORD", "1");
    vi.stubEnv("SYNAPSE_DEMO_RECORDING_ID", recordingId);
    const route = await resolveRoute("S8", config, demoExecutionFor({ id: "demo", demo_mode: true }));
    const run = () => new RunRecorder({
      workspace_id: "demo", stage: "S8", module_id: "scripted", module_version: "1",
      actor: { name: "Presenter", function: "medical_affairs" }, input: {},
    });
    const text = '{"result":"fictional"}';
    const provider: LlmProvider = {
      id: route.provider_id, label: "Scripted provider", summary: "", auth: "api_key",
      models: [route.model], default_model: route.model, complete: vi.fn().mockResolvedValue(text),
    };
    const writeError = new Error("Simulated llm_calls insert failure");
    const insert = vi.fn<(params: unknown[]) => Promise<unknown[]>>()
      .mockRejectedValueOnce(writeError).mockRejectedValueOnce(writeError).mockResolvedValueOnce([]).mockRejectedValueOnce(writeError);
    const dialect = new PgDialect();
    const execute = async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      return query.sql.startsWith("insert into llm_calls") ? insert(query.params) : [];
    };
    vi.spyOn(database, "sharedDb").mockReturnValue({ execute } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const call = (recorder: RunRecorder, demo: typeof route.demo) => tracedCompletion({
      demo, provider, run: recorder, api_key: "fictional-key", detail: "scripted",
      request: { system: "Use the source.", user: "Fictional evidence.", model: route.model, temperature: 0, max_tokens: 100 },
      step: "llm:priority-suggester", purpose: "priority-suggester", attempt: 1, stage: "S8", workspace_id: recorder.workspace_id,
    });

    const failed = run();
    await expect(call(failed, route.demo)).rejects.toMatchObject({
      name: "DemoRecordingWriteError", code: "demo_recording_write_failed", status: 503,
      message: expect.stringContaining("fresh recording ID"),
    });
    expect(failed.steps()).toEqual([
      expect.objectContaining({ name: "llm_call:unrecorded" }),
      expect.objectContaining({ name: "llm:priority-suggester", data: { error: expect.stringContaining("could not save") } }),
    ]);
    expect(provider.complete).toHaveBeenCalledTimes(1);

    const ordinary = await resolveRoute("S8", config);
    await expect(call(run(), ordinary.demo)).resolves.toMatchObject({ text, llm_call_id: null });
    await expect(call(run(), route.demo)).resolves.toMatchObject({ text, llm_call_id: expect.stringMatching(/^llm_/) });
    expect(insert.mock.calls.map(([params]) => params.slice(-2))).toEqual([
      ["velmara-client-demo", recordingId], [null, null], ["velmara-client-demo", recordingId],
    ]);

    const providerError = new Error("Scripted provider refusal");
    vi.mocked(provider.complete).mockRejectedValueOnce(providerError);
    await expect(call(run(), route.demo)).rejects.toBe(providerError);
  });

  it("propagates a recording write failure through S1 rather than completing with a file failure", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    vi.stubEnv("SYNAPSE_DEMO_RECORD", "1");
    vi.stubEnv("SYNAPSE_DEMO_RECORDING_ID", "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2");
    const route = await resolveRoute("S1", { ...config, stage: "S1" }, demoExecutionFor({ id: "demo", demo_mode: true }));
    const buffer = Buffer.from("The fictional evidence report describes a cost estimate.");
    vi.spyOn(upload, "sourceFileContent").mockResolvedValue({
      buffer, record: {
        id: "sample", filename: "sample.txt", title: "Fictional evidence", source_type: "document",
        stakeholder_function: "medical_affairs", mime: "text/plain", bytes: buffer.length,
        checksum: "sample", status: "uploaded", uploaded_by: "Presenter", uploaded_at: "2026-11-25T00:00:00Z",
        parsed_at: null, source_id: null, note: null,
      },
    });
    const markFailed = vi.spyOn(upload, "markFileFailed").mockResolvedValue(undefined);
    const failure = new DemoRecordingWriteError();
    const complete = vi.fn<ModuleContext["complete"]>().mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new TrustedApplicationError("This source could not be parsed."));
    const actor = { name: "Presenter", function: "medical_affairs" as const };
    const ctx: ModuleContext = {
      route, workspace_id: "demo", actor, role: "medical_affairs", ai: true, complete,
      run: new RunRecorder({ workspace_id: "demo", stage: "S1", module_id: "scripted", module_version: "1", actor, input: {} }),
    };
    const input = { file_ids: ["sample"], dry_run: false };
    await expect(parseModule.run(input, ctx)).rejects.toBe(failure);
    expect(markFailed).not.toHaveBeenCalled();
    const ordinary = { ...ctx, route: await resolveRoute("S1", { ...config, stage: "S1" }) };
    await expect(parseModule.run(input, ordinary)).resolves.toMatchObject({
      output: { failures: [{ file_id: "sample", reason: "This source could not be parsed." }] },
    });
  });

  it("replays an approved parse when saving its replay trace fails", async () => {
    vi.stubEnv("SYNAPSE_DEMO_RECORD", "0");
    vi.stubEnv("SYNAPSE_DEMO_REPLAY_DELAY_MS", "0");
    const route = await resolveRoute("S1", { ...config, stage: "S1" }, demoExecutionFor({ id: "demo", demo_mode: true }));
    const dialect = new PgDialect();
    const execute = async (statement: SQL) => {
      if (dialect.sqlToQuery(statement).sql.startsWith("insert into llm_calls")) throw new Error("Simulated replay trace failure");
      return [];
    };
    vi.spyOn(database, "sharedDb").mockReturnValue({ execute } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = new RunRecorder({
      workspace_id: "demo", stage: "S1", module_id: "scripted", module_version: "1",
      actor: { name: "Presenter", function: "medical_affairs" }, input: {},
    });
    const file = CLIENT_DEMO_PACK[0]!;
    const result = await parseWithLlm({
      filename: file.filename, buffer: Buffer.from(file.text), mime: "text/plain", ask: completionFor(route, run),
    });
    expect(result.document.blocks).toHaveLength(56);
    expect(run.steps()).toContainEqual(expect.objectContaining({ name: "llm_call:unrecorded" }));
  });
});
