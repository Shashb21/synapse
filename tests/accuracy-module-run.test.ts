import { describe, expect, it } from "vitest";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";

describe("accuracy module run", () => {
  it("runs mechanical parse module without LLM", async () => {
    registerAccuracyStack();
    const result = await runAccuracyModule({
      call_kind: "parse",
      input: {
        workspace_id: "ws-test",
        source_file_id: "src-1",
        filename: "plan.pdf",
        mime: "application/pdf",
      },
      actor: { name: "test", function: "medical_affairs" },
      org_id: "org-test",
      workspace_id: "ws-test",
    });
    expect((result.output as { parser: string }).parser).toBe("llamaparse");
    expect(result.cost_usd).toBe(0);
  });
});
