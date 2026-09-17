import { describe, expect, it } from "vitest";
import { loadState, lockGapStatus, resetSeed } from "@/lib/iegp/store";

describe("IEGP postgres store", () => {
  it("seeds Velmara and refuses to auto-close a gap as addressed", async () => {
    const state = await resetSeed();
    expect(state.asset.id).toBe("ASSET-VELMARA");
    expect(state.gaps.length).toBeGreaterThan(8);
    await expect(
      lockGapStatus({
        gap_id: "GAP-ELDERLY-CE",
        status: "validated_addressed",
        actor_name: "Test",
        actor_function: "evidence_lead",
      }),
    ).rejects.toThrow(/never auto-closes|Cannot lock Addressed/i);
  });

  it("allows addressed with an override note", async () => {
    await resetSeed();
    await lockGapStatus({
      gap_id: "GAP-ELDERLY-CE",
      status: "validated_addressed",
      actor_name: "S. Iyer",
      actor_function: "evidence_lead",
      note: "Governance accepted remaining residual as out of cycle.",
    });
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === "GAP-ELDERLY-CE");
    expect(gap?.status).toBe("validated_addressed");
    expect(gap?.status_lock.locked).toBe(true);
  });
});
