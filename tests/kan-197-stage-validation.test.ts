/** Invalid stage input keeps safe correction guidance and leaves workspace records unchanged. */
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/modules/route";
import { loadState, resetDemoSetup } from "@/lib/iegp/store";

describe("stage input recovery", () => {
  it("explains the missing rationale before running validation and preserves the workspace", async () => {
    await resetDemoSetup();
    const before = await loadState();
    const response = await POST(new Request("http://localhost/api/modules", {
      method: "POST", body: JSON.stringify({ stage: "S5", input: { action: "validate", gap_id: "unused", rationale: "x" } }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ safe_error: true, error: expect.stringMatching(/rationale.*at least 3/i) });
    const after = await loadState();
    expect(after.gaps).toEqual(before.gaps);
    expect(after.coverages).toEqual(before.coverages);
  });
  it("does not reflect invalid input or schema internals", async () => {
    const secret = "SELECT private password=sample-secret";
    const response = await POST(new Request("http://localhost/api/modules", {
      method: "POST", body: JSON.stringify({ stage: "S5", input: { action: secret, rationale: "Valid rationale" } }),
    }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/check.*fields/i);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.error).not.toContain("s5-validation.human-gate");
  });
});
