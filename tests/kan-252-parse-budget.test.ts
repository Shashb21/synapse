/** End-to-end parse accounting using fictional text, scripted HTTP and in-memory telemetry. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWithLlm } from "@/lib/ingest/llm-structure";
import type { ResolvedRoute, RunHandle } from "@/modules/kernel/contracts";
import { prepareReference } from "@/modules/development/documents";
import * as ai from "@/modules/kernel/ai-switch";
import { noAiSections } from "@/modules/kernel/ai-sections";
import * as routing from "@/modules/kernel/routing";
import { completionFor } from "@/modules/kernel/routing";
import { RETRY } from "@/modules/llm/provider";

vi.mock("unpdf", () => ({ getDocumentProxy: vi.fn(), extractText: async () => ({ text: [source] }) }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn<(statement: SQL) => Promise<void>>() }));
vi.mock("@/modules/kernel/db", () => ({ sharedDb: () => ({ execute }) }));

function recordedCalls() {
  const dialect = new PgDialect();
  return execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement))
    .filter(query => query.sql.includes("insert into llm_calls"));
}
const route: ResolvedRoute = {
  stage: "S1", provider_id: "openai", provider_label: "OpenAI", model: "gpt-5.1",
  auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 300 },
  fallbacks: [], degraded: false, reason: null,
};
const run: RunHandle = { id: "fixture", step: async (_name, fn) => fn(), note: vi.fn(), steps: () => [] };
const source = "The fictional panel requested a cost estimate.";
const structure = { units: [{ unit: "u1", blocks: [{ text: source, kind: "paragraph" }] }] };
const classification = { stakeholder_function: "market_access", rationale: "The panel reviews cost." };

function parse(text = source) {
  return parseWithLlm({ filename: "fictional.txt", buffer: Buffer.from(text), ask: completionFor(route, run) });
}

function scriptedRequests(limit: number, replies: unknown[]) {
  vi.stubEnv("SYNAPSE_MAX_PARSE_CALLS", String(limit));
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
    if (!replies.length) throw new Error("Unexpected outbound request");
    const reply = replies.shift();
    if (reply instanceof Response) return reply;
    if (reply === 503) return new Response("Busy", { status: 503 });
    const content = typeof reply === "string" ? reply : JSON.stringify(reply);
    return Response.json({ choices: [{ message: { content } }] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  execute.mockClear();
  vi.stubEnv("OPENAI_API_KEY", "fictional-test-key");
  vi.spyOn(RETRY, "sleep").mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("S1 per-document request limit", () => {
  it("finishes at the limit across HTTP retry, JSON repair, and incomplete answers in both steps", async () => {
    const fetch = scriptedRequests(6, [503, "invalid JSON", {}, structure, {}, classification]);
    await expect(parse()).resolves.toMatchObject({ document: { stakeholder_function: "market_access" } });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each<[string, unknown[]]>([
    ["HTTP retry", [503, 503]],
    ["JSON repair", ["invalid JSON", "invalid JSON"]],
    ["missing units", [{}, {}]],
    ["classification", [{}, structure]],
    ["incomplete classification", [structure, {}]],
  ])("stops before the next %s request", async (_layer, replies) => {
    const fetch = scriptedRequests(2, replies);
    await expect(parse()).rejects.toMatchObject({ code: "parse_limit", message: expect.stringContaining("2") });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([307, 308])("prevents automatic HTTP %i redirect sends for budgeted calls only", async status => {
    const fetch = scriptedRequests(2, [Response.redirect("https://fictional.invalid/endpoint", status), {}]);
    await expect(parse()).rejects.toMatchObject({ status });
    expect(fetch.mock.calls[0]?.[1].redirect).toBe("manual");
    await completionFor(route, run)({ system: "fixture", user: "fixture", purpose: "outside-parse" });
    expect(fetch.mock.calls[1]?.[1].redirect).toBeUndefined();
  });

  it("records the final upstream failure safely and skips the blocked send", async () => {
    const responseBody = "private fictional provider details fictional-test-key";
    const fetch = scriptedRequests(2, [structure, new Response(responseBody, { status: 503 })]);
    await expect(parse()).rejects.toMatchObject({ code: "parse_limit" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const records = recordedCalls();
    expect(records).toHaveLength(2);
    const last = JSON.stringify(records[1]?.params);
    expect(last).toMatch(/limit of 2 model calls/);
    expect(last).toMatch(/503/);
    expect(last).toMatch(/unavailable/);
    expect(last).not.toContain("private fictional");
    expect(last).not.toContain("fictional-test-key");
  });

  it("only records dispatched requests when classification is blocked before sending", async () => {
    const fetch = scriptedRequests(2, [{}, structure]);
    await expect(parse()).rejects.toMatchObject({ code: "parse_limit" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recordedCalls()).toHaveLength(2);
    expect(recordedCalls().flatMap(query => query.params)).not.toContain("parse-stakeholder");
  });

  it("shares retry consumption across multiple structure groups and classification", async () => {
    const first = source.repeat(160);
    const second = "Long fictional panel observations. ".repeat(180);
    const firstStructure = { units: [{ unit: "u1", blocks: [{ text: first, kind: "paragraph" }] }] };
    const fetch = scriptedRequests(3, [{}, firstStructure, {
      units: [{ unit: "u2", blocks: [{ text: second.trim(), kind: "paragraph" }] }],
    }]);
    await expect(parse(`${first}\n\n${second}`)).rejects.toMatchObject({ code: "parse_limit" });
    const promptedUnits = fetch.mock.calls.map(([, init]) => {
      const prompt = JSON.parse(String(init.body)).messages[1].content;
      return JSON.parse(prompt).units.map((unit: { unit: string }) => unit.unit);
    });
    expect(promptedUnits).toEqual([["u1"], ["u1"], ["u2"]]);
  });

  it("enforces the upload limit on private PDF reference expectation extraction", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    vi.spyOn(ai, "aiSections").mockResolvedValue({ ...noAiSections(), ingestion: true });
    vi.spyOn(routing, "resolveRoute").mockResolvedValue(route);
    const fetch = scriptedRequests(2, [structure, classification]);
    await expect(prepareReference({
      id: "fixture", name: "Fixture", source_workspace_id: null, owner: "tester",
      revision: 1, status: "draft", created_at: "", updated_at: "", documents: [],
    }, "tester", {
      filename: "fictional.pdf", content_base64: Buffer.from("%PDF-fictional").toString("base64"),
      format: "pdf", section: "gap_extraction", source_document_ids: [],
    })).rejects.toMatchObject({ status: 422, code: "parse_limit" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("starts each new document with its own allowance", async () => {
    const fetch = scriptedRequests(2, [structure, classification, structure, classification]);
    await parse();
    await parse();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("refuses before sending when even the structure and classification cannot fit", async () => {
    const fetch = scriptedRequests(1, []);
    await expect(parse()).rejects.toMatchObject({ code: "parse_limit" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
