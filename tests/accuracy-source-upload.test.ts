import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as uploadPost } from "@/app/api/accuracy/sources/upload/route";
import { registerAccuracyStack } from "@/accuracy";
import { countParseBlocks, listSourceFiles } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";

const mockParseLocal = vi.fn();
const mockExtractUnits = vi.fn();

vi.mock("@/lib/ingest/local-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/local-parse")>();
  return {
    ...actual,
    parseLocalDocument: (...args: unknown[]) => mockParseLocal(...args),
  };
});

vi.mock("@/lib/ingest/llm-structure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/llm-structure")>();
  return { ...actual, extractRawUnits: (...args: unknown[]) => mockExtractUnits(...args) };
});

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
  return { org_id, workspace_id };
}

describe("accuracy source upload API", () => {
  beforeEach(() => {
    mockParseLocal.mockReset();
    mockExtractUnits.mockReset();
  });

  it("rejects missing workspace and file", async () => {
    const empty = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", {
        method: "POST",
        body: new FormData(),
      }),
    );
    expect(empty.status).toBe(400);

    const form = new FormData();
    form.set("workspace_id", "missing");
    const noFile = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", {
        method: "POST",
        body: form,
      }),
    );
    expect(noFile.status).toBe(400);
  });

  it("registers a DOCX source and persists local parse blocks", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("upload");

    mockParseLocal.mockResolvedValue({
      id: "DOC-local",
      filename: "notes.docx",
      title: "Notes",
      stakeholder_function: "medical_affairs",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parser: "local",
      ingested_at: new Date().toISOString(),
      blocks: [
        {
          id: "DOC-local-B01",
          location: { kind: "page", ref: "p.1" },
          text: "Need OS evidence",
          kind: "paragraph",
        },
      ],
      fullText: "Need OS evidence",
    });

    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("doc_role", "medical");
    form.set(
      "file",
      new File([Buffer.from("fake-docx")], "notes.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", {
        method: "POST",
        body: form,
      }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      source_file_id: string;
      block_count: number;
      parser: string;
      parse_error: string | null;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.block_count).toBe(1);
    expect(body.parser).toMatch(/local/i);
    expect(body.parse_error).toBeNull();
    expect(mockParseLocal).toHaveBeenCalledOnce();

    const sources = await listSourceFiles(workspace_id);
    expect(sources.some((s) => s.id === body.source_file_id)).toBe(true);
    expect(await countParseBlocks(workspace_id, body.source_file_id)).toBe(1);
  });

  it("accepts a PDF and parses it on the LLM parse route", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("pdf-llm");
    mockExtractUnits.mockResolvedValue([
      { location: { kind: "page", ref: "p.1" }, text: "Chart OS Kaplan-Meier" },
      { location: { kind: "page", ref: "p.2" }, text: "No real-world OS data in elderly patients." },
    ]);

    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("doc_role", "medical");
    form.set("file", new File([Buffer.from("%PDF-fake")], "plan.pdf", { type: "application/pdf" }));

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as { ok: boolean; block_count: number; parse_error: string | null; source_file_id: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.parse_error).toBeNull();
    expect(body.block_count).toBe(2);
    expect(await countParseBlocks(workspace_id, body.source_file_id)).toBe(2);
  });

  it("accepts a PPTX and parses it without a separate parser service", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("pptx-llm");
    mockParseLocal.mockResolvedValue({
      id: "DOC-pptx",
      filename: "deck.pptx",
      title: "Deck",
      stakeholder_function: "medical_affairs",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      parser: "local",
      ingested_at: new Date().toISOString(),
      blocks: [{ id: "DOC-pptx-B01", location: { kind: "slide", ref: "Slide 1" }, text: "Evidence plan", kind: "title" }],
      fullText: "Evidence plan",
    });

    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("doc_role", "medical");
    form.set(
      "file",
      new File([Buffer.from("fake-pptx")], "deck.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as { ok: boolean; block_count: number; parse_error: string | null };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.parse_error).toBeNull();
    expect(body.block_count).toBe(1);
  });
});
