import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/lib/iegp/db";
import { createWorkspace, getWorkspace, renameWorkspace, WORKSPACE_NAME_MAX } from "@/modules/workspaces/store";

/** KAN-68: a workspace name has a sensible length, on create and on rename. */
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "ws_${id}" CASCADE`));
});

describe("workspace names", () => {
  it("refuses a name over the limit on create and on rename, and keeps the old name", async () => {
    const owner = `kan68-${Date.now()}@example.com`;
    await expect(createWorkspace({ name: "x".repeat(WORKSPACE_NAME_MAX + 1), owner })).rejects.toThrow(/characters or fewer/);

    const ws = await createWorkspace({ name: "KAN-68 name test", owner });
    created.push(ws.id);
    await expect(
      renameWorkspace({ workspace_id: ws.id, name: "y".repeat(WORKSPACE_NAME_MAX + 1), by: owner }),
    ).rejects.toThrow(/characters or fewer/);
    expect((await getWorkspace(ws.id))?.name).toBe("KAN-68 name test");

    await renameWorkspace({ workspace_id: ws.id, name: `  ${"z".repeat(WORKSPACE_NAME_MAX)}  `, by: owner });
    expect((await getWorkspace(ws.id))?.name).toBe("z".repeat(WORKSPACE_NAME_MAX));
  });
});
