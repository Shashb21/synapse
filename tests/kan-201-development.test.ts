/** Owner API integration proofs against the isolated KAN-201 database. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { canonicalParsedJson } from "@/modules/development/documents";
import * as owner from "@/modules/auth/owner";
import { GET as list, POST as create } from "@/app/api/admin/development/route";
import {
  GET as get,
  PATCH as save,
} from "@/app/api/admin/development/[id]/route";
import { POST as upload } from "@/app/api/admin/development/[id]/source-upload/route";
import { POST as reference } from "@/app/api/admin/development/[id]/reference-upload/route";
import { GET as bytes } from "@/app/api/admin/development/[id]/documents/[documentId]/route";
import {
  POST as importSource,
  GET as sources,
} from "@/app/api/admin/development/[id]/sources/route";
import { db, sharedDb } from "@/lib/iegp/db";
import { sql } from "drizzle-orm";
import { createWorkspace } from "@/modules/workspaces/store";
import { runInWorkspace } from "@/modules/workspaces/context";
import { setAiSection } from "@/modules/kernel/ai-switch";
import * as parsing from "@/lib/ingest/llm-structure";
import * as llm from "@/modules/kernel/llm";
import * as routing from "@/modules/kernel/routing";
import { NoRouteError } from "@/modules/llm/provider";
import { GET as workspaces } from "@/app/api/admin/development/workspaces/route";
import { MAX_UPLOAD_BYTES } from "@/lib/ingest/upload-formats";
const req = (body: unknown) =>
  new Request("http://localhost/api/admin/development", {
    method: "POST",
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const encoded = (text: string) => Buffer.from(text).toString("base64");
async function draft(workspace: string | null = null) {
  const response = await create(
    req({ name: "Draft proof", source_workspace_id: workspace }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).experiment;
}
afterEach(() => vi.restoreAllMocks());
describe("KAN-201 owner Development setup", () => {
  it("creates, lists, saves and reopens with stale writes refused", async () => {
    const initial = await draft();
    expect(
      (await (await list()).json()).experiments.some(
        (e: { id: string }) => e.id === initial.id,
      ),
    ).toBe(true);
    const updated = await save(
      req({ name: "Renamed", revision: initial.revision }),
      ctx(initial.id),
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).experiment.revision).toBe(2);
    expect(
      (await (await get(req({}), ctx(initial.id))).json()).experiment.name,
    ).toBe("Renamed");
    expect(
      (await save(req({ name: "Lost update", revision: 1 }), ctx(initial.id)))
        .status,
    ).toBe(409);
  });
  it("retains original and parsed identities privately, with separate structured evaluator references", async () => {
    const initial = await draft();
    const before = await sharedDb().execute(
      sql`select * from platform_settings order by key`,
    );
    const response = await upload(
      req({
        revision: 1,
        filename: "source.txt",
        content_base64: encoded("Need survival evidence"),
      }),
      ctx(initial.id),
    );
    expect(response.status).toBe(200);
    const experiment = (await response.json()).experiment;
    const source = experiment.documents[0];
    expect(source.role).toBe("source");
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.parsed_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.content_base64).toBeUndefined();
    const original = await bytes(req({}), {
      params: Promise.resolve({ id: initial.id, documentId: source.id }),
    });
    expect((await original.json()).content_base64).toBe(
      encoded("Need survival evidence"),
    );
    const payload = {
      version: 1,
      section: "gap_extraction",
      source_document_ids: [source.id],
      expected_answers: [
        {
          id: " g1 ",
          statement: " Need survival evidence ",
          source_document_id: ` ${source.id} `,
          quote: " Need survival evidence ",
        },
      ],
    };
    const ref = await reference(
      req({
        revision: 2,
        filename: "gold.json",
        content_base64: encoded(JSON.stringify(payload)),
        format: "structured",
        section: "gap_extraction",
        source_document_ids: [source.id],
      }),
      ctx(initial.id),
    );
    expect(ref.status).toBe(200);
    const gold = (await ref.json()).experiment.documents.find(
      (d: { role: string }) => d.role === "reference",
    );
    expect(gold.review_status).toBe("unreviewed");
    expect(gold.compatibility).toBe("compatible");
    expect(gold.section).toBe("gap_extraction");
    expect(gold.parsed.expected_answers).toEqual([
      {
        id: "g1",
        statement: "Need survival evidence",
        source_document_id: source.id,
        quote: "Need survival evidence",
      },
    ]);
    const referenceBytes = await bytes(req({}), {
      params: Promise.resolve({ id: initial.id, documentId: gold.id }),
    });
    expect((await referenceBytes.json()).content_base64).toBe(
      encoded(JSON.stringify(payload)),
    );
    expect(
      await sharedDb().execute(
        sql`select * from platform_settings order by key`,
      ),
    ).toEqual(before);
    expect(
      (await (await sources(req({}), ctx(initial.id))).json()).sources,
    ).toEqual([]);
  });
  it("reproduces the parsed identity from a reopened persisted payload", async () => {
    const initial = await draft();
    const response = await upload(
      req({
        revision: 1,
        filename: "source.txt",
        content_base64: encoded("Evidence"),
      }),
      ctx(initial.id),
    );
    expect(response.status).toBe(200);
    const reopened = (await (await get(req({}), ctx(initial.id))).json())
      .experiment;
    const source = reopened.documents[0];
    const recomputed = createHash("sha256")
      .update(canonicalParsedJson(source.parsed), "utf8")
      .digest("hex");
    expect(source.parsed_sha256).toBe(recomputed);
  });
  it("canonicalizes nested JSON object order while retaining array order and JSON value semantics", () => {
    const first = { z: [{ b: 2, a: 1 }, null], a: { y: undefined, x: "é" } };
    const second = { a: { x: "é" }, z: [{ a: 1, b: 2 }, null] };
    const serialized = '{"a":{"x":"é"},"z":[{"a":1,"b":2},null]}';
    expect(canonicalParsedJson(first)).toBe(serialized);
    expect(canonicalParsedJson(second)).toBe(serialized);
    const expectedHash = createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex");
    for (const value of [first, second]) {
      expect(
        createHash("sha256")
          .update(canonicalParsedJson(value), "utf8")
          .digest("hex"),
      ).toBe(expectedHash);
    }
    expect(canonicalParsedJson([undefined, Number.NaN, null])).toBe(
      "[null,null,null]",
    );
    expect(canonicalParsedJson({ "2": true, "10": false })).toBe(
      '{"10":false,"2":true}',
    );
    expect(canonicalParsedJson([2, 1])).toBe("[2,1]");
    expect(() => canonicalParsedJson(undefined)).toThrow(TypeError);
  });
  it("validates all input, references and body limits without consuming revisions", async () => {
    expect(
      (await create(req({ name: "", source_workspace_id: null }))).status,
    ).toBe(400);
    expect(
      (
        await create(
          new Request("http://localhost", { method: "POST", body: "{" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await create(req({ name: "x", source_workspace_id: "missing" }))).status,
    ).toBe(404);
    const initial = await draft();
    for (const content_base64 of ["!!!", "", encoded("   ")]) {
      expect([400, 422]).toContain(
        (
          await upload(
            req({ revision: 1, filename: "source.txt", content_base64 }),
            ctx(initial.id),
          )
        ).status,
      );
    }
    expect(
      (
        await upload(
          req({ revision: 1, filename: "x.exe", content_base64: encoded("x") }),
          ctx(initial.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await upload(
          req({
            revision: 1,
            filename: "x.txt",
            content_base64: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString(
              "base64",
            ),
          }),
          ctx(initial.id),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await reference(
          req({
            revision: 1,
            filename: "gold.json",
            content_base64: encoded("{}"),
            format: "structured",
            section: "gap_extraction",
            source_document_ids: ["foreign"],
          }),
          ctx(initial.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (await (await get(req({}), ctx(initial.id))).json()).experiment.revision,
    ).toBe(1);
  });
  it("snapshots only the bound workspace and refuses unparsed customer sources", async () => {
    const w = await createWorkspace({
      name: "KAN-201 source",
      owner: "kan201@test.invalid",
    });
    const other = await createWorkspace({
      name: "KAN-201 other",
      owner: "kan201@test.invalid",
    });
    const initial = await draft(w.id);
    const insert = async (id: string, text: string, parsed: boolean) =>
      runInWorkspace(
        { workspace_id: w.id, schema: w.schema_name },
        async () => {
          await db().execute(
            sql`insert into source_files (id,workspace_id,filename,title,source_type,stakeholder_function,mime,bytes,checksum,content_base64,status,uploaded_by,uploaded_at) values (${id},${w.id},'customer.txt','Customer','text','medical_affairs','text/plain',${text.length},'checksum',${encoded(text)},'uploaded','customer',${new Date().toISOString()})`,
          );
          if (parsed)
            await db().execute(
              sql`insert into parsed_documents (id,file_id,source_id,parser,parser_version,blocks,quality,parsed_at,duration_ms) values (${id},${id},${id},'llm','2.0.0',${JSON.stringify([{ id: "b1", text, location: "p.1" }])}::jsonb,'{}',${new Date().toISOString()},1)`,
            );
        },
      );
    await insert("kan201-parsed", "Customer evidence", true);
    await insert("kan201-unparsed", "Unparsed", false);
    const before = await runInWorkspace(
      { workspace_id: w.id, schema: w.schema_name },
      async () =>
        await db().execute(sql`select * from source_files order by id`),
    );
    expect(
      (
        await importSource(
          req({ revision: 1, source_file_id: "kan201-unparsed" }),
          ctx(initial.id),
        )
      ).status,
    ).toBe(422);
    const imported = await importSource(
      req({ revision: 1, source_file_id: "kan201-parsed" }),
      ctx(initial.id),
    );
    expect(imported.status).toBe(200);
    expect((await imported.json()).experiment.documents[0].parser.version).toBe(
      "2.0.0",
    );
    const mismatched = await draft(other.id);
    expect(
      (
        await importSource(
          req({ revision: 1, source_file_id: "kan201-parsed" }),
          ctx(mismatched.id),
        )
      ).status,
    ).toBe(404);
    expect(
      await runInWorkspace(
        { workspace_id: w.id, schema: w.schema_name },
        async () =>
          await db().execute(sql`select * from source_files order by id`),
      ),
    ).toEqual(before);
  });
  it("checks ingestion AI-off policy before even test-stub parsing", async () => {
    const initial = await draft();
    await setAiSection({
      section: "ingestion",
      enabled: false,
      actor_name: "test",
    });
    try {
      expect(
        (
          await upload(
            req({
              revision: 1,
              filename: "x.txt",
              content_base64: encoded("Evidence"),
            }),
            ctx(initial.id),
          )
        ).status,
      ).toBe(409);
    } finally {
      await setAiSection({
        section: "ingestion",
        enabled: true,
        actor_name: "test",
      });
    }
  });
  it("keeps readable PDF gold provisional and incompatible without valid expected answers", async () => {
    const initial = await draft();
    const uploaded = await upload(
      req({
        revision: 1,
        filename: "source.txt",
        content_base64: encoded("Original source"),
      }),
      ctx(initial.id),
    );
    const source = (await uploaded.json()).experiment.documents[0];
    vi.spyOn(parsing, "extractRawUnits").mockResolvedValue([
      {
        text: "Expert expected findings",
        location: { kind: "page", ref: "p.1" },
      },
    ]);
    const response = await reference(
      req({
        revision: 2,
        filename: "gold.pdf",
        content_base64: encoded("%PDF-1.7 expert fixture"),
        format: "pdf",
        section: "gap_extraction",
        source_document_ids: [source.id],
      }),
      ctx(initial.id),
    );
    expect(response.status).toBe(200);
    const gold = (await response.json()).experiment.documents.find(
      (document: { role: string }) => document.role === "reference",
    );
    expect(gold.review_status).toBe("provisional");
    expect(gold.compatibility).toBe("incompatible");
    expect(gold.parsed.document.blocks[0].text).toBe(
      "Expert expected findings",
    );
    expect(gold.parser.model).toBe("test-stub");
    expect(gold.source_document_ids).toEqual([source.id]);
    const original = await bytes(req({}), {
      params: Promise.resolve({ id: initial.id, documentId: gold.id }),
    });
    expect((await original.json()).content_base64).toBe(
      encoded("%PDF-1.7 expert fixture"),
    );
    expect(
      (
        await save(
          req({ name: "Optional incompatible reference", revision: 3 }),
          ctx(initial.id),
        )
      ).status,
    ).toBe(200);
  });
  it("returns safe actionable parser failures without a partial snapshot", async () => {
    const initial = await draft();
    vi.spyOn(parsing, "extractRawUnits").mockRejectedValue(
      new Error("secret-token database details"),
    );
    const response = await upload(
      req({
        revision: 1,
        filename: "broken.pdf",
        content_base64: encoded("%PDF-broken"),
      }),
      ctx(initial.id),
    );
    expect(response.status).toBe(422);
    const error = await response.json();
    expect(error.error).toMatch(/text-based PDF|valid supported file/);
    expect(JSON.stringify(error)).not.toContain("secret-token");
    const reopened = (await (await get(req({}), ctx(initial.id))).json())
      .experiment;
    expect(reopened.documents).toEqual([]);
    expect(reopened.revision).toBe(1);
  });
  it("publishes only one of two overlapping document uploads at the same revision", async () => {
    const initial = await draft();
    const responses = await Promise.all(
      ["a", "b"].map((name) =>
        upload(
          req({
            revision: 1,
            filename: `${name}.txt`,
            content_base64: encoded(`Evidence ${name}`),
          }),
          ctx(initial.id),
        ),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const reopened = (await (await get(req({}), ctx(initial.id))).json())
      .experiment;
    expect(reopened.documents).toHaveLength(1);
    expect(reopened.revision).toBe(2);
    expect(
      (
        await bytes(req({}), {
          params: Promise.resolve({
            id: "another-experiment",
            documentId: reopened.documents[0].id,
          }),
        })
      ).status,
    ).toBe(404);
    expect((await workspaces()).status).toBe(200);
  });
  it.each([
    "gap_extraction",
    "tactic_extraction",
    "matching_coverage",
    "partial_splitting",
  ])(
    "rejects invalid section-specific %s answers and unknown structured keys",
    async (section) => {
      const initial = await draft();
      const uploaded = await upload(
        req({
          revision: 1,
          filename: "source.txt",
          content_base64: encoded("Evidence"),
        }),
        ctx(initial.id),
      );
      const source = (await uploaded.json()).experiment.documents[0];
      const payload = {
        version: 1,
        section,
        source_document_ids: [source.id],
        expected_answers: [{ id: "bad", source_document_id: source.id }],
      };
      const response = await reference(
        req({
          revision: 2,
          filename: "gold.json",
          content_base64: encoded(JSON.stringify(payload)),
          format: "structured",
          section,
          source_document_ids: [source.id],
        }),
        ctx(initial.id),
      );
      expect(response.status).toBe(400);
    },
  );
  it("retains compatible PDF expected answers from the scripted production completion boundary", async () => {
    const initial = await draft();
    const uploaded = await upload(
      req({
        revision: 1,
        filename: "source.txt",
        content_base64: encoded("Evidence"),
      }),
      ctx(initial.id),
    );
    const source = (await uploaded.json()).experiment.documents[0];
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.spyOn(routing, "resolveRoute").mockResolvedValue({
      stage: "S1",
      provider_id: "scripted",
      provider_label: "Scripted",
      model: "scripted-model",
      auth: "api_key",
      connected: true,
      params: { temperature: 0, max_tokens: 1000 },
      fallbacks: [],
      degraded: false,
      reason: null,
    });
    const expected = {
      version: 1,
      section: "gap_extraction",
      source_document_ids: [source.id],
      expected_answers: [
        {
          id: " g1 ",
          source_document_id: ` ${source.id} `,
          statement: " Need comparative evidence ",
          quote: " Need comparative evidence ",
        },
      ],
    };
    const ask = vi.fn().mockResolvedValue(expected);
    vi.spyOn(routing, "completionFor").mockReturnValue(ask);
    vi.spyOn(parsing, "extractRawUnits").mockResolvedValue([
      {
        text: "Need comparative evidence",
        location: { kind: "page", ref: "p.1" },
      },
    ]);
    vi.spyOn(parsing, "parseWithLlm").mockResolvedValue({
      document: {
        id: "parsed-gold",
        filename: "gold.pdf",
        title: "Gold",
        mime: "application/pdf",
        parser: "llm",
        stakeholder_function: "medical_affairs",
        ingested_at: new Date().toISOString(),
        blocks: [
          {
            id: "b1",
            kind: "paragraph",
            text: "Need comparative evidence",
            location: { kind: "page", ref: "p.1" },
          },
        ],
        fullText: "Need comparative evidence",
      },
      dropped: [],
      dropped_units: [],
      stakeholder_rationale: "Test fixture",
    });
    const response = await reference(
      req({
        revision: 2,
        filename: "gold.pdf",
        content_base64: encoded("%PDF-1.7 expert fixture"),
        format: "pdf",
        section: "gap_extraction",
        source_document_ids: [source.id],
      }),
      ctx(initial.id),
    );
    expect(response.status).toBe(200);
    const gold = (await response.json()).experiment.documents.find(
      (document: { role: string }) => document.role === "reference",
    );
    expect(gold.review_status).toBe("provisional");
    expect(gold.compatibility).toBe("compatible");
    expect(gold.parsed.expected_answers).toEqual({
      version: 1,
      section: "gap_extraction",
      source_document_ids: [source.id],
      expected_answers: [
        {
          id: "g1",
          source_document_id: source.id,
          statement: "Need comparative evidence",
          quote: "Need comparative evidence",
        },
      ],
    });
    expect(gold.parser.model).toBe("scripted-model");
    expect(gold.parser.provider_id).toBe("scripted");
    expect(ask).toHaveBeenCalledOnce();
  });
  it("gives an actionable provider gate and bounded-body response", async () => {
    const initial = await draft();
    vi.spyOn(llm, "isTestStub").mockReturnValue(false);
    vi.spyOn(routing, "resolveRoute").mockRejectedValue(
      new NoRouteError("credentials redacted"),
    );
    const unavailable = await upload(
      req({
        revision: 1,
        filename: "x.txt",
        content_base64: encoded("Evidence"),
      }),
      ctx(initial.id),
    );
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()).error).toMatch(/S1 parsing route/);
    const oversized = await create(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-length": "999999999" },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
  });
  it("refuses source documents beyond existing configurable parser limits", async () => {
    const initial = await draft();
    vi.stubEnv("SYNAPSE_MAX_PARSE_UNITS", "1");
    try {
      vi.spyOn(parsing, "extractRawUnits").mockResolvedValue([
        { text: "One", location: { kind: "page", ref: "p.1" } },
        { text: "Two", location: { kind: "page", ref: "p.2" } },
      ]);
      const response = await upload(
        req({
          revision: 1,
          filename: "x.txt",
          content_base64: encoded("One and Two"),
        }),
        ctx(initial.id),
      );
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatch(
        /Split it into smaller files/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("denies owner operations including document bytes", async () => {
    vi.spyOn(owner, "ownerGate").mockResolvedValue(
      NextResponse.json({ code: "owner_only" }, { status: 403 }),
    );
    for (const operation of [
      () => list(),
      () => workspaces(),
      () => create(req({})),
      () => get(req({}), ctx("x")),
      () => save(req({}), ctx("x")),
      () => upload(req({}), ctx("x")),
      () => reference(req({}), ctx("x")),
      () => sources(req({}), ctx("x")),
      () => importSource(req({}), ctx("x")),
      () =>
        bytes(req({}), {
          params: Promise.resolve({ id: "x", documentId: "y" }),
        }),
    ]) {
      expect((await operation()).status).toBe(403);
    }
  });
});
