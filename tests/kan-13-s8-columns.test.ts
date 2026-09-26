import { describe, expect, it } from "vitest";
import { createWorkspace, withWorkspace } from "@/modules/workspaces/store";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

/**
 * Found in live QA (KAN-13): S8 added its human_axes/human_band columns once per
 * process, so any other workspace (or Default) failed with "column does not exist".
 */
describe("S8 placement columns exist in every workspace schema", () => {
  it("lists placements in two fresh workspaces and in Default", async () => {
    const owner = `s8cols-${Math.random().toString(36).slice(2, 8)}@qa.test`;
    const a = await createWorkspace({ name: "S8 cols A", owner });
    const b = await createWorkspace({ name: "S8 cols B", owner });
    await expect(withWorkspace(a.id, listPlacements)).resolves.toEqual([]);
    await expect(withWorkspace(b.id, listPlacements)).resolves.toEqual([]);
    await expect(listPlacements()).resolves.toBeInstanceOf(Array);
  }, 60_000);
});
