import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { wipePlatform } from "@/modules/kernel/db";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { createGap, loadState, resetBlank } from "@/lib/iegp/store";
import { prioritizationProgress, validatePlacement } from "@/modules/stages/s8-prioritization/module";

/**
 * KAN-16: the server enforces the gates the UI shows. "Continue to tactics" is
 * offered only when every Open gap has a validated band, so unlock_tactics
 * refuses anything earlier with a 400 that says what is left.
 */

const ACTOR = { name: "Gate Tester", function: "medical_affairs" as const };

async function post(body: Record<string, unknown>) {
  const res = await iegpPost(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let openIds: string[] = [];

beforeAll(async () => {
  await resetBlank();
  await wipePlatform();
}, 60_000);

describe("unlock_tactics", () => {
  it("refuses before Prioritize is entered", async () => {
    const { status, json } = await post({ action: "unlock_tactics" });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/Prioritize open gaps before tactics/);
  });

  it("refuses with a clear message while no Open gap has a validated band", async () => {
    for (const statement of [
      "No comparative effectiveness evidence versus standard of care.",
      "Real-world quality of life in elderly patients is not described.",
    ]) {
      await createGap({ statement, domain: "comparative_effectiveness", actor_name: ACTOR.name, actor_function: ACTOR.function });
    }
    const state = await loadState();
    openIds = state.gaps.filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open").map((gap) => gap.id);
    expect(openIds.length).toBe(2);
    for (const gap_id of openIds) expect((await post({ action: "validate_gap", gap_id })).status).toBe(200);
    expect((await post({ action: "complete_wizard" })).status).toBe(200);

    const { status, json } = await post({ action: "unlock_tactics" });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/0 of 2 validated, 2 to go/);
    expect((await loadState()).asset.tactics_unlocked).toBe(false);
  });

  it("still refuses when only some Open gaps are validated (the footer's count)", async () => {
    await validatePlacement({ gap_id: openIds[0]!, band: "high", rationale: "Blocks the HTA dossier", actor: ACTOR });
    expect(await prioritizationProgress(await loadState())).toEqual({ open: 2, validated: 1 });
    const { status, json } = await post({ action: "unlock_tactics" });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/1 of 2 validated, 1 to go/);
    expect((await loadState()).asset.tactics_unlocked).toBe(false);
  });

  it("opens Tactics once every Open gap has a validated band", async () => {
    await validatePlacement({ gap_id: openIds[1]!, band: "low", rationale: "Nice to have this cycle", actor: ACTOR });
    const { status } = await post({ action: "unlock_tactics" });
    expect(status).toBe(200);
    const state = await loadState();
    expect(state.asset.tactics_unlocked).toBe(true);
    expect(state.audit.some((row) => row.action === "unlock_tactics")).toBe(true);
  });
});

describe("complete_wizard", () => {
  it("refuses while a live gap is unconfirmed, as the Gaps footer does", async () => {
    await resetBlank();
    await wipePlatform();
    const { status, json } = await post({ action: "complete_wizard" });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/Ingest at least one source|Validate every live gap/);
  });
});
