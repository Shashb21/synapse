/** Regression coverage for the boundary between parser bytes and run telemetry. */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAccuracyModule } from "@/accuracy/kernel/run";
import * as registry from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { NextResponse } from "next/server";
import { AccuracyRunRecorder, openAccuracyRun, closeAccuracyRun, listAccuracyRuns } from "@/accuracy/kernel/observability";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import * as owner from "@/modules/auth/owner";
import { GET } from "@/app/api/accuracy/runs/route";

/** Build independent run metadata without changing shared workspace fixtures. */
function recorder(input: unknown, call_kind: "parse" | "need_extract" = "parse") {
  return new AccuracyRunRecorder({ org_id: "retention-org", workspace_id: `retention-${crypto.randomUUID()}`, call_kind,
    agent_role: "none", module_id: "retention.test", module_version: "1", actor: { name: "test", function: "medical_affairs" }, input });
}

const metadata = { workspace_id: "workspace", source_file_id: "source", filename: "notes.docx", mime: "application/octet-stream" };

describe("recorder document retention", () => {
  it.each([8, 100_000])("keeps metadata and removes %i bytes before telemetry truncation", async (size) => {
    // Arrange: parser input may contain untrusted extras as well as document bytes.
    const bytes = Buffer.alloc(size, 65);
    const input = { ...metadata, content_base64: bytes.toString("base64"), extra: { secret: "untrusted" } };
    const run = recorder(input);
    // Act: processing still receives the exact original object/value.
    run.note("input:accepted", input);
    const result = await run.step("custom", () => ({ nested: [{ content_base64: input.content_base64, keep: true }] }));
    run.note("other", { nested: { content_base64: input.content_base64, keep: true } });
    // Assert: safe projection is independent of raw document size.
    expect(result.nested[0].content_base64).toBe(input.content_base64);
    expect(input.content_base64).toBe(bytes.toString("base64"));
    expect(run.meta.input).toEqual({ ...metadata, checksum: createHash("sha256").update(bytes).digest("hex"), byte_count: size });
    expect(run.steps()[0].data).toEqual(run.meta.input);
    expect(JSON.stringify(run.steps())).not.toContain("content_base64");
    expect(JSON.stringify(run.steps())).not.toContain("preview");
  });

  it("passes ordinary validated module input through unchanged", async () => {
    const input = { claim: "evidence", values: [1, 2], nested: { content_base64: "processing-only" } };
    const implementation = mechanicalModule({
      id: "retention.ordinary", call_kind: "need_extract", title: "Ordinary input", summary: "Fixture",
      inputSchema: z.unknown(), outputSchema: z.object({ count: z.number() }),
      run: async (received) => {
        expect(received).toBe(input);
        return { output: { count: input.values.length }, summary: "done" };
      },
    });
    const active = vi.spyOn(registry, "activeAccuracyModule").mockResolvedValue(implementation);
    const run = recorder(input, "need_extract");
    try {
      const result = await runAccuracyModule({ ...run.meta, input });
      expect(result.output).toEqual({ count: 2 });
      expect(input.nested.content_base64).toBe("processing-only");
    } finally { active.mockRestore(); }
  });

  it("preserves ordinary module input while removing nested document payload keys", () => {
    const input = { claim: "evidence", options: [1, null, { content_base64: "secret", keep: true }] };
    const run = recorder(input, "need_extract");
    expect(run.meta.input).toEqual({ claim: "evidence", options: [1, null, { keep: true }] });
    expect(input.options[2]).toEqual({ content_base64: "secret", keep: true });
  });

  it.each([null, "malformed", { filename: { content_base64: "secret" }, byte_count: -1, checksum: [] }])("handles invalid legacy metadata safely: %j", (input) => {
    const run = recorder(input);
    expect(run.meta.input).toEqual({});
    run.note("input:accepted", input);
    expect(run.steps()[0].data).toEqual({});
  });

  it("persists safe input and all structured output fields on error", async () => {
    const run = recorder({ ...metadata, content_base64: "c2VjcmV0" });
    await openAccuracyRun(run);
    run.note("input:accepted", { ...metadata, content_base64: "c2VjcmV0" });
    await expect(run.step("failed", () => { throw Object.assign(new Error("parser failed"), { llm_call_id: { content_base64: "secret" } }); })).rejects.toThrow("parser failed");
    await closeAccuracyRun({ recorder: run, status: "error", error: "parser failed", output: { content_base64: "secret", keep: true } });
    const [stored] = await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.id, run.id));
    expect(stored.status).toBe("error");
    expect(JSON.stringify(stored)).not.toContain("content_base64");
    expect(stored.output).toEqual({ keep: true });
  });
});

describe("historic run API retention", () => {
  it("projects a 40 MiB historic input and accepted preview to bounded safe metadata", async () => {
    await ensureAccuracySchema();
    const run = recorder(metadata);
    const bytes = Buffer.alloc(40 * 1024 * 1024, 65).toString("base64");
    const sizes: number[] = [];
    for (const content_base64 of ["QQ==", bytes]) {
      await openAccuracyRun(run);
      await accuracyDb().update(t.accuracyModuleRuns).set({ status: "ok", input: { ...metadata, content_base64, extra: "untrusted" },
        steps: [{ name: "input:accepted", data: { truncated: true, preview: `old ${content_base64.slice(0, 1000)}`, bytes: content_base64.length } },
          { name: "other", data: { nested: [{ content_base64: "secret", keep: true }] } }],
        output: { content_base64: "secret", keep: true }, route: { nested: { content_base64: "secret" } }, evals: [{ content_base64: "secret" }] }).where(eq(t.accuracyModuleRuns.id, run.id));
      const response = await GET(new Request(`http://localhost/api/accuracy/runs?workspace_id=${run.workspace_id}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      const json = JSON.stringify(body);
      expect(json).not.toContain("content_base64");
      expect(json).not.toContain("preview");
      expect(body.runs[0].input).toEqual(metadata);
      expect(body.runs[0].steps[0].data).toEqual(metadata);
      expect(body.runs[0].steps[1].data).toEqual({ nested: [{ keep: true }] });
      sizes.push(json.length);
      await accuracyDb().delete(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.id, run.id));
    }
    expect(sizes[1]).toBeLessThan(sizes[0] + 100);
    const gate = vi.spyOn(owner, "ownerGate").mockResolvedValue(NextResponse.json({ code: "owner_only" }, { status: 403 }));
    try {
      const response = await GET(new Request(`http://localhost/api/accuracy/runs?workspace_id=${run.workspace_id}`));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "owner_only" });
    } finally { gate.mockRestore(); }
  });

  it.each([null, "malformed", { filename: { content_base64: "secret" }, byte_count: "wrong" }])("reads malformed historic metadata safely: %j", async (input) => {
    const run = recorder(metadata);
    await openAccuracyRun(run);
    await accuracyDb().update(t.accuracyModuleRuns).set({ input: input === null ? sql`'null'::jsonb` : input, steps: [{ name: "input:accepted", data: { truncated: true, preview: "unsafe" } }] }).where(eq(t.accuracyModuleRuns.id, run.id));
    const [row] = await listAccuracyRuns(run.workspace_id);
    expect(row.input).toEqual({});
    expect(row.steps).toEqual([{ name: "input:accepted", data: {} }]);
  });
});
