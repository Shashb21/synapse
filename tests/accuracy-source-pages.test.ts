import { describe, expect, it } from "vitest";
import { buildSourcePages, sourceUnitHeader } from "@/accuracy/domain/source-pages";
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import type { ParseBlock } from "@/accuracy/store/quote-validator";

const block = (index: number, text: string): ParseBlock => ({ id: `B${index}`, workspace_id: "ws", source_file_id: "src", index, kind: "prose", heading: null, text });

describe("complete source pages", () => {
  it("represents every character after 80 blocks and splits an oversized block at original offsets", () => {
    const blocks = [...Array.from({ length: 90 }, (_, i) => block(i, `Evidence ${i}. `.repeat(70))), block(90, "x".repeat(50000) + "TAIL")];
    const pages = buildSourcePages(blocks, 4000);
    expect(pages.flatMap(p => p.units).map(u => u.text).join("")).toBe(blocks.map(b => b.text).join(""));
    expect(pages.at(-1)!.units.at(-1)!.text).toContain("TAIL");
    for (const unit of pages.flatMap(p => p.units)) {
      expect(blocks.find(b => b.id === unit.block_id)!.text.slice(unit.char_start, unit.char_end)).toBe(unit.text);
    }
    expect(buildSourcePages(blocks, 4000)).toEqual(pages);
    expect(pages.every(p => p.prompt_chars <= 4000)).toBe(true);
  });
  it("rejects invalid budgets and mixed source identities", () => {
    for (const budget of [0, -1, NaN, 1.5]) expect(() => buildSourcePages([block(0, "text")], budget)).toThrow();
    expect(() => buildSourcePages([block(0, "text"), { ...block(1, "other"), workspace_id: "foreign" }], 4000)).toThrow();
  });
  it("terminates explicitly when an empty page has room for only half the next surrogate pair", async () => {
    const original = { ...block(0, "😀"), heading: "h".repeat(210) };
    expect(sourceUnitHeader({ ...original, block_id: original.id, char_start: 0, char_end: 2 }).length + 2).toBe(255);
    // Execute the actual public builder in a terminable worker so the regression cannot hang Vitest.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Module = require('node:module');
      const loaded = new Module(workerData.file);
      loaded.filename = workerData.file;
      loaded.paths = Module._nodeModulePaths(require('node:path').dirname(workerData.file));
      loaded._compile(require('typescript').transpileModule(require('node:fs').readFileSync(workerData.file, 'utf8'), {
        compilerOptions: { module: require('typescript').ModuleKind.CommonJS }
      }).outputText, workerData.file);
      try { parentPort.postMessage({ pages: loaded.exports.buildSourcePages([workerData.block], 256) }); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
    `, { eval: true, workerData: { file: resolve("src/accuracy/domain/source-pages.ts"), block: original } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        new Promise<{ error?: string }>((res, reject) => { worker.once("message", res); worker.once("error", reject); }),
        new Promise<{ error: string }>(res => { timer = setTimeout(() => res({ error: "Paging did not terminate" }), 2000); }),
      ]);
      expect(result.error).toMatch(/cannot fit.*source page budget/i);
    } finally { clearTimeout(timer); await worker.terminate(); }
  });
});

import { afterAll, vi } from "vitest";
import postgres from "postgres";

// Production pool semantics are necessary for the publication/edit concurrency regression.
vi.stubEnv("VITEST", "");
afterAll(() => vi.unstubAllEnvs());
import { POST } from "@/app/api/accuracy/extract/route";
import { registerAccuracyStack } from "@/accuracy";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks, readParseBlocks, persistDroppedUnits } from "@/accuracy/store/parse-store";
import { listActiveSourceClaims, getClaim, claimMetadata } from "@/accuracy/store/claim-store";
import { updateClaim } from "@/accuracy/store/claim-edit";
import { accuracyTransactionActive } from "@/accuracy/store/db";
import { accuracyRouteConfig, setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { openAi } from "@/modules/llm/provider";
import * as session from "@/modules/auth/session";
import { INVENTORY_PROPOSER_SYSTEM } from "@/accuracy/modules/inventory-extract/prompts";
import { NEED_PROPOSER_SYSTEM } from "@/accuracy/modules/need-extract/prompts";

async function fixture(texts: string[]) {
  registerAccuracyStack();
  const org_id = await createOrganization(crypto.randomUUID());
  const workspace_id = await createWorkspace({ org_id, name: "Pages", slug: crypto.randomUUID() });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "pages.txt", mime: "text/plain", checksum: crypto.randomUUID() });
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local", blocks: texts.map((text, index) => ({ ...block(index, text), id: `${source.id}-B${index}`, source_file_id: source.id })) });
  return { workspace_id, source_file_id: source.id };
}
const post = (body: object) => POST(new Request("http://localhost/api/accuracy/extract", { method: "POST", body: JSON.stringify(body) }));
async function providerFixture<T>(provider: typeof openAi.complete, action: () => Promise<T>) {
  const route = await accuracyRouteConfig("need_extract", "proposer");
  const merge = await accuracyRouteConfig("merge_dedupe", "judge");
  const inventory = await accuracyRouteConfig("inventory_extract", "proposer");
  const stub = process.env.SYNAPSE_TEST_STUB_LLM, key = process.env.OPENAI_API_KEY;
  process.env.SYNAPSE_TEST_STUB_LLM = "0"; process.env.OPENAI_API_KEY = "fixture";
  await setAccuracyRouteConfig({ call_kind: "need_extract", agent_role: "proposer", provider_id: "openai", model: "gpt-5.1", actor_name: "test", fallbacks: [] });
  await setAccuracyRouteConfig({ call_kind: "merge_dedupe", agent_role: "judge", provider_id: "openai", model: "gpt-5.1", actor_name: "test", fallbacks: [] });
  await setAccuracyRouteConfig({ call_kind: "inventory_extract", agent_role: "proposer", provider_id: "openai", model: "gpt-5.1", actor_name: "test", fallbacks: [] });
  const auth = vi.spyOn(session, "sessionContext").mockResolvedValue({ session: null, actor: { name: "Owner", function: "medical_affairs" }, role: "operator", demo: false, signed_in: true });
  const spy = vi.spyOn(openAi, "complete").mockImplementation(provider);
  try { return await action(); } finally {
    spy.mockRestore(); auth.mockRestore();
    process.env.SYNAPSE_TEST_STUB_LLM = stub;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    for (const previous of [route, merge, inventory]) await setAccuracyRouteConfig({ ...previous, actor_name: previous.updated_by, temperature: previous.params.temperature, max_tokens: previous.params.max_tokens });
  }
}
const answer = async (request: Parameters<typeof openAi.complete>[0]) => {
  expect(accuracyTransactionActive()).toBe(false);
  if (request.system.startsWith("Compare every source block")) {
    const input = JSON.parse(request.user);
    return JSON.stringify({ checked_block_ids: input.blocks.map((b: { id: string }) => b.id), suspected_omissions: [], prior_issue_resolutions: [] });
  }
  if (request.system === NEED_PROPOSER_SYSTEM) {
    const source_file_id = request.user.match(/source_file_id=(\S+)/)![1];
    const gaps = [...request.user.matchAll(/### block_id=(\S+)[^\n]*\n([^#]*)/g)].flatMap(match => {
      const quote = match[2].match(/Need entity \d+\./)?.[0];
      return quote ? [{ statement: quote, external_id: null, provenance: [{ source_file_id, block_id: match[1], quote }] }] : [];
    });
    return JSON.stringify({ gaps });
  }
  return JSON.stringify({ decisions: [...request.user.matchAll(/### pair_id=(\S+)/g)].map(m => ({ pair_id: m[1], same: false, rationale: "Distinct source entities" })) });
};

it("extracts every declared block beyond the old caps through the real API and retains stable human edits", async () => {
  const scope = await fixture(Array.from({ length: 90 }, (_, i) => `Need entity ${i}. ` + "padding ".repeat(80)));
  await providerFixture(answer, async () => {
    const first = await post({ ...scope, kinds: ["need"] });
    expect(first.status).toBe(200);
    const output = await first.json();
    expect(output.source_progress).toMatchObject({ complete: true, selection_scope: "all", expected_blocks: 90 });
    const claims = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    expect(claims).toHaveLength(90);
    const edited = claims.find(c => c.statement === "Need entity 0.")!;
    await updateClaim({ workspace_id: scope.workspace_id, claim_id: edited.id, patch: { statement: "Human wording" }, rationale: "Reviewed", actor: { name: "Ada", function: "medical_affairs" } });
    const second = await post({ ...scope, kinds: ["need"] });
    expect(second.status).toBe(200);
    expect((await second.json()).claim_ids.sort()).toEqual(claims.map(c => c.id).sort());
    expect((await getClaim(scope.workspace_id, edited.id))!.statement).toBe("Human wording");
    expect(await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).toHaveLength(90);
  });
});

import { extractionDownstreamState, resumeExtractionBatch } from "@/accuracy/store/extraction-batch-store";

it("keeps the first accepted page and resumes a failed second page with original quote offsets", async () => {
  const scope = await fixture(["Need entity 0. " + "x".repeat(65000) + " Need entity 1."]);
  let fail = true;
  await providerFixture(async request => {
    if (request.system === NEED_PROPOSER_SYSTEM && Number(request.user.match(/char_start=(\d+)/)?.[1]) > 0 && fail) throw new Error("Page provider unavailable");
    return answer(request);
  }, async () => {
    const first = await post({ ...scope, kinds: ["need"] });
    expect(first.status).toBe(409);
    const failed = await first.json();
    expect(failed.source_progress).toMatchObject({ complete: false, failed_units: 1, next_cursor: expect.any(String) });
    const claims = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    expect(claims.map(c => c.statement)).toEqual(["Need entity 0."]);
    const firstRun = failed.runs[0].run_id;
    fail = false;
    const resumed = await post({ ...scope, kinds: ["need"], cursor: failed.source_progress.next_cursor });
    expect(resumed.status, JSON.stringify(await resumed.clone().json())).toBe(200);
    const output = await resumed.json();
    expect(output.claim_ids).toContain(claims[0].id);
    expect(output.runs[0].run_id).toBe(firstRun);
    expect(output.source_progress.complete).toBe(true);
    const last = (await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).find(c => c.statement === "Need entity 1.")!;
    expect(claimMetadata(last).provenance).toEqual([expect.objectContaining({ block_id: `${scope.source_file_id}-B0`, char_start: 65016, char_end: 65030 })]);
  });
});

it("retains a nested human lock and exposes conflicting rerun facts under the original claim ID", async () => {
  const scope = await fixture(["Need entity 0. Setting: first line. Setting: second line."]);
  const block_id = `${scope.source_file_id}-B0`;
  let rationale = "Model reason A";
  await providerFixture(async request => {
    if (request.system === NEED_PROPOSER_SYSTEM) return JSON.stringify({ gaps: [{ statement: "Need entity 0.", external_id: null,
      provenance: [{ source_file_id: scope.source_file_id, block_id, quote: "Need entity 0." }], structured: { version: 1,
        rationale: { state: "known", value: rationale, provenance: [{ source_file_id: scope.source_file_id, block_id, quote: "Need entity 0." }] } } }] });
    return answer(request);
  }, async () => {
    expect((await post({ ...scope, kinds: ["need"] })).status).toBe(200);
    const original = (await listActiveSourceClaims(scope.workspace_id, scope.source_file_id))[0];
    await updateClaim({ workspace_id: scope.workspace_id, claim_id: original.id, actor: { name: "Ada", function: "medical_affairs" }, rationale: "Reviewed source",
      patch: { structured: { rationale: { state: "known", value: "Human reason", provenance: [{ source_file_id: scope.source_file_id, block_id, quote: "Need entity 0." }] } } } });
    rationale = "Model reason B";
    const rerun = await post({ ...scope, kinds: ["need"] });
    expect(rerun.status).toBe(200);
    expect((await rerun.json()).claim_ids).toEqual([original.id]);
    const saved = await getClaim(scope.workspace_id, original.id);
    expect(claimMetadata(saved!).structured).toMatchObject({ rationale: { value: "Human reason" } });
    expect(claimMetadata(saved!).extraction_suggestions).toEqual([expect.objectContaining({ structured: expect.objectContaining({ rationale: expect.objectContaining({ value: "Model reason B" }) }) })]);
  });
});

it("declares selected scope and rejects foreign selection, stale and malformed cursors", async () => {
  const scope = await fixture(["Need entity 0.", "Need entity 1."]);
  const other = await fixture(["Need entity 2."]);
  await providerFixture(answer, async () => {
    const selected = await post({ ...scope, kinds: ["need"], block_ids: [`${scope.source_file_id}-B1`] });
    expect(selected.status).toBe(200);
    const output = await selected.json();
    expect(output.source_progress).toMatchObject({ complete: true, full_source_complete: false, selection_scope: "selected", expected_blocks: 1 });
    expect((await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).map(c => c.statement)).toEqual(["Need entity 1."]);
    for (const block_ids of [[`${other.source_file_id}-B0`], [`${scope.source_file_id}-B0`, `${scope.source_file_id}-B0`], []]) expect((await post({ ...scope, kinds: ["need"], block_ids })).status).toBe(400);
    expect((await post({ ...scope, kinds: ["need"], cursor: "not-a-cursor" })).status).toBe(409);
  });
});

it("keeps malformed model responses and upstream dropped parse units explicitly incomplete", async () => {
  const scope = await fixture(["Need entity 0."]);
  await providerFixture(async request => request.system === NEED_PROPOSER_SYSTEM ? JSON.stringify({ wrong: [] }) : answer(request), async () => {
    const response = await post({ ...scope, kinds: ["need"] });
    expect(response.status).toBe(409);
    const output = await response.json();
    expect(output.source_progress).toMatchObject({ complete: false, processed_units: 0, failed_units: 1, next_cursor: expect.any(String) });
    expect(output.runs[0].rejected_candidates).toContainEqual({ index: 0, field: "response", reason: "malformed_response" });
    expect(await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).toEqual([]);
    expect(await extractionDownstreamState(scope.workspace_id, scope.source_file_id, output.extraction_batch_id)).toBe("incomplete");
    await expect(resumeExtractionBatch({ ...scope, batch_id: output.extraction_batch_id, merge_context: { org_id: "unused", actor: { name: "Reviewer", function: "heor" } }, execute: async () => "invalid" })).rejects.toMatchObject({ code: "source_incomplete" });
  });
  await persistDroppedUnits({ ...scope, units: [{ location: "slide 2", text: "Missing source fact", reason: "noise" }] });
  await providerFixture(answer, async () => {
    const response = await post({ ...scope, kinds: ["need"] });
    const output = await response.json();
    expect(response.status).toBe(409);
    expect(output.source_progress).toMatchObject({ complete: false, full_source_complete: false, next_cursor: null,
      upstream_dropped_units: [expect.objectContaining({ location: "slide 2", text: "Missing source fact", reason: "noise" })] });
    expect((await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).map(c => c.statement)).toEqual(["Need entity 0."]);
  });
});

it("validates source prompt configuration before starting extraction", async () => {
  const scope = await fixture(["Need entity 0."]);
  const previous = process.env.SYNAPSE_EXTRACT_PROMPT_CHARS;
  try {
    for (const value of ["abc", "9999", "200001", "10000.5"]) {
      process.env.SYNAPSE_EXTRACT_PROMPT_CHARS = value;
      expect((await post({ ...scope, kinds: ["need"] })).status).toBe(400);
    }
  } finally {
    if (previous === undefined) delete process.env.SYNAPSE_EXTRACT_PROMPT_CHARS; else process.env.SYNAPSE_EXTRACT_PROMPT_CHARS = previous;
  }
});

it("preserves distinct source entities sharing wording and reports indistinguishable identities", async () => {
  const scope = await fixture(["Need entity 0.", "Need entity 1."]);
  let duplicate = false;
  await providerFixture(async request => {
    if (request.system !== NEED_PROPOSER_SYSTEM) return answer(request);
    const raw = JSON.parse(await answer(request));
    const gaps = raw.gaps.map((g: { statement: string }) => ({ ...g, statement: "Need evidence." }));
    return JSON.stringify({ gaps: duplicate ? [gaps[0], gaps[0]] : gaps });
  }, async () => {
    const response = await post({ ...scope, kinds: ["need"] });
    expect(response.status).toBe(200);
    expect(await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).toHaveLength(2);
    duplicate = true;
    const ambiguous = await post({ ...scope, kinds: ["need"] });
    expect(ambiguous.status).toBe(409);
    const output = await ambiguous.json();
    expect(output.source_progress.complete).toBe(false);
    expect(output.runs[0].rejected_candidates).toEqual([0, 1].map(index => ({ index, field: "identity", reason: "ambiguous_source_identity" })));
  });
});

import { applyOmissionAction, getOmissionReviewsForRun, listBlockingOmissions } from "@/accuracy/store/omission-review-store";
import { editParseBlock } from "@/accuracy/store/parse-store";

it("keeps all completed page findings current until omission review resolves them", async () => {
  const scope = await fixture(["Need entity 0. " + "x".repeat(35000), "Need entity 1."]);
  await providerFixture(async request => {
    if (!request.system.startsWith("Compare every source block")) return answer(request);
    const input = JSON.parse(request.user);
    const first = input.blocks.find((b: { text: string }) => b.text.includes("Need entity 0."));
    return JSON.stringify({ checked_block_ids: input.blocks.map((b: { id: string }) => b.id),
      suspected_omissions: first ? [{ item_kind: "gap", summary: "A separate omitted entity", source_ref: { source_file_id: scope.source_file_id, block_id: first.id },
        evidence_quote: "Need entity 0.", basis: "explicit", reason: "Missing distinct fact", suggested_action: "Review" }] : [], prior_issue_resolutions: [] });
  }, async () => {
    const response = await post({ ...scope, kinds: ["need"] });
    expect(response.status).toBe(409);
    const output = await response.json();
    expect(output).toMatchObject({ paused: true, source_progress: { complete: true } });
    expect(output.runs.filter((r: { call_kind: string }) => r.call_kind === "need_extract")).toHaveLength(2);
    for (const run of output.runs) expect(await getOmissionReviewsForRun({ workspace_id: scope.workspace_id, run_id: run.run_id })).toMatchObject({ current: true });
    const blockers = await listBlockingOmissions(scope.workspace_id);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].run_id).toBe(output.runs[0].run_id);
    await applyOmissionAction({ workspace_id: scope.workspace_id, run_id: blockers[0].run_id, issue_id: blockers[0].issue.issue_id,
      action: "dismiss", reason: "Reviewed the separate entity", actor: { name: "Ada", function: "medical_affairs" }, idempotency_key: crypto.randomUUID() });
    const resumed = await post({ ...scope, action: "resume", extraction_batch_id: output.extraction_batch_id, idempotency_key: "after-review" });
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).claim_ids).toEqual(output.claim_ids);
  });
});

it("rejects a resume cursor after source edits and reuses strong source identities across revisions", async () => {
  const scope = await fixture(["Need entity 0. " + "x".repeat(35000)]);
  let fail = true;
  await providerFixture(async request => {
    if (request.system === NEED_PROPOSER_SYSTEM) {
      if (Number(request.user.match(/char_start=(\d+)/)?.[1]) > 0 && fail) throw new Error("Interrupted page");
      const raw = JSON.parse(await answer(request));
      raw.gaps = raw.gaps.map((g: object) => ({ ...g, external_id: "NSCLC_CE_01" }));
      return JSON.stringify(raw);
    }
    return answer(request);
  }, async () => {
    const first = await (await post({ ...scope, kinds: ["need"] })).json();
    const original = (await listActiveSourceClaims(scope.workspace_id, scope.source_file_id))[0];
    const blocks = await readParseBlocks(scope.workspace_id, scope.source_file_id);
    await editParseBlock({ workspace_id: scope.workspace_id, block_id: blocks[0].id, text: blocks[0].text + " revised", rationale: "Source corrected", actor: { name: "Ada", function: "medical_affairs" } });
    const stale = await post({ ...scope, kinds: ["need"], cursor: first.source_progress.next_cursor });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_batch" });
    fail = false;
    const next = await post({ ...scope, kinds: ["need"] });
    expect(next.status).toBe(200);
    expect((await next.json()).claim_ids).toEqual([original.id]);
    expect(await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).toHaveLength(1);
  });
});


it("does not mark inventory pages complete when the model completeness check fails", async () => {
  const scope = await fixture(["Registry activity is described."]);
  await providerFixture(async request => {
    expect(accuracyTransactionActive()).toBe(false);
    if (request.system === INVENTORY_PROPOSER_SYSTEM) return JSON.stringify({ tactics: [] });
    if (request.system.startsWith("Compare every source block")) return JSON.stringify({ unchecked: true });
    return answer(request);
  }, async () => {
    const response = await post({ ...scope, kinds: ["inventory"] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ incomplete: true, source_progress: { complete: false, failed_units: 1 } });
  });
});

import { runAccuracyExperiment } from "@/accuracy/experiments/run";

it("uses the same complete pages in the isolated experiment pipeline", async () => {
  const scope = await fixture(Array.from({ length: 90 }, (_, i) => `Need entity ${i}. ` + "padding ".repeat(80)));
  await providerFixture(async request => request.system === INVENTORY_PROPOSER_SYSTEM ? JSON.stringify({ tactics: [] }) : answer(request), async () => {
    const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: scope.workspace_id, source_file_ids: [scope.source_file_id],
      pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "Ada", function: "medical_affairs" } });
    expect(experiment.status).toBe("completed");
    const needCalls = experiment.calls.filter(call => call.call_kind === "need_extract");
    expect(new Set(needCalls.map(call => call.call_id)).size).toBeGreaterThan(1);
    const copiedSource = (needCalls[0].input as { source_file_id: string }).source_file_id;
    expect(await listActiveSourceClaims(experiment.workspace_id, copiedSource)).toHaveLength(90);
    expect(await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).toEqual([]);
  });
});

import { listClaims } from "@/accuracy/store/claim-store";

it("retains original offsets and stable source identities after downstream merges", async () => {
  const scope = await fixture(["Need entity 0. Need entity 1."]);
  const block_id = `${scope.source_file_id}-B0`;
  await providerFixture(async request => {
    expect(accuracyTransactionActive()).toBe(false);
    if (request.system === NEED_PROPOSER_SYSTEM) return JSON.stringify({ gaps: ["Need survival.", "Survival evidence needed."].map((statement, index) => ({ statement, external_id: null,
      provenance: [{ source_file_id: scope.source_file_id, block_id, quote: `Need entity ${index}.` }] })) });
    if (request.system.startsWith("You are the dedupe judge")) return JSON.stringify({ decisions: [...request.user.matchAll(/### pair_id=(\S+)/g)].map(m => ({ pair_id: m[1], same: true, rationale: "Same sourced survival entity" })) });
    return answer(request);
  }, async () => {
    const first = await (await post({ ...scope, kinds: ["need"] })).json();
    const active = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    expect(active).toHaveLength(1);
    expect((claimMetadata(active[0]).provenance as { char_start: number }[]).map(p => p.char_start).sort((a, b) => a - b)).toEqual([0, 15]);
    expect(first.claim_ids).toEqual([active[0].id]);
    const before = await listClaims(scope.workspace_id);
    await updateClaim({ workspace_id: scope.workspace_id, claim_id: active[0].id, patch: { statement: "Human survival wording" }, rationale: "Reviewed", actor: { name: "Ada", function: "medical_affairs" } });
    const rerun = await post({ ...scope, kinds: ["need"] });
    expect(rerun.status).toBe(200);
    const output = await rerun.json();
    expect(output.claim_ids).toEqual(first.claim_ids);
    expect(output.merge.merged).toBe(0);
    expect(await listClaims(scope.workspace_id)).toHaveLength(before.length);
    expect((await getClaim(scope.workspace_id, active[0].id))!.statement).toBe("Human survival wording");
  });
});

it("retains facts and quotes from accepted pages when a later page describes the same source entity", async () => {
  const scope = await fixture(["Registry owned by Ada. " + "x".repeat(40000) + " Registry still running."]);
  const block_id = `${scope.source_file_id}-B0`;
  await providerFixture(async request => {
    if (request.system !== INVENTORY_PROPOSER_SYSTEM) return answer(request);
    const first = request.user.includes("Registry owned by Ada.");
    const span = { source_file_id: scope.source_file_id, block_id, quote: first ? "Registry owned by Ada." : "Registry still running." };
    return JSON.stringify({ tactics: [{ name: "Registry R", external_id: "NCT00000001", type: "registry", status: "unknown", evidence_question: "Survival?", provenance: [span],
      ...(first ? { structured: { version: 1, owner: { state: "known", value: "Ada", provenance: [span] } } } : {}) }] });
  }, async () => {
    const response = await post({ ...scope, kinds: ["inventory"] });
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output.claim_ids).toHaveLength(1);
    const claims = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    expect(claims).toHaveLength(1);
    expect(claimMetadata(claims[0]).structured).toMatchObject({ owner: { state: "known", value: "Ada" } });
    expect(claimMetadata(claims[0]).provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ quote: "Registry owned by Ada.", char_start: 0 }),
      expect.objectContaining({ quote: "Registry still running.", char_start: 40024 }),
    ]));
  });
});

import { setAiEnabled } from "@/modules/kernel/ai-switch";

import { captureMergeInputs } from "@/accuracy/modules/merge-dedupe/module";

it.each(["unknown", "completed"])("keeps accepted lifecycle mirrors consistent when the later inventory page says %s", async laterStatus => {
  const scope = await fixture(["Registry ongoing. " + "x".repeat(40000) + " Registry later description."]);
  await providerFixture(async request => {
    if (request.system !== INVENTORY_PROPOSER_SYSTEM) return answer(request);
    const first = request.user.includes("Registry ongoing.");
    return JSON.stringify({ tactics: [{ name: "Registry R", external_id: "NCT00000001", type: "registry", status: first ? "ongoing" : laterStatus,
      evidence_question: "Survival?", provenance: [{ source_file_id: scope.source_file_id, block_id: `${scope.source_file_id}-B0`, quote: first ? "Registry ongoing." : "Registry later description." }] }] });
  }, async () => {
    expect((await post({ ...scope, kinds: ["inventory"] })).status).toBe(200);
    const [saved] = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    expect(claimMetadata(saved).structured).toMatchObject({ lifecycle: { state: "known", value: "ongoing" } });
    expect(claimMetadata(saved).tactic_status).toBe("ongoing");
    expect(saved.status).toBe("ongoing");
    expect(claimMetadata(saved).extraction_suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ tactic_status: laterStatus })]));
    const downstream = await captureMergeInputs(scope.workspace_id);
    expect(downstream.candidates.find(c => c.id === saved.id)?.tactic_status).toBe("ongoing");
  });
});

it("refuses an older overlapping page before it writes after a newer same-kind selection completes", async () => {
  const scope = await fixture(["Need entity 0."]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let proposals = 0;
  await providerFixture(async request => {
    if (request.system !== NEED_PROPOSER_SYSTEM) return answer(request);
    const older = proposals++ === 0;
    if (older) { entered(); await gate; }
    return JSON.stringify({ gaps: [{ statement: older ? "Older wording" : "Newer wording", external_id: "NSCLC_CE_01",
      provenance: [{ source_file_id: scope.source_file_id, block_id: `${scope.source_file_id}-B0`, quote: "Need entity 0." }] }] });
  }, async () => {
    const body = { ...scope, kinds: ["need"], block_ids: [`${scope.source_file_id}-B0`] };
    const older = post(body);
    try {
      await started;
      const newer = await post(body);
      expect(newer.status).toBe(200);
      const output = await newer.json();
      const before = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
      release();
      const stale = await older;
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "stale_batch" });
      expect(await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).toEqual(before);
      const replay = await post({ ...scope, action: "resume", extraction_batch_id: output.extraction_batch_id, idempotency_key: "newer-replay" });
      expect(replay.status).toBe(200);
      expect((await replay.json()).claim_ids).toEqual(output.claim_ids);
    } finally { release(); await older; }
  });
});

it.each(["selection", "kind"])("allows concurrent independent extraction %s coverage", async independent => {
  const scope = await fixture(["Need entity 0.", "Need entity 1."]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let proposals = 0;
  await providerFixture(async request => {
    if (request.system === INVENTORY_PROPOSER_SYSTEM) return JSON.stringify({ tactics: [] });
    if (request.system === NEED_PROPOSER_SYSTEM && proposals++ === 0) { entered(); await gate; }
    return answer(request);
  }, async () => {
    const older = post({ ...scope, kinds: ["need"], block_ids: [`${scope.source_file_id}-B0`] });
    try {
      await started;
      const newer = await post({ ...scope, kinds: [independent === "kind" ? "inventory" : "need"], block_ids: [`${scope.source_file_id}-B${independent === "kind" ? 0 : 1}`] });
      expect(newer.status).toBe(200);
      const completed = await newer.json();
      release();
      expect((await older).status).toBe(200);
      expect(await extractionDownstreamState(scope.workspace_id, scope.source_file_id, completed.extraction_batch_id)).toBe("completed");
      expect((await listActiveSourceClaims(scope.workspace_id, scope.source_file_id)).map(c => c.statement).sort()).toEqual(independent === "kind" ? ["Need entity 0."] : ["Need entity 0.", "Need entity 1."]);
    } finally { release(); await older; }
  });
});

it.each([false, true])("keeps untouched omissions and refuses unsuccessful replacement coverage (source revised=%s)", async revised => {
  const scope = await fixture(["Need entity 0.", "Need entity 1."]);
  let phase: "initial" | "success" | "incomplete" | "failure" = "initial";
  await providerFixture(async request => {
    if (request.system === NEED_PROPOSER_SYSTEM && phase === "failure") throw new Error("Provider replacement unavailable");
    if (!request.system.startsWith("Compare every source block")) return answer(request);
    const input = JSON.parse(request.user);
    return JSON.stringify({ checked_block_ids: phase === "incomplete" ? [] : input.blocks.map((b: { id: string }) => b.id),
      suspected_omissions: phase === "initial" ? input.blocks.map((b: { id: string; text: string }) => ({ item_kind: "gap", summary: `Omitted ${b.id}`,
        source_ref: { source_file_id: scope.source_file_id, block_id: b.id }, evidence_quote: b.text, basis: "explicit", reason: "Missing separate fact", suggested_action: "Review" })) : [], prior_issue_resolutions: [] });
  }, async () => {
    expect((await post({ ...scope, kinds: ["need"] })).status).toBe(409);
    const original = await listBlockingOmissions(scope.workspace_id);
    expect(original).toHaveLength(2);
    if (revised) await editParseBlock({ workspace_id: scope.workspace_id, block_id: `${scope.source_file_id}-B1`, text: "Need entity 1. Revised.", rationale: "Source correction", actor: { name: "Ada", function: "medical_affairs" } });
    phase = "success";
    const selectedB = await post({ ...scope, kinds: ["need"], block_ids: [`${scope.source_file_id}-B1`] });
    expect(selectedB.status).toBe(409);
    expect(await selectedB.json()).toMatchObject({ paused: true });
    const remaining = original.filter(item => item.issue.source_ref.block_id.endsWith("B0"));
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual(remaining);
    const replaced = original.find(item => item.issue.source_ref.block_id.endsWith("B1"))!;
    await expect(applyOmissionAction({ workspace_id: scope.workspace_id, run_id: replaced.run_id, issue_id: replaced.issue.issue_id,
      action: "dismiss", reason: "Historical finding", actor: { name: "Ada", function: "medical_affairs" }, idempotency_key: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    for (const next of ["incomplete", "failure"] as const) {
      phase = next;
      expect((await post({ ...scope, kinds: ["need"], block_ids: [`${scope.source_file_id}-B0`] })).status).toBe(409);
      expect(await listBlockingOmissions(scope.workspace_id)).toEqual(remaining);
    }
    phase = "success";
    expect((await post({ ...scope, kinds: ["need"], block_ids: [`${scope.source_file_id}-B0`] })).status).toBe(200);
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
  });
});

it("supersedes only successful replacement pages while a later page remains failed", async () => {
  const scope = await fixture(["Need entity 0. " + "x".repeat(35000), "Need entity 1."]);
  let initial = true, failSecond = false;
  await providerFixture(async request => {
    if (request.system === NEED_PROPOSER_SYSTEM && failSecond && request.user.includes("Need entity 1.")) throw new Error("Second replacement page failed");
    if (!request.system.startsWith("Compare every source block")) return answer(request);
    const input = JSON.parse(request.user);
    return JSON.stringify({ checked_block_ids: input.blocks.map((b: { id: string }) => b.id),
      suspected_omissions: initial ? input.blocks.flatMap((b: { id: string; text: string }) => {
        const quote = b.text.match(/Need entity \d+\./)?.[0];
        return quote ? [{ item_kind: "gap", summary: `Separate omitted ${quote}`, source_ref: { source_file_id: scope.source_file_id, block_id: b.id },
          evidence_quote: quote, basis: "explicit", reason: "Separate fact missing", suggested_action: "Review" }] : [];
      }) : [], prior_issue_resolutions: [] });
  }, async () => {
    expect((await post({ ...scope, kinds: ["need"] })).status).toBe(409);
    const original = await listBlockingOmissions(scope.workspace_id);
    expect(original).toHaveLength(2);
    initial = false; failSecond = true;
    const replacement = await post({ ...scope, kinds: ["need"] });
    expect(replacement.status).toBe(409);
    const checkpoint = await replacement.json();
    expect(checkpoint).toMatchObject({ incomplete: true, source_progress: { complete: false } });
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual(original.filter(item => item.issue.source_ref.block_id.endsWith("B1")));
    failSecond = false;
    expect((await post({ ...scope, kinds: ["need"], cursor: checkpoint.source_progress.next_cursor })).status).toBe(200);
    expect(await listBlockingOmissions(scope.workspace_id)).toEqual([]);
  });
});

it("derives all lifecycle mirrors after restoring a nested human lifecycle lock", async () => {
  const scope = await fixture(["Registry ongoing. Registry planned."]);
  const span = { source_file_id: scope.source_file_id, block_id: `${scope.source_file_id}-B0`, quote: "Registry planned." };
  await providerFixture(async request => request.system === INVENTORY_PROPOSER_SYSTEM ? JSON.stringify({ tactics: [{ name: "Registry R", external_id: "NCT00000001",
    type: "registry", status: "ongoing", evidence_question: "Survival?", provenance: [{ ...span, quote: "Registry ongoing." }] }] }) : answer(request), async () => {
    expect((await post({ ...scope, kinds: ["inventory"] })).status).toBe(200);
    const [original] = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    await updateClaim({ workspace_id: scope.workspace_id, claim_id: original.id, patch: { structured: { lifecycle: { state: "known", value: "planned", provenance: [span] } } },
      rationale: "Reviewed planned lifecycle", actor: { name: "Ada", function: "medical_affairs" } });
    expect((await post({ ...scope, kinds: ["inventory"] })).status).toBe(200);
    const [saved] = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
    expect(saved).toMatchObject({ id: original.id, status: "planned" });
    expect(claimMetadata(saved)).toMatchObject({ tactic_status: "planned", structured: { lifecycle: { state: "known", value: "planned" } } });
    expect((await captureMergeInputs(scope.workspace_id)).candidates.find(c => c.id === saved.id)?.tactic_status).toBe("planned");
  });
});

it("serializes a real source edit behind page publication through evidence insertion", async () => {
  const scope = await fixture(["Need entity 0."]);
  const observer = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
  const barrier = await observer.reserve();
  const name = `task3_barrier_${crypto.randomUUID().replaceAll("-", "")}`;
  const lock = `task3:${name}`;
  const [{ pid: barrierPid }] = await barrier`select pg_backend_pid() as pid`;
  await observer.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin
    if NEW.workspace_id = '${scope.workspace_id}' then perform pg_advisory_xact_lock(hashtextextended('${lock}', 0)); end if;
    return NEW; end $$`);
  await observer.unsafe(`create trigger ${name} before insert on accuracy_claims for each row execute function ${name}()`);
  await barrier`select pg_advisory_lock(hashtextextended(${lock}, 0))`;
  try {
    await providerFixture(answer, async () => {
      const pending = post({ ...scope, kinds: ["need"] });
      let edit: Promise<{ value?: unknown; error?: unknown }> | undefined;
      let editSettled = false;
      try {
        let publisherPid = 0;
        await vi.waitFor(async () => {
          const rows = await observer`select pid from pg_stat_activity where ${barrierPid} = any(pg_blocking_pids(pid))`;
          expect(rows).toHaveLength(1);
          publisherPid = rows[0].pid;
        }, { timeout: 5000, interval: 10 });
        edit = editParseBlock({ workspace_id: scope.workspace_id, block_id: `${scope.source_file_id}-B0`, text: "Quote removed by source correction.",
          rationale: "Source correction", actor: { name: "Ada", function: "medical_affairs" } }).then(value => { editSettled = true; return { value }; }, error => { editSettled = true; return { error }; });
        await vi.waitFor(async () => {
          if (editSettled) return;
          const rows = await observer`select pid from pg_stat_activity where ${publisherPid} = any(pg_blocking_pids(pid))`;
          expect(rows.length).toBeGreaterThan(0);
        }, { timeout: 5000, interval: 10 });
        await barrier`select pg_advisory_unlock(hashtextextended(${lock}, 0))`;
        const outcome = await edit;
        expect(outcome.error).toMatchObject({ name: "ProvenanceConflictError" });
        expect((await readParseBlocks(scope.workspace_id, scope.source_file_id))[0].text).toBe("Need entity 0.");
        const [claim] = await listActiveSourceClaims(scope.workspace_id, scope.source_file_id);
        expect(claimMetadata(claim).provenance).toEqual([expect.objectContaining({ quote: "Need entity 0." })]);
        expect((await pending).status).toBe(200);
      } finally {
        await barrier`select pg_advisory_unlock(hashtextextended(${lock}, 0))`;
        await pending;
        if (edit) await edit;
      }
    });
  } finally {
    await barrier`select pg_advisory_unlock(hashtextextended(${lock}, 0))`;
    barrier.release();
    await observer.unsafe(`drop trigger if exists ${name} on accuracy_claims`);
    await observer.unsafe(`drop function if exists ${name}()`);
    await observer.end({ timeout: 5 });
  }
});

it("preserves the AI-off response when the switch changes during extraction", async () => {
  const scope = await fixture(["Need entity 0. " + "x".repeat(35000)]);
  let checks = 0;
  await providerFixture(async request => {
    const result = await answer(request);
    if (request.system.startsWith("Compare every source block") && ++checks === 1) await setAiEnabled({ enabled: false, actor_name: "test" });
    return result;
  }, async () => {
    try {
      const response = await post({ ...scope, kinds: ["need"] });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "ai_off", incomplete: true, source_progress: { complete: false } });
    } finally { await setAiEnabled({ enabled: true, actor_name: "restore" }); }
  });
});
