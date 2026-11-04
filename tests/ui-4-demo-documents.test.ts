/** UI-4: bundled client demo files become private experiment sources. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/lib/iegp/db";
import * as owner from "@/modules/auth/owner";
import * as llm from "@/lib/ingest/llm-structure";
import * as kernelLlm from "@/modules/kernel/llm";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { sha256, canonicalParsedJson } from "@/modules/development/documents";
import { prepareDemoDocument } from "@/modules/development/demo-documents";
import { getExecution } from "@/modules/development/execution-store";
import { progressExecution } from "@/modules/development/worker";
import { POST as startExecution } from "@/app/api/admin/development/[id]/executions/route";
import { setAiSection } from "@/modules/kernel/ai-switch";
import { xaiGrok } from "@/modules/llm/provider";
import { updateExperiment } from "@/modules/development/store";
import type { DevelopmentDocument } from "@/modules/development/schema";
import { POST as create } from "@/app/api/admin/development/route";
import { GET as get } from "@/app/api/admin/development/[id]/route";
import {
  GET as listDemo,
  POST as addDemo,
} from "@/app/api/admin/development/[id]/demo-documents/route";
import { GET as bytes } from "@/app/api/admin/development/[id]/documents/[documentId]/route";

const req = (body: unknown) =>
  new Request("http://localhost/api/admin/development", {
    method: "POST",
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function draft() {
  const response = await create(req({ name: "Demo draft", source_workspace_id: null }));
  return (await response.json()).experiment;
}
const add = (id: string, revision: number, demo_id: unknown, extra = {}) =>
  addDemo(req({ revision, demo_id, ...extra }), ctx(id));
async function reload(id: string) {
  return (await (await get(req({}), ctx(id))).json()).experiment;
}
afterEach(() => vi.restoreAllMocks());

describe("UI-4 demo documents", () => {
  it("lists exactly the client demo set as metadata without text", async () => {
    const experiment = await draft();
    const body = await (await listDemo(req({}), ctx(experiment.id))).json();
    expect(body.documents).toEqual(
      CLIENT_DEMO_PACK.map(({ id, title, filename }) => ({ id, title, filename, present: false })),
    );
    expect(body.documents).toHaveLength(CLIENT_DEMO_PACK.length);
    expect(JSON.stringify(body)).not.toContain(CLIENT_DEMO_PACK[0].text.slice(0, 40));
    expect(body.documents.map((d: { id: string }) => d.id)).not.toContain(DEMO_PACK[0].id);
  });

  it("saves exact bytes, parsed hash, provenance and stays private across reopen", async () => {
    const experiment = await draft();
    const file = CLIENT_DEMO_PACK[0];
    const response = await add(experiment.id, experiment.revision, file.id);
    expect(response.status).toBe(200);
    const saved = (await response.json()).experiment;
    const doc = saved.documents[0];
    expect(saved.revision).toBe(experiment.revision + 1);
    expect(doc).toMatchObject({
      role: "source",
      origin: "private",
      filename: file.filename,
      sha256: sha256(Buffer.from(file.text, "utf8")),
      bytes: Buffer.byteLength(file.text, "utf8"),
      demo: { pack: "client-demo", id: file.id },
      source_workspace_id: null,
      source_file_id: null,
    });
    expect(doc.parsed_sha256).toBe(sha256(canonicalParsedJson(doc.parsed)));
    const original = await (
      await bytes(req({}), { params: Promise.resolve({ id: experiment.id, documentId: doc.id }) })
    ).json();
    expect(Buffer.from(original.content_base64, "base64").toString("utf8")).toBe(file.text);
    const reopened = await reload(experiment.id);
    expect(reopened.documents[0]).toEqual(doc);
    expect(doc.parsed.blocks.map((b: { text: string }) => b.text).join("")).toContain(
      file.text.trim().slice(0, 20),
    );
  });

  it("rejects duplicates before preparation and keeps one saved copy on retry", async () => {
    const experiment = await draft();
    const first = await add(experiment.id, 1, CLIENT_DEMO_PACK[0].id);
    expect(first.status).toBe(200);
    const parse = vi.spyOn(llm, "extractRawUnits");
    const again = await add(experiment.id, 2, CLIENT_DEMO_PACK[0].id);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("duplicate_demo_document");
    expect(parse).not.toHaveBeenCalled();
    const lost = await add(experiment.id, 1, CLIENT_DEMO_PACK[0].id);
    expect((await lost.json()).code).toBe("stale_revision");
    expect((await reload(experiment.id)).documents).toHaveLength(1);
  });

  it("lets only one concurrent request with the same revision insert", async () => {
    const experiment = await draft();
    const results = await Promise.all([
      add(experiment.id, 1, CLIENT_DEMO_PACK[1].id),
      add(experiment.id, 1, CLIENT_DEMO_PACK[1].id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await reload(experiment.id)).documents).toHaveLength(1);
  });

  it("adds several different files sequentially with refreshed revisions", async () => {
    const experiment = await draft();
    let revision = experiment.revision;
    for (const file of CLIENT_DEMO_PACK.slice(0, 3)) {
      const saved = (await (await add(experiment.id, revision, file.id)).json()).experiment;
      revision = saved.revision;
    }
    expect((await reload(experiment.id)).documents.map((d: { filename: string }) => d.filename).sort())
      .toEqual(CLIENT_DEMO_PACK.slice(0, 3).map((f) => f.filename).sort());
  });

  it("rejects unknown ids, paths and extra fields before saving anything", async () => {
    const experiment = await draft();
    const parse = vi.spyOn(llm, "extractRawUnits");
    for (const [body, status] of [
      [{ demo_id: "nope" }, 404],
      [{ demo_id: "../../etc/passwd" }, 404],
      [{ demo_id: DEMO_PACK[0].id }, 404],
      [{ demo_id: CLIENT_DEMO_PACK[0].id, path: "/etc/passwd" }, 400],
      [{ demo_id: CLIENT_DEMO_PACK[0].id, filename: "x.txt" }, 400],
      [{ demo_id: 5 }, 400],
    ] as const) {
      const response = await addDemo(req({ revision: 1, ...body }), ctx(experiment.id));
      expect(response.status).toBe(status);
      expect(JSON.stringify(await response.json())).not.toMatch(/\/Users|\/etc|node_modules/);
    }
    expect(parse).not.toHaveBeenCalled();
    expect((await reload(experiment.id)).documents).toHaveLength(0);
  });

  it("denies non-owners before reading or preparing", async () => {
    const experiment = await draft();
    vi.spyOn(owner, "ownerGate").mockResolvedValue(
      NextResponse.json({ code: "owner_only" }, { status: 403 }),
    );
    const parse = vi.spyOn(llm, "extractRawUnits");
    expect((await listDemo(req({}), ctx(experiment.id))).status).toBe(403);
    expect((await add(experiment.id, 1, CLIENT_DEMO_PACK[0].id)).status).toBe(403);
    expect(parse).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect((await reload(experiment.id)).documents).toHaveLength(0);
  });

  it("isolates selections per experiment and leaves customer data alone", async () => {
    const a = await draft(),
      b = await draft();
    const before = await sharedDb().execute(sql`select count(*)::int as n from platform_settings`);
    await add(a.id, 1, CLIENT_DEMO_PACK[0].id);
    expect((await reload(b.id)).documents).toHaveLength(0);
    const second = await add(b.id, 1, CLIENT_DEMO_PACK[0].id);
    expect(second.status).toBe(200);
    const after = await sharedDb().execute(sql`select count(*)::int as n from platform_settings`);
    expect(after[0].n).toBe(before[0].n);
  });

  it("returns a recoverable error and saves nothing when ingestion is off", async () => {
    const experiment = await draft();
    const { setAiSection } = await import("@/modules/kernel/ai-switch");
    await setAiSection({ section: "ingestion", enabled: false, actor_name: "test" });
    try {
      const response = await add(experiment.id, 1, CLIENT_DEMO_PACK[0].id);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("ai_disabled");
    } finally {
      await setAiSection({ section: "ingestion", enabled: true, actor_name: "test" });
    }
    expect((await reload(experiment.id)).documents).toHaveLength(0);
  });

  it("treats bundled bytes saved without demo provenance as already present, still saving new files", async () => {
    const experiment = await draft();
    const [old, fresh] = CLIENT_DEMO_PACK;
    // Arrange: same original bytes saved earlier as an ordinary private upload (no demo metadata).
    const prepared = await prepareDemoDocument(experiment, "owner", old.id);
    const plain: DevelopmentDocument = { ...prepared.document };
    delete plain.demo;
    const seeded = await updateExperiment(experiment.id, 1, { ...prepared, document: plain });
    const listed = (await (await listDemo(req({}), ctx(experiment.id))).json()).documents;
    expect(listed.filter((d: { present: boolean }) => d.present).map((d: { id: string }) => d.id)).toEqual([old.id]);
    expect(JSON.stringify(listed)).not.toContain(old.text.slice(0, 40));
    // Act: server refuses the old file before preparation; the new file still saves.
    const parse = vi.spyOn(llm, "extractRawUnits");
    const dup = await add(experiment.id, seeded.revision, old.id);
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe("duplicate_demo_document");
    expect(parse).not.toHaveBeenCalled();
    const next = await add(experiment.id, seeded.revision, fresh.id);
    expect(next.status).toBe(200);
    // Assert: the old source stays immutable and unlabeled; only one new source was inserted.
    const documents = (await reload(experiment.id)).documents;
    expect(documents).toHaveLength(2);
    expect(documents.find((d: { id: string }) => d.id === plain.id)).toEqual(plain);
  });

  it("starts scripted normal execution from reopened demo sources without paid calls", async () => {
    const experiment = await draft();
    let revision = experiment.revision;
    for (const file of CLIENT_DEMO_PACK.slice(0, 2))
      revision = (await (await add(experiment.id, revision, file.id)).json()).experiment.revision;
    const reopened = await reload(experiment.id);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unscripted network is forbidden."));
    vi.stubEnv("SYNAPSE_DEVELOPMENT_DELIVERY", "github_actions");
    vi.stubEnv("CRON_SECRET", "isolated-test-worker-secret-long-enough");
    vi.stubEnv("XAI_API_KEY", "test-key-never-send");
    vi.spyOn(kernelLlm, "isTestStub").mockReturnValue(false);
    await setAiSection({ section: "gap_extraction", enabled: true, actor_name: "test" });
    const quote = reopened.documents[0].parsed.blocks[0].text as string;
    const send = vi.spyOn(xaiGrok, "complete").mockResolvedValue(
      JSON.stringify({ gaps: [{ name: "Demo gap", statement: quote, domain: "comparative_effectiveness", source_quote: quote }] }),
    );
    try {
      const response = await startExecution(
        req({ revision: reopened.revision, target: "gap_extraction", config: { mode: "single_pass" }, prerequisites: {}, cost_controls: { allowance_usd: 100, unknown_acknowledged: true } }),
        ctx(experiment.id),
      );
      expect(response.status).toBe(202);
      const started = (await response.json()).execution;
      expect(started.manifest.sources.map((d: { id: string; sha256: string }) => [d.id, d.sha256]))
        .toEqual(reopened.documents.map((d: { id: string; sha256: string }) => [d.id, d.sha256]));
      for (let i = 0; i < 100; i++) {
        const current = await getExecution(experiment.id, started.id);
        if (!["queued", "running"].includes(current.generation_status)) break;
        await progressExecution(started.id);
      }
      const done = await getExecution(experiment.id, started.id);
      expect(done.sections.map((s) => s.error ?? s.status)).toEqual(["succeeded"]);
      expect(done.generation_status).toBe("succeeded");
      expect(send).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
