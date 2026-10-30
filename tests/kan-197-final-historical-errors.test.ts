/** Historical exception storage is private; run readers expose safe failure projections. */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { RunRecorder, openRun, closeRun, getRun, listRuns } from "@/modules/kernel/observability";
import { recordLlmCall, listLlmCalls } from "@/modules/kernel/llm-calls";
import { db, sharedDb } from "@/modules/kernel/db";
import * as schema from "@/modules/kernel/schema";
import { GET as runApi } from "@/app/api/runs/[id]/route";
import { AccuracyRunRecorder, openAccuracyRun, closeAccuracyRun, listAccuracyRuns } from "@/accuracy/kernel/observability";
import { accuracyDb } from "@/accuracy/store/db";
import * as accuracySchema from "@/accuracy/store/schema";
import { GET as accuracyApi } from "@/app/api/accuracy/runs/route";
import { HISTORICAL_FAILURE_MESSAGE, projectFailureDiagnostics, projectRunSteps } from "@/modules/kernel/failure-presentation";
const secret = "SELECT password FROM private_accounts provider response token=opaque-sample-secret";
const actor = { name: "Failure fixture", function: "medical_affairs" as const };
describe("safe historical run reads", () => {
  it("projects historical run/step/call failures for both owner API and internal readers while retaining successful science", async () => {
    const recorder = new RunRecorder({ workspace_id: "default", stage: "S2", module_id: "kan197.historical", module_version: "1", actor, input: {} });
    await openRun(recorder);
    await closeRun({ recorder, status: "error", summary: secret, error: secret, output: { scores: [0.4], nested: { error: secret } }, evals: [{ name: "coverage", value: 0.7 }] });
    const callId = await recordLlmCall({ workspace_id: "default", run_id: recorder.id, stage: "S2", step: "llm:extract", purpose: "extract", attempt: 1, provider_id: "fixture", model: "fixture", params: { temperature: 0, max_tokens: 100 }, system_prompt: "Scientific instruction", user_prompt: "Source text", reply: secret, status: "error", error: secret, usage: null, latency_ms: 5 });
    // Insert legacy values directly, bypassing current write-time redaction.
    await db().update(schema.moduleRuns).set({ steps: [{ name: "llm:extract", at: "2026-01-01", duration_ms: 5, detail: secret, data: { error: secret, llm_call_id: callId, response: secret } }, { name: "science", at: "2026-01-01", duration_ms: 1, detail: "Useful scientific result", data: { statement: "Evidence gap", scores: [0.8], errors: 2 } }] }).where(eq(schema.moduleRuns.id, recorder.id));
    await sharedDb().execute(sql`update llm_calls set error=${secret}, reply=${secret} where id=${callId}`);
    try {
      const response = await runApi(new Request("http://localhost/api/runs/" + recorder.id), { params: Promise.resolve({ id: recorder.id }) });
      const body = await response.json();
      expect(response.status).toBe(200); expect(JSON.stringify(body)).not.toContain(secret); expect(JSON.stringify(body)).not.toContain("opaque-sample-secret");
      expect(body.run.error).toMatch(/could not finish.*review/i); expect(body.run.summary).toBe(body.run.error);
      expect(body.run.steps[0].detail).toBeNull(); expect(body.run.steps[0].data).toEqual({ error: body.run.error, llm_call_id: callId });
      expect(body.run.steps[1].data).toEqual({ statement: "Evidence gap", scores: [0.8], errors: 2 }); expect(body.run.evals).toEqual([{ name: "coverage", value: 0.7 }]); expect(body.run.output.scores).toEqual([0.4]);
      expect(body.llm_calls[0]).toMatchObject({ error: expect.stringMatching(/could not finish/i), reply: null, system_prompt: "Scientific instruction", user_prompt: "Source text" });
      expect(JSON.stringify(await getRun(recorder.id))).not.toContain(secret); expect(JSON.stringify(await listRuns({ stage: "S2" }))).not.toContain(secret); expect(JSON.stringify(await listLlmCalls(recorder.id))).not.toContain(secret);
      const [stored] = await db().select().from(schema.moduleRuns).where(eq(schema.moduleRuns.id, recorder.id)); expect(stored.error).toBe(secret); expect(stored.steps).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ error: secret }) })]));
    } finally { await sharedDb().execute(sql`delete from llm_calls where id=${callId}`); await db().delete(schema.moduleRuns).where(eq(schema.moduleRuns.id, recorder.id)); }
  });
  it("projects Accuracy errors, failed-step detail and nested errors without altering records or evaluations", async () => {
    const recorder = new AccuracyRunRecorder({ org_id: "fixture", workspace_id: "kan197-" + crypto.randomUUID(), call_kind: "need_extract", agent_role: "none", module_id: "kan197.historical", module_version: "1", actor, input: {} });
    await openAccuracyRun(recorder); await closeAccuracyRun({ recorder, status: "error", error: secret, summary: secret, output: { claim: "Evidence gap" } });
    await accuracyDb().update(accuracySchema.accuracyModuleRuns).set({ steps: [{ name: "llm:extract", detail: secret, data: { error: secret, response: secret } }, { name: "science", data: { score: 0.6 } }], evals: [{ name: "coverage", value: 0.8 }] }).where(eq(accuracySchema.accuracyModuleRuns.id, recorder.id));
    try {
      const response = await accuracyApi(new Request("http://localhost/api/accuracy/runs?workspace_id=" + recorder.workspace_id)); const body = await response.json();
      expect(response.status).toBe(200); expect(JSON.stringify(body)).not.toContain(secret); expect(body.runs[0].error).toMatch(/could not finish.*review/i); expect(body.runs[0].steps[0].detail).toBeNull(); expect(body.runs[0].steps[0].data).toEqual({ error: body.runs[0].error }); expect(body.runs[0].steps[1].data).toEqual({ score: 0.6 }); expect(body.runs[0].evals).toEqual([{ name: "coverage", value: 0.8 }]);
      expect(JSON.stringify(await listAccuracyRuns(recorder.workspace_id))).not.toContain(secret);
      const [stored] = await accuracyDb().select().from(accuracySchema.accuracyModuleRuns).where(eq(accuracySchema.accuracyModuleRuns.id, recorder.id)); expect(stored.error).toBe(secret);
    } finally { await accuracyDb().delete(accuracySchema.accuracyModuleRuns).where(eq(accuracySchema.accuracyModuleRuns.id, recorder.id)); }
  });
});

// Pure boundary cases complement the API fixtures without changing persisted history.
describe("failure presentation boundary", () => {
  it("keeps scalar scientific errors and projects nested exception objects without mutating input", () => {
    const input = { scores: [0.1, 0.9], error: 0.2, valid: { error: false }, nested: [{ error: secret, response: secret, llm_call_id: "llm_fixture" }] };
    expect(projectFailureDiagnostics(input)).toEqual({ scores: [0.1, 0.9], error: 0.2, valid: { error: false }, nested: [{ error: HISTORICAL_FAILURE_MESSAGE, llm_call_id: "llm_fixture" }] });
    expect(input.nested[0].error).toBe(secret);
    expect(projectFailureDiagnostics(null)).toBeNull();
    expect(projectFailureDiagnostics("Scientific source text")).toBe("Scientific source text");
    expect(projectFailureDiagnostics({ status: "error", error: null, response: secret, llm_call_id: secret })).toEqual({ error: HISTORICAL_FAILURE_MESSAGE });
  });
  it("suppresses legacy failed Accuracy detail without hiding successful step content", () => {
    const steps = [{ detail: secret, data: null }, { detail: secret, data: { llm_call_id: "llm_fixture" } }, { detail: "Scientific explanation", data: { score: 0.7 } }];
    expect(projectRunSteps(steps, true)).toEqual([{ detail: null, data: { error: HISTORICAL_FAILURE_MESSAGE } }, { detail: null, data: { error: HISTORICAL_FAILURE_MESSAGE, llm_call_id: "llm_fixture" } }, steps[2]]);
    expect(steps[0].detail).toBe(secret);
    expect(projectRunSteps([{ detail: "Useful note", data: null }])).toEqual([{ detail: "Useful note", data: null }]);
  });
});
