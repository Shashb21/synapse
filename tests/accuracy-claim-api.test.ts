import { afterEach, expect, it, vi } from "vitest";
import { sendJson } from "@/components/accuracy/claim-api";
afterEach(() => vi.unstubAllGlobals());
it("keeps structured stale-revision errors actionable for a human retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: "stale_revision", message: "Factual inputs changed; reload before confirming" } }) })));
  const result = await sendJson("/api/accuracy/coverage", "POST", { rationale: "Verified outcome facts" });
  expect(result.error).toBe("Factual inputs changed; reload before confirming");
  expect(result.json.error).toEqual({ code: "stale_revision", message: "Factual inputs changed; reload before confirming" });
});
it("reports network failure without dropping the caller's rationale", async () => {
  const body = { rationale: "Human explanation" };
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Connection lost"); }));
  const result = await sendJson("/api/accuracy/claims/split/rollback", "POST", body);
  expect(result).toEqual({ ok: false, error: "Connection lost", json: {} });
  expect(body.rationale).toBe("Human explanation");
});
