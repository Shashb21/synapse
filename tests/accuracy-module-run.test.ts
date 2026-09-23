import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";

const mockIngestBuffer = vi.fn();

vi.mock("@/lib/ingest/llamaparse", () => ({
  ingestBuffer: (...args: unknown[]) => mockIngestBuffer(...args),
}));

vi.mock("@/lib/ingest/local-parse", () => ({
  parseLocalDocument: vi.fn(),
}));

describe("accuracy module run", () => {
  beforeEach(() => {
    mockIngestBuffer.mockReset();
    const tag = `policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mockIngestBuffer.mockResolvedValue({
      document: {
        id: `DOC-${tag}`,
        filename: "plan.pdf",
        title: "t",
        stakeholder_function: "medical_affairs",
        mime: "application/pdf",
        parser: "llamaparse",
        ingested_at: new Date().toISOString(),
        blocks: [
          {
            id: `DOC-${tag}-B01`,
            location: { kind: "page", ref: "p.1" },
            text: "Policy check",
            kind: "title",
          },
        ],
        fullText: "Policy check",
      },
      parserUsed: "llamaparse",
    });
  });

  it("runs mechanical parse module without LLM", async () => {
    registerAccuracyStack();
    const workspace_id = `ws-policy-${Date.now()}`;
    const result = await runAccuracyModule({
      call_kind: "parse",
      input: {
        workspace_id,
        source_file_id: `src-policy-${Date.now()}`,
        filename: "plan.pdf",
        mime: "application/pdf",
        content_base64: Buffer.from("fake").toString("base64"),
      },
      actor: { name: "test", function: "medical_affairs" },
      org_id: "org-test",
      workspace_id,
    });
    expect((result.output as { parser: string }).parser).toBe("llamaparse");
    expect((result.output as { block_count: number }).block_count).toBe(1);
    expect(result.cost_usd).toBe(0);
  });
});
