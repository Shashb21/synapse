import { describe, expect, it, vi } from "vitest";
import { extractStage, type ExtractRequest, type ExtractTransport } from "@/accuracy/eval/benchmark/extract";

function request(configuration: "extract" | "baseline" = "extract"): ExtractRequest {
  return {
    runId: "run1", attemptId: "a1", pack: { packId: "synthetic", sourceHash: "hash", source: { blocks: Array.from({ length: 90 }, (_, i) => ({ id: `b${i}`, kind: "paragraph", text: `unique quote ${i} end ${"x".repeat(500)}`, location: { kind: "page", ref: String(i + 1) } })) } },
    route: { configuration, stage: "need_extract", providerId: configuration === "extract" ? "llamaextract" : "xai-grok", requestedModel: configuration === "extract" ? "extract" : "frozen-model", actualModel: null, version: "2.5", tier: "cost_effective", lowestCostSuitableTierVerified: true, accountVerified: true, versionVerified: true, citationsVerified: true, citationsEnabled: true, authorizationEvidence: "synthetic", settingsHash: "settings", credentialEnvName: "TEST_API_KEY", fallbackAllowed: false },
    baseline: { snapshot: { call_kind: "need_extract", role: "proposer", provider_id: "xai-grok", model: "frozen-model", params: { temperature: 0.12, max_tokens: 777 }, fallbacks: [], degraded: false, reason: null }, shallowCycle: true, baseUrl: "https://api.x.ai/v1" },
    projectId: "p1",
  } as ExtractRequest;
}
const gap = { statement: "A concrete need", external_id: "NEED_1", provenance: [{ source_file_id: "synthetic", block_id: "b89", quote: "unique quote 89 end" }] };
function job(overrides: Record<string, unknown> = {}) {
  return { id: "ext-1", file_input: "dfl-1", status: "COMPLETED", configuration: { version: "2.5", tier: "cost_effective", cite_sources: true }, extract_result: { gaps: [gap] }, extract_metadata: { field_metadata: { document_metadata: { gaps: [{ statement: { citation: [{ page: 90, matching_text: "unique quote 89 end" }] } }] } } }, usage: { credits: 5, extract_credits: 5, parse_credits: 0 }, ...overrides };
}
function transport(replies: unknown[]): ExtractTransport {
  return { apiKey: "secret-test-key", fetch: vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 })), beforeAttempt: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
}
describe("complete source extraction", () => {
  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'])('uses native Anthropic parameters for %s and continuous text only', async model => {
    const r = request('baseline');
    r.route.providerId = r.baseline!.snapshot.provider_id = 'anthropic-claude';
    r.route.requestedModel = r.baseline!.snapshot.model = model;
    r.baseline!.baseUrl = 'https://api.anthropic.com';
    r.baseline!.shallowCycle = false;
    const json = JSON.stringify({ gaps: [gap] });
    const split = json.indexOf('concrete') + 3;
    const t = transport([{ model, stop_reason: 'end_turn', content: [{ type: 'thinking', text: 'ignore' }, { type: 'text', text: json.slice(0, split) }, { type: 'tool_use', text: 'ignore' }, { type: 'text', text: json.slice(split) }], usage: { input_tokens: 7, output_tokens: 2 } }]);
    const result = await extractStage(r, t);
    expect(result.status).toBe('completed');
    expect(result.findings[0].statement).toBe(gap.statement);
    expect(result.actualRoute.model).toBe(model);
    expect(result.usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
    const [url, init] = vi.mocked(t.fetch).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('secret-test-key');
    const body = JSON.parse(init!.body as string);
    if (model.includes('haiku')) expect(body.temperature).toBe(0.12);
    else expect(body).not.toHaveProperty('temperature');
    expect(r.baseline!.snapshot.params.temperature).toBe(0.12);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['refusal', 'max_tokens'])('rejects Anthropic %s despite valid JSON and retains usage', async stop_reason => {
    const r = request('baseline');
    r.route.providerId = r.baseline!.snapshot.provider_id = 'anthropic-claude';
    r.baseline!.baseUrl = 'https://api.anthropic.com';
    r.baseline!.shallowCycle = false;
    const t = transport([{ model: 'frozen-model', stop_reason, content: [{ type: 'text', text: '{"gaps":[]}' }], usage: { input_tokens: 7, output_tokens: 2 } }]);
    const result = await extractStage(r, t);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('provider_output_error');
    expect(result.attempts[0].usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
    expect(result.rawOutputs).toHaveLength(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads all >80 blocks without gold and preserves job/cost/citations", async () => {
    const r = request(); Object.assign(r.pack, { gold: { needs: "DO_NOT_SEND_GOLD" } });
    const t = transport([{ id: "dfl-1" }, { id: "ext-1", status: "PENDING" }, job()]);
    const submitted = await extractStage(r, t);
    expect(submitted.status).toBe("pending"); expect(submitted.state.jobId).toBe("ext-1");
    const body = (vi.mocked(t.fetch).mock.calls[0][1]?.body as FormData);
    const text = await (body.get("file") as Blob).text();
    expect(text).toContain("block_id=b89"); expect(text.length).toBeGreaterThan(40000); expect(text).not.toContain("DO_NOT_SEND_GOLD");
    const done = await extractStage({ ...r, resume: submitted.state }, t);
    expect(done.status).toBe("completed"); expect(done.findings[0].citation.valid).toBe(true);
    expect(done.costUsd).toBe(0.00625); expect(done.actualRoute.model).toBeNull(); expect(done.actualRoute.version).toBe("2.5");
    expect(done.rawOutputs.length).toBe(3); expect(t.fetch).toHaveBeenCalledTimes(3);
  });
  it.each(["missing", "mismatch", "ambiguous"])("retains findings with invalid %s citations", async (mode) => {
    const r = request();
    if (mode === "ambiguous") r.pack.source.blocks[0].text = r.pack.source.blocks[89].text;
    const metadata = mode === "missing" ? null : { field_metadata: { document_metadata: { gaps: [{ statement: { citation: [{ page: 90, matching_text: mode === "mismatch" ? "absent quote" : "unique quote 89 end" }] } }] } } };
    const done = await extractStage({ ...r, resume: await submittedState(r) }, transport([job({ extract_metadata: metadata })]));
    expect(done.findings).toHaveLength(1); expect(done.findings[0].citation.valid).toBe(false);
  });
  it("blocks unsupported version before transport", async () => {
    const r = request(); r.route.version = "latest"; const t = transport([]);
    expect((await extractStage(r, t)).error?.code).toBe("unsupported_configuration"); expect(t.fetch).not.toHaveBeenCalled();
  });
  it("does not retry transient failure and records unknown incurred cost safely", async () => {
    const t = transport([]); t.fetch = vi.fn(async () => new Response("secret-test-key", { status: 503 }));
    const result = await extractStage(request("baseline"), t);
    expect(result.status).toBe("failed"); expect(result.error?.temporary).toBe(true); expect(result.costUsd).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret-test-key"); expect(t.fetch).toHaveBeenCalledTimes(1); expect(result.attempts).toHaveLength(1);
  });
  it("honors baseline snapshot settings and labels responding model substitution", async () => {
    const t = transport([{ id: "reply", model: "fallback-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ gaps: [gap] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
    const done = await extractStage(request("baseline"), t);
    const payload = JSON.parse(vi.mocked(t.fetch).mock.calls[0][1]?.body as string);
    expect(payload.model).toBe("frozen-model"); expect(payload.temperature).toBe(0.12); expect(payload.max_tokens).toBe(777);
    expect(payload.messages[1].content).toContain("block_id=b89"); expect(done.actualRoute.label).toBe("substituted"); expect(done.actualRoute.model).toBe("fallback-model");
    expect(done.findings[0].citation.valid).toBe(true); expect(done.costUsd).toBeNull();
  });
  it("persists uploaded identity when submission fails; resume never reuploads", async () => {
    const t = transport([{ id: "dfl-1" }]); let calls = 0;
    t.fetch = vi.fn(async () => ++calls === 1 ? new Response(JSON.stringify({ id: "dfl-1" })) : new Response("error", { status: 503 }));
    const done = await extractStage(request(), t);
    expect(done.state.uploadId).toBe("dfl-1"); expect(done.state.submissionUncertain).toBe(true); expect(t.checkpoint).toHaveBeenCalled();
    const next = transport([]); expect((await extractStage({ ...request(), resume: done.state }, next)).error?.code).toBe("submission_uncertain"); expect(next.fetch).not.toHaveBeenCalled();
  });
  it("does not send when budget boundary denies attempt", async () => {
    const t = transport([]); t.beforeAttempt = vi.fn(async () => { throw new Error("budget"); });
    expect((await extractStage(request(), t)).error?.code).toBe("budget_blocked"); expect(t.fetch).not.toHaveBeenCalled();
  });
  it("rejects polling an existing job under changed provider settings", async () => {
    const r = request(), t = transport([{ id: "dfl-1" }, { id: "ext-1", status: "PENDING" }]);
    const submitted = await extractStage(r, t);
    r.projectId = "other-project";
    const next = transport([]);
    expect((await extractStage({ ...r, resume: submitted.state }, next)).error?.code).toBe("resume_mismatch");
    expect(next.fetch).not.toHaveBeenCalled();
  });
  it("keeps per-call responding routes and usage across a shallow revision", async () => {
    const reply = (model: string, data: unknown) => ({ model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    const t = transport([reply("fallback-first", { gaps: [{ ...gap, provenance: [] }] }), reply("frozen-model", { gaps: [gap] })]);
    const done = await extractStage(request("baseline"), t);
    expect(done.status).toBe("completed"); expect(done.attempts).toHaveLength(2);
    expect(done.attempts[0].actualRoute?.model).toBe("fallback-first");
    expect(done.actualRoute.label).toBe("substituted");
    expect(done.attempts[0].usage).toMatchObject({ input_tokens: 100 });
    expect(done.attempts[1].usage).toMatchObject({ input_tokens: 100 });
  });
  it("submits the verified lowest suitable fixed tier instead of substituting a cheaper tier", async () => {
    const r = request(); r.route.tier = "agentic";
    const t = transport([{ id: "dfl-1" }, { id: "ext-1", status: "PENDING" }]);
    const done = await extractStage(r, t);
    expect(done.status).toBe("pending");
    expect(JSON.parse(vi.mocked(t.fetch).mock.calls[1][1]?.body as string).configuration.tier).toBe("agentic");
  });
  it("does not treat a correct identifier alone as supporting the statement", async () => {
    const r = request("baseline"); r.pack.source.blocks[89].text += " NEED_1";
    const t = transport([{ model: "frozen-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ gaps: [{ ...gap, provenance: [{ ...gap.provenance[0], quote: "NEED_1" }] }] }) } }] }]);
    const done = await extractStage(r, t);
    expect(done.findings[0].citation.valid).toBe(false);
    expect(done.findings[0].citation.reasons).toContain("identifier_only");
  });
  it.each([
    ["openai", "https://api.openai.com/v1", "chat"],
    ["openrouter", "https://openrouter.ai/api/v1", "chat"],
    ["anthropic-claude", "https://api.anthropic.com", "anthropic"],
    ["google-gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini"],
  ])("uses supplied %s route and its single-attempt protocol", async (provider, baseUrl, protocol) => {
    const r = request("baseline"); r.route.providerId = provider; r.baseline!.snapshot.provider_id = provider; r.baseline!.baseUrl = baseUrl;
    const content = JSON.stringify({ gaps: [gap] });
    const reply = protocol === "anthropic" ? { model: "frozen-model", content: [{ type: "text", text: content }], stop_reason: "end_turn", usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 } }
      : protocol === "gemini" ? { modelVersion: "frozen-model", candidates: [{ finishReason: "STOP", content: { parts: [{ text: content }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }
      : { model: "frozen-model", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    const t = transport([reply]); const done = await extractStage(r, t);
    expect(done.status).toBe("completed"); expect(done.actualRoute.label).toBe("verified"); expect(done.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    expect(done.findings[0].citation.valid).toBe(true); expect(t.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(t.fetch).mock.calls[0][1]?.body as string);
    expect(protocol === "gemini" ? body.generationConfig.maxOutputTokens : body.max_tokens).toBe(777);
    expect(protocol === "gemini" ? body.generationConfig.temperature : body.temperature).toBe(0.12);
    if (protocol === "gemini") expect(body.generationConfig.responseMimeType).toBe("application/json");
    if (protocol === "anthropic") expect(new Headers(vi.mocked(t.fetch).mock.calls[0][1]?.headers).get("anthropic-version")).toBe("2023-06-01");
    if (provider === "openai") expect(body).not.toHaveProperty("response_format");
    if (provider === "openrouter") {
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(new Headers(vi.mocked(t.fetch).mock.calls[0][1]?.headers).get("x-title")).toBe("Synapse IEGP");
      expect(new Headers(vi.mocked(t.fetch).mock.calls[0][1]?.headers).get("http-referer")).toBe("https://github.com/Shashb21/synapse");
    }
    const failure = transport([]); failure.fetch = vi.fn(async () => new Response("upstream failure", { status: 503 }));
    expect((await extractStage(r, failure)).error?.temporary).toBe(true); expect(failure.fetch).toHaveBeenCalledTimes(1);
  });
  it("extracts independent inventory details with original source locations", async () => {
    const r = request(); r.route.stage = "inventory_extract"; r.baseline!.snapshot.call_kind = "inventory_extract";
    const candidate = { name: "Renal registry", type: "registry", status: "planned", origin: "inventory", evidence_question: "How do renal patients respond?", external_id: "TACTIC_3", provenance: gap.provenance };
    const metadata = { field_metadata: { document_metadata: { tactics: [{ evidence_question: { citation: [{ page: 90, matching_text: "unique quote 89 end" }] } }] } } };
    const done = await extractStage({ ...r, resume: await submittedState(r) }, transport([job({ extract_result: { tactics: [candidate] }, extract_metadata: metadata })]));
    expect(done.status).toBe("completed"); expect(done.findings[0].details).toMatchObject({ name: "Renal registry", type: "registry", status: "planned", external_id: "TACTIC_3" });
    expect(done.findings[0].citation.locations).toEqual([{ kind: "page", ref: "90" }]);
    expect(done.findings[0].citation.valid).toBe(true);
  });
  it("retains baseline inventory details and uses its own source extraction prompt", async () => {
    const r = request("baseline"); r.route.stage = "inventory_extract"; r.baseline!.snapshot.call_kind = "inventory_extract";
    const t = transport([{ model: "frozen-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ tactics: [{ name: "Renal registry", type: "registry", status: "planned", origin: "inventory", evidence_question: "How do renal patients respond?", provenance: gap.provenance }] }) } }] }]);
    const done = await extractStage(r, t);
    expect(done.status).toBe("completed"); expect(done.findings[0].details.name).toBe("Renal registry");
    expect(JSON.parse(vi.mocked(t.fetch).mock.calls[0][1]?.body as string).messages[0].content).toContain("extract tactics");
  });
  it.each(["duplicate_name", "wrong_origin"])("revises inventory %s before strict output validation", async (issue) => {
    const r = request("baseline"); r.route.stage = "inventory_extract"; r.baseline!.snapshot.call_kind = "inventory_extract";
    const candidate = { name: "Renal registry", type: "registry", status: "planned", origin: "inventory", evidence_question: "How do renal patients respond?", external_id: "TACTIC_1", provenance: gap.provenance };
    const draft = issue === "duplicate_name"
      ? [candidate, { ...candidate, name: "  RENAL REGISTRY  ", external_id: "TACTIC_2" }]
      : [{ ...candidate, origin: "generated" }];
    const reply = (tactics: unknown[]) => ({ model: "frozen-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ tactics }) } }] });
    const t = transport([reply(draft), reply([candidate])]);
    const done = await extractStage(r, t);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(done.status).toBe("completed"); expect(done.findings).toHaveLength(1);
    const revision = JSON.parse(vi.mocked(t.fetch).mock.calls[1][1]?.body as string);
    expect(revision.messages[1].content).toContain(issue === "duplicate_name" ? "RENAL REGISTRY:duplicate" : "Renal registry:wrong_origin");
  });
  it("marks an absent actual model unverified without inventing the requested model", async () => {
    const t = transport([{ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ gaps: [gap] }) } }] }]);
    const done = await extractStage(request("baseline"), t);
    expect(done.actualRoute.model).toBeNull(); expect(done.actualRoute.label).toBe("unverified"); expect(done.costUsd).toBeNull();
  });
  it("keeps pending billing unknown and does not double-count job charges on polls", async () => {
    const r = request(); const resume = await submittedState(r);
    const pending = await extractStage({ ...r, resume }, transport([job({ usage: { credits: 5, extract_credits: 5, parse_credits: null } })]));
    expect(pending.costUsd).toBeNull();
    const billed = await extractStage({ ...r, resume: pending.state }, transport([job()]));
    const repolled = await extractStage({ ...r, resume: billed.state }, transport([job()]));
    expect(billed.costUsd).toBe(0.00625); expect(repolled.costUsd).toBe(0.00625);
    expect(repolled.attempts.every((a) => a.costUsd === null)).toBe(true);
  });
  it("retains job identity, usage and known charge when the job fails", async () => {
    const r = request(); const done = await extractStage({ ...r, resume: await submittedState(r) }, transport([job({ status: "FAILED", error_message: "secret-test-key" })]));
    expect(done.error?.code).toBe("job_failed"); expect(done.costUsd).toBe(0.00625); expect(done.state.jobId).toBe("ext-1");
    expect(JSON.stringify(done)).not.toContain("secret-test-key");
  });
  it.each(["version", "tier"])("labels substituted Extract %s using resolved response configuration", async (field) => {
    const r = request(); const done = await extractStage({ ...r, resume: await submittedState(r) }, transport([job({ configuration: { version: "2.5", tier: "cost_effective", cite_sources: true, [field]: "different" } })]));
    expect(done.actualRoute.label).toBe("substituted"); expect(done.findings).toHaveLength(1);
  });
  it("preserves malformed output and reported usage instead of returning successful empty extraction", async () => {
    const t = transport([{ model: "frozen-model", choices: [{ finish_reason: "stop", message: { content: "{bad JSON" } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }]);
    const done = await extractStage(request("baseline"), t);
    expect(done.error?.code).toBe("invalid_output_json"); expect(done.rawOutputs).toHaveLength(1); expect(done.attempts[0].usage).toMatchObject({ input_tokens: 12 });
  });
  it("records a failed poll without resubmitting the paid job", async () => {
    const r = request(); const t = transport([]); t.fetch = vi.fn(async () => { throw new Error("secret-test-key network"); });
    const done = await extractStage({ ...r, resume: await submittedState(r) }, t);
    expect(done.error?.temporary).toBe(true); expect(done.state.jobId).toBe("ext-1"); expect(done.attempts.at(-1)?.operation).toBe("poll");
    expect(t.fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(done)).not.toContain("secret-test-key");
  });
  it("does not send when required private checkpoint fails", async () => {
    const t = transport([]); t.checkpoint = vi.fn(async () => { throw new Error("disk failure"); });
    const done = await extractStage(request(), t);
    expect(done.status).toBe("failed"); expect(t.fetch).not.toHaveBeenCalled(); expect(done.attempts).toHaveLength(1);
  });
  it("preserves error response usage and known incurred charge without leaking credentials", async () => {
    const r = request(); const t = transport([]);
    t.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "secret-test-key", usage: { credits: 5, extract_credits: 5, parse_credits: 0 } }), { status: 503 }));
    const done = await extractStage({ ...r, resume: await submittedState(r) }, t);
    expect(done.costUsd).toBe(0.00625); expect(done.rawOutputs.at(-1)).toMatchObject({ error: "[REDACTED]" });
    expect(done.attempts.at(-1)?.usage).toMatchObject({ credits: 5 });
  });
  it("rejects resume source mismatch", async () => {
    const t = transport([]); expect((await extractStage({ ...request(), resume: { ...await submittedState(request()), sourceHash: "different" } }, t)).error?.code).toBe("resume_mismatch"); expect(t.fetch).not.toHaveBeenCalled();
  });
});
async function submittedState(r: ExtractRequest) {
  return (await extractStage(r, transport([{ id: "dfl-1" }, { id: "ext-1", status: "PENDING" }]))).state;
}
