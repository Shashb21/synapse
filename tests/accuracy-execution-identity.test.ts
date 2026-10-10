import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccuracyRunRecorder } from "@/accuracy/kernel/observability";
import { accuracyCompletionFor } from "@/accuracy/kernel/routing";
import type { ResolvedAccuracyRoute } from "@/accuracy/kernel/contracts";
import { captureExecutionIdentity, executionCompatibility, executionEvidenceFromSteps } from "@/accuracy/kernel/execution-identity";

const route: ResolvedAccuracyRoute = { call_kind: "need_extract", role: "proposer", provider_id: "xai-grok",
  provider_label: "xAI", model: "configured-model", auth: "api_key", connected: true,
  params: { temperature: 0, max_tokens: 200 }, fallbacks: [], degraded: false, reason: null };
function recorder() { return new AccuracyRunRecorder({ org_id: "org", workspace_id: "workspace", call_kind: "need_extract",
  agent_role: "proposer", module_id: "extract", module_version: "v1", evaluation_context: "experiment",
  actor: { name: "test", function: "medical_affairs" }, input: {} }); }
const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("actual completion execution identity", () => {
  it("keeps identity unavailable when Next substitutes false for an absent deployment ID", () => {
    const root = mkdtempSync(join(tmpdir(), "kan4-deployment-")); directories.push(root);
    // Node coerces process.env assignments to strings; substitute the process instead to reproduce Next's boolean.
    vi.stubGlobal("process", { ...process, env: { ...process.env, NEXT_DEPLOYMENT_ID: false } });
    expect(captureExecutionIdentity(root)).toEqual({ schema_version: "execution-identity-v1", status: "unavailable",
      git_commit: null, worktree: "unknown", source_fingerprint: null, prompt_sources_fingerprint: null,
      build_id: null, deployment_id: null });
  });
  it.each([
    { label: "missing", value: undefined, expected: null },
    { label: "null", value: null, expected: null },
    { label: "boolean true", value: true, expected: null },
    { label: "number", value: 42, expected: null },
    { label: "object", value: {}, expected: null },
    { label: "empty string", value: "", expected: null },
    { label: "blank string", value: " \t\n", expected: null },
    { label: "deployment string", value: "deployment-42", expected: "deployment-42" },
    { label: "padded deployment string", value: " \tdeployment-42\n", expected: "deployment-42" },
    { label: "literal false string", value: "false", expected: "false" },
  ])("captures $label deployment identity without inventing authority", ({ value, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "kan4-deployment-")); directories.push(root);
    vi.stubGlobal("process", { ...process, env: { ...process.env, NEXT_DEPLOYMENT_ID: value } });
    expect(captureExecutionIdentity(root)).toEqual({ schema_version: "execution-identity-v1",
      status: expected === null ? "unavailable" : "available", git_commit: null, worktree: "unknown",
      source_fingerprint: null, prompt_sources_fingerprint: null, build_id: null, deployment_id: expected });
  });
  it("preserves source, prompt and build identity and compatibility when the deployment ID is false", () => {
    const root = mkdtempSync(join(tmpdir(), "kan4-deployment-")); directories.push(root);
    vi.stubEnv("NEXT_DEPLOYMENT_ID", undefined);
    vi.stubEnv("E2E_NEXT_DIST_DIR", undefined);
    mkdirSync(join(root, "src/accuracy/modules/test"), { recursive: true });
    writeFileSync(join(root, "src/accuracy/modules/test/prompts.ts"), "export const SYSTEM = 'A';");
    mkdirSync(join(root, ".next")); writeFileSync(join(root, ".next/BUILD_ID"), "deployed-build-42\n");
    const initial = captureExecutionIdentity(root);
    expect(initial).toMatchObject({ status: "available", source_fingerprint: expect.any(String),
      prompt_sources_fingerprint: expect.any(String), build_id: "deployed-build-42", deployment_id: null });
    vi.stubGlobal("process", { ...process, env: { ...process.env, NEXT_DEPLOYMENT_ID: false } });
    const substituted = captureExecutionIdentity(root);
    expect(substituted).toEqual(initial);
    expect(executionCompatibility({ status: "available", identities: [substituted], completions: [] }))
      .toEqual(executionCompatibility({ status: "available", identities: [initial], completions: [] }));
  });
  it("retains successful provider outcome and metering when a later persistence checkpoint fails", async () => {
    vi.stubEnv("XAI_API_KEY", "kan4-secret");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    const run = recorder();
    let checkpoint = 0;
    run.checkpointExecution = async () => { if (++checkpoint === 2) throw new Error("checkpoint failed"); };
    let charged = false;
    await expect(accuracyCompletionFor({ route, run, onUsage: () => { charged = true; } })({ system: "sys", user: "input", purpose: "extract:r0" })).rejects.toThrow("checkpoint failed");
    expect(executionEvidenceFromSteps(run.steps()).completions[0].status).toBe("succeeded");
    expect(charged).toBe(true);
  });
  it("retains failure fingerprints and explicitly unavailable provider revision", async () => {
    vi.stubEnv("XAI_API_KEY", "kan4-secret");
    const run = recorder();
    vi.stubGlobal("fetch", async () => { throw new Error("network failed kan4-secret"); });
    await expect(accuracyCompletionFor({ route, run, onUsage: () => {} })({ system: "sys", user: "input", purpose: "extract:r0" })).rejects.toThrow("network failed");
    expect(executionEvidenceFromSteps(run.steps()).completions[0]).toMatchObject({ status: "failed", provider_revision: null,
      response_model: null, system_fingerprint: expect.any(String), user_fingerprint: expect.any(String) });
    expect(JSON.stringify(run.steps())).not.toContain("kan4-secret");
  });
  it("changes the source and prompt-template identity for uncommitted edits, without relying on a commit label", () => {
    const root = mkdtempSync(join(tmpdir(), "kan4-code-")); directories.push(root);
    mkdirSync(join(root, "src/accuracy/modules/test"), { recursive: true });
    writeFileSync(join(root, "src/accuracy/modules/test/prompts.ts"), "export const SYSTEM = 'A';");
    const initial = captureExecutionIdentity(root);
    writeFileSync(join(root, "src/accuracy/modules/test/prompts.ts"), "export const SYSTEM = 'B';");
    const edited = captureExecutionIdentity(root);
    expect(initial).toMatchObject({ status: "available", git_commit: null, worktree: "unknown" });
    expect(edited.source_fingerprint).not.toBe(initial.source_fingerprint);
    expect(edited.prompt_sources_fingerprint).not.toBe(initial.prompt_sources_fingerprint);
  });
  it("uses the existing Next BUILD_ID when source/git are absent and preserves historical unknowns", () => {
    const root = mkdtempSync(join(tmpdir(), "kan4-build-")); directories.push(root);
    expect(captureExecutionIdentity(root)).toMatchObject({ status: "unavailable", git_commit: null, source_fingerprint: null });
    mkdirSync(join(root, ".next")); writeFileSync(join(root, ".next/BUILD_ID"), "deployed-build-42\n");
    expect(captureExecutionIdentity(root)).toMatchObject({ status: "available", build_id: "deployed-build-42", git_commit: null, worktree: "unknown" });
    expect(executionEvidenceFromSteps([])).toEqual({ status: "unavailable", identities: [], completions: [] });
  });
  it("does not upgrade malformed stored execution steps into available identity", () => {
    const identity = { name: "execution:identity", at: "now", duration_ms: null, detail: null,
      data: { schema_version: "execution-identity-v1", status: "available" } };
    expect(executionEvidenceFromSteps([identity]).status).toBe("unavailable");
  });
  it.each([
    { label: "numeric name", row: { name: 42 } },
    { label: "object name", row: { name: {} } },
    { label: "null name", row: { name: null } },
    { label: "absent name", row: {} },
    { label: "null row", row: null },
    { label: "numeric row", row: 42 },
    { label: "string row", row: "corrupt" },
    { label: "boolean row", row: false },
    { label: "array row", row: [] },
  ])("keeps malformed historical $label unavailable while retaining valid evidence", async ({ row }) => {
    const run = recorder();
    await run.step("llm:completion:finished", () => ({ completion_id: "retained-call", purpose: "extract:r0",
      system_fingerprint: "system", user_fingerprint: "user", provider_id: "xai-grok", configured_model: "configured-model",
      temperature: 0, max_tokens: 200, response_model: null, provider_revision: null, status: "succeeded" }));
    const valid = executionEvidenceFromSteps(run.steps());
    expect(valid.status).toBe("available");
    expect(executionCompatibility(valid)).not.toBeNull();
    expect(valid.identities).toHaveLength(1);
    expect(valid.completions).toHaveLength(1);
    expect(executionEvidenceFromSteps([row])).toEqual({ status: "unavailable", identities: [], completions: [] });
    const corrupted = executionEvidenceFromSteps([...run.steps(), row]);
    expect(corrupted).toEqual({ ...valid, status: "unavailable" });
    expect(executionCompatibility(corrupted)).toBeNull();
  });
  it("keeps legacy prepared completions unavailable when application adds a current code identity", () => {
    const applied = recorder();
    applied.restorePreparation([{ name: "llm:judge:legacy", at: "then", duration_ms: 1, detail: null, data: "{}" }], []);
    expect(executionEvidenceFromSteps(applied.steps())).toMatchObject({ status: "unavailable", completions: [] });
  });
  it("preserves preparation and repeated completion identities when restoring merge evidence", async () => {
    vi.stubEnv("XAI_API_KEY", "kan4-secret");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    const prepared = recorder();
    await accuracyCompletionFor({ route, run: prepared, onUsage: () => {} })({ system: "sys", user: "prepare", purpose: "merge:a1" });
    const applied = recorder(); applied.restorePreparation(prepared.steps(), []);
    await accuracyCompletionFor({ route, run: applied, onUsage: () => {} })({ system: "sys", user: "retry", purpose: "merge:a2" });
    const evidence = executionEvidenceFromSteps(applied.steps());
    expect(evidence.identities).toHaveLength(2);
    expect(evidence.completions.map(row => row.purpose)).toEqual(["merge:a1", "merge:a2"]);
    expect(evidence.completions.every(row => row.provider_revision === null)).toBe(true);
  });
  it("hashes both exact prompts before invocation and retains response identity without credentials", async () => {
    vi.stubEnv("XAI_API_KEY", "kan4-secret");
    const run = recorder();
    vi.stubGlobal("fetch", async () => {
      expect(run.steps()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "llm:completion:started",
        data: expect.objectContaining({ purpose: "extract:r0", system_fingerprint: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", user_fingerprint: expect.any(String) }) })]));
      return new Response(JSON.stringify({ model: "response-model", system_fingerprint: "provider-revision",
        choices: [{ message: { content: "{}" } }] }), { status: 200 });
    });
    const complete = accuracyCompletionFor({ route, run, onUsage: () => {} });
    await complete({ system: "abc", user: "source V0", purpose: "extract:r0" });
    await complete({ system: "abc", user: "source V1", purpose: "extract:r1" });
    const evidence = executionEvidenceFromSteps(run.steps());
    expect(evidence.completions).toHaveLength(2);
    expect(evidence.completions[0]).toMatchObject({ status: "succeeded", provider_id: "xai-grok", configured_model: "configured-model",
      response_model: "response-model", provider_revision: "provider-revision", purpose: "extract:r0" });
    expect(evidence.completions[0].user_fingerprint).not.toBe(evidence.completions[1].user_fingerprint);
    expect(evidence.completions[0].completion_id).not.toBe(evidence.completions[1].completion_id);
    expect(JSON.stringify(evidence)).not.toContain("kan4-secret");
  });
});
