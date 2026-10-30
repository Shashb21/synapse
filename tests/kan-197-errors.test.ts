/** Behavioral checks for safe message ownership and honest request outcomes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageFailureBody, apiErrorResponse, ApiGuardError } from "@/modules/auth/api-guard";
import { customerErrorMessage, tagStageError, TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { ProviderError } from "@/modules/llm/provider-error";
import { noLlmBody } from "@/modules/kernel/no-llm";
import { postJson } from "@/lib/post-json";
import { sendJson as sendClaimJson } from "@/components/accuracy/claim-api";
import { sendJson } from "@/components/workspaces/model";

const secret = "database password=sample-secret SELECT * FROM private_accounts";
afterEach(() => vi.unstubAllGlobals());
describe("safe message boundaries", () => {
  it.each([false, true])("suppresses unknown details for owner=%s", (owner) => {
    const body = stageFailureBody(new Error(secret), owner, "We couldn't save the changes. Check the current state before trying again.");
    expect(body.error).not.toContain(secret);
    expect(body.error).toContain("changes");
    expect(customerErrorMessage(new Error(secret))).not.toBeNull();
  });
  it.each([false, true])("suppresses provider payload and unverified saved claims for owner=%s", (owner) => {
    const error = new ProviderError({ provider_id: "test", provider_name: "test", key_env: "TEST_API_KEY", status: 429, error_type: null, provider_message: secret });
    expect(stageFailureBody(error, owner).error).not.toContain(secret);
    expect(stageFailureBody(error, owner).error).not.toMatch(/work is saved|Nothing was saved/);
  });
  it.each([
    ["invalid_request", 400, "A title is required."],
    ["stale_write", 409, "The record changed. Reload it before saving again."],
    ["not_found", 404, "This source is no longer available. Choose another source."],
    ["forbidden", 403, "Ask the workspace owner to make this change."],
  ])("preserves explicitly owned %s guidance", async (code, status, message) => {
    const response = await apiErrorResponse(new TrustedApplicationError(String(message), String(code), Number(status)));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: message, code, safe_error: true });
  });
  it("distinguishes an unavailable provider from a daily limit", () => {
    const error = new ProviderError({ provider_id: "test", provider_name: "test", key_env: "TEST_API_KEY", status: 503, error_type: null, provider_message: secret });
    expect(customerErrorMessage(error)).toContain("few minutes");
    expect(customerErrorMessage(error)).not.toContain(secret);
  });
  it("preserves the failed ingestion stage alongside owned recovery guidance", async () => {
    const error = new TrustedApplicationError("Parsing did not finish. Retry parsing the registered source.");
    tagStageError(error, "S1");
    const response = await apiErrorResponse(error);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ safe_error: true, code: "invalid_request", stage: "S1", error: error.message });
  });
  it("keeps daily quota distinct from a temporary limit", () => {
    const info = { provider_id: "test", provider_name: "test", key_env: "TEST_KEY", status: 429, error_type: null, provider_message: null };
    expect(customerErrorMessage(new ProviderError({ ...info, daily_quota: true }))).toContain("tomorrow");
    expect(customerErrorMessage(new ProviderError(info))).toContain("minute");
  });
  it("does not echo missing-model diagnostics even for owners", () => {
    expect(noLlmBody(secret, true).error).not.toContain(secret);
    expect(noLlmBody(secret, true).admin_href).toBe("/admin/control");
  });
  it("preserves session status and code", async () => {
    const response = await apiErrorResponse(new ApiGuardError(401, "no_session", "Sign in again to continue."));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "no_session", error: "Sign in again to continue." });
  });
  it.each([null, [], "hello", {}])("does not confirm a malformed success (%j)", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    const result = await postJson("/api/change", {});
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ outcome: "unknown" });
    expect(result.json.error).toContain("check");
  });
  it("suppresses an untrusted server failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: secret }, { status: 500 })));
    expect((await postJson("/api/change", {})).json.error).not.toContain(secret);
  });
  it("exposes response loss to throwing callers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(sendJson("/api/change", {})).rejects.toMatchObject({ outcome: "unknown" });
  });
  it("does not infer a rejected write from a server failure response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ safe_error: true, error: "The final check failed after saving." }, { status: 500 })));
    expect(await postJson("/api/change", {})).toMatchObject({ ok: false, outcome: "unknown" });
  });
  it("does not confirm an unreadable claim edit or reflect transport details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>OK</html>")).mockRejectedValueOnce(new Error(secret)));
    expect(await sendClaimJson("/api/accuracy/claims", "PATCH", {})).toMatchObject({ ok: false, outcome: "unknown" });
    expect((await sendClaimJson("/api/accuracy/claims", "PATCH", {})).error).not.toContain(secret);
  });
  it("confirms valid object responses and preserves safe validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ error: "A title is required.", safe_error: true }, { status: 400 })));
    expect(await postJson("/api/change", {})).toMatchObject({ ok: true, outcome: "confirmed" });
    expect((await postJson("/api/change", {})).json.error).toBe("A title is required.");
  });
});
