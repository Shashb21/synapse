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

  it.each([
    ["deck.ppt", "application/vnd.ms-powerpoint"],
    ["deck.PPT", "application/vnd.ms-powerpoint"],
    ["notes.doc", "application/msword"],
    ["deck.key", "application/octet-stream"],
    ["program.exe", "application/octet-stream"],
    ["README", "text/plain"],
    ["disguised.ppt", "application/pdf"],
  ])("rejects unsupported %s without saving a source", async (filename, mime) => {
    const { workspace_id } = await freshWorkspace("unsupported");
    const sourcesBefore = await listSourceFiles(workspace_id);
    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("file", new File(["unsupported content"], filename, { type: mime }));

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    if (filename.toLowerCase().endsWith(".ppt")) {
      expect(body.error).toBe(
        "Legacy .ppt files are not supported. Save the file as .pptx and upload it again.",
      );
    } else {
      expect(body.error).toContain(".pptx, .docx, .xlsx, .xls, .pdf, .txt, .md");
    }
    expect(await listSourceFiles(workspace_id)).toEqual(sourcesBefore);
  });

  it.each([
    "pptx", "docx", "xlsx", "xls", "pdf", "txt", "md",
    "PPTX", "DOCX", "XLSX", "XLS", "PDF", "TXT", "MD",
  ])("parses and persists an eligible .%s source", async (extension) => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("supported");
    const filename = `source.${extension}`;
    mockParseLocal.mockResolvedValue({
      id: "DOC-supported",
      filename,
      title: "Evidence notes",
      stakeholder_function: "medical_affairs",
      mime: "application/octet-stream",
      parser: "local",
      ingested_at: new Date().toISOString(),
      blocks: [{
        id: "DOC-supported-B01",
        location: { kind: "page", ref: "p.1" },
        text: "Need comparative evidence",
        kind: "paragraph",
      }],
      fullText: "Need comparative evidence",
    });
    mockExtractUnits.mockResolvedValue([
      { location: { kind: "page", ref: "p.1" }, text: "Need comparative evidence" },
    ]);
    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("file", new File(["supported content"], filename));

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      source_file_id: string;
      block_count: number;
      parse_error: string | null;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.parse_error).toBeNull();
    expect(body.block_count).toBe(1);
    expect(await listSourceFiles(workspace_id)).toEqual([
      expect.objectContaining({ id: body.source_file_id, filename }),
    ]);
    expect(await countParseBlocks(workspace_id, body.source_file_id)).toBe(1);
  });

  it("retains an eligible source when its parser rejects the contents", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("parse-failure");
    mockParseLocal.mockRejectedValue(new Error("Malformed DOCX archive"));
    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("file", new File(["malformed contents"], "broken.docx"));

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      source_file_id: string;
      block_count: number;
      parse_error: string | null;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.parse_error).toBe("Malformed DOCX archive");
    expect(body.block_count).toBe(0);
    expect(await listSourceFiles(workspace_id)).toEqual([
      expect.objectContaining({ id: body.source_file_id, filename: "broken.docx" }),
    ]);
    expect(await countParseBlocks(workspace_id, body.source_file_id)).toBe(0);
  });

});
