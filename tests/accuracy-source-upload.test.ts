import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as uploadPost } from "@/app/api/accuracy/sources/upload/route";
import { registerAccuracyStack } from "@/accuracy";
import { countParseBlocks, listSourceFiles } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { LLAMA_PARSE_KEY_CODE, LLAMA_PARSE_KEY_REQUIRED } from "@/lib/ingest/llama-gate";

const mockIngestBuffer = vi.fn();
const mockParseLocal = vi.fn();

vi.mock("@/lib/ingest/llamaparse", () => ({
  ingestBuffer: (...args: unknown[]) => mockIngestBuffer(...args),
}));

vi.mock("@/lib/ingest/local-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/local-parse")>();
  return {
    ...actual,
    parseLocalDocument: (...args: unknown[]) => mockParseLocal(...args),
  };
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
    mockIngestBuffer.mockReset();
    mockParseLocal.mockReset();
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
    expect(mockIngestBuffer).not.toHaveBeenCalled();

    const sources = await listSourceFiles(workspace_id);
    expect(sources.some((s) => s.id === body.source_file_id)).toBe(true);
    expect(await countParseBlocks(workspace_id, body.source_file_id)).toBe(1);
  });

  it("gates PDF upload when LLAMA_CLOUD_API_KEY is missing", async () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "");
    const { workspace_id } = await freshWorkspace("pdf-gate");
    const before = await listSourceFiles(workspace_id);

    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("doc_role", "medical");
    form.set("file", new File([Buffer.from("%PDF-fake")], "plan.pdf", { type: "application/pdf" }));

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as { ok: boolean; error?: string; code?: string };
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.code).toBe(LLAMA_PARSE_KEY_CODE);
    expect(body.error).toBe(LLAMA_PARSE_KEY_REQUIRED);
    expect(mockIngestBuffer).not.toHaveBeenCalled();
    expect(mockParseLocal).not.toHaveBeenCalled();
    expect(await listSourceFiles(workspace_id)).toHaveLength(before.length);
    vi.unstubAllEnvs();
  });

  it("gates PPTX upload when LLAMA_CLOUD_API_KEY is missing", async () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "");
    const { workspace_id } = await freshWorkspace("pptx-gate");

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
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.code).toBe(LLAMA_PARSE_KEY_CODE);
    expect(mockParseLocal).not.toHaveBeenCalled();
    expect(await listSourceFiles(workspace_id)).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("uses mocked LlamaParse path for PDF when the key is set", async () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "test-key");
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("pdf-llama");

    mockIngestBuffer.mockResolvedValue({
      document: {
        id: "DOC-llama",
        filename: "plan.pdf",
        title: "Plan",
        stakeholder_function: "medical_affairs",
        mime: "application/pdf",
        parser: "llamaparse",
        ingested_at: new Date().toISOString(),
        blocks: [
          {
            id: "DOC-llama-B01",
            location: { kind: "page", ref: "p.1" },
            text: "Chart OS Kaplan-Meier",
            kind: "paragraph",
          },
        ],
        fullText: "Chart OS Kaplan-Meier",
      },
      parserUsed: "llamaparse",
    });

    const form = new FormData();
    form.set("workspace_id", workspace_id);
    form.set("doc_role", "medical");
    form.set("file", new File([Buffer.from("%PDF-fake")], "plan.pdf", { type: "application/pdf" }));

    const res = await uploadPost(
      new Request("http://localhost/api/accuracy/sources/upload", { method: "POST", body: form }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      parser: string;
      block_count: number;
      parse_error: string | null;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.parser).toBe("llamaparse");
    expect(body.block_count).toBe(1);
    expect(body.parse_error).toBeNull();
    expect(mockIngestBuffer).toHaveBeenCalledOnce();
    expect(mockParseLocal).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
