import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

// Stand-in for any AI entry point that refuses while the switch is off.
vi.mock("@/modules/stages/s9-ideation/module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/stages/s9-ideation/module")>();
  const { AiDisabledError } = await import("@/modules/kernel/ai-switch");
  return {
    ...actual,
    addIdeationProposal: async () => {
      throw new AiDisabledError("S9 ideation");
    },
  };
});

import "@/modules";
import { POST as planPost } from "@/app/api/plan/route";
import { AI_OFF_MESSAGE } from "@/modules/kernel/ai-switch";

describe("the plan route with AI off", () => {
  it("maps an AiDisabledError to 409 ai_off instead of a raw 400", async () => {
    const res = await planPost(
      new Request("http://localhost/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add_proposal",
          gap_id: "GAP-1",
          name: "x",
          type: "rwe_study",
          evidence_question: "q",
          rationale: "because",
          actor_name: "Route Test",
          actor_function: "medical_affairs",
        }),
      }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code?: string; error?: string };
    expect(json.code).toBe("ai_off");
    expect(json.error).toContain(AI_OFF_MESSAGE);
  });
});
