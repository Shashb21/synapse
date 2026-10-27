import { describe, expect, it } from "vitest";
import { listClaims } from "@/accuracy/store/claim-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { accuracyClaims } from "@/accuracy/store/schema";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";

type ClaimFixture = typeof accuracyClaims.$inferInsert;

/** Create an isolated real-database workspace for claim selection assertions. */
async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`KAN-186 ${label}`);
  return createWorkspace({ org_id, name: label, slug: `kan186-${label}-${Date.now()}` });
}

/** Give every fixture a deterministic ordering without relying on insertion timing. */
function claim(workspace_id: string, index: number, claim_type: "gap" | "tactic"): ClaimFixture {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `${workspace_id}-${index}`,
    workspace_id,
    claim_type,
    statement: `${claim_type} ${index}`,
    status: "draft",
    validated: false,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("KAN-186 claim selection", () => {
  it.each(["gap", "tactic"] as const)("filters %s and workspace before applying a typed limit", async (claim_type) => {
    const workspace_id = await freshWorkspace(`typed-${claim_type}`);
    const otherWorkspace = await freshWorkspace(`other-${claim_type}`);
    const opposite = claim_type === "gap" ? "tactic" : "gap";
    const matching = [claim(workspace_id, 1, claim_type), claim(workspace_id, 2, claim_type)];
    await accuracyDb().insert(accuracyClaims).values([
      ...matching,
      claim(workspace_id, 3, opposite),
      claim(workspace_id, 4, opposite),
      claim(otherWorkspace, 5, claim_type),
    ]);

    const rows = await listClaims(workspace_id, { claim_type, limit: 1 });

    expect(rows.map((row) => row.id)).toEqual([matching[1]!.id]);
    expect(await listClaims(otherWorkspace, { claim_type, limit: 1 })).toHaveLength(1);
  });

  it("keeps the default 200-row bound and supports explicitly unlimited workspace queries", async () => {
    const workspace_id = await freshWorkspace("unlimited");
    const fixtures = Array.from({ length: 205 }, (_, index) => claim(workspace_id, index, index % 2 ? "gap" : "tactic"));
    await accuracyDb().insert(accuracyClaims).values(fixtures);
    const expectedIds = fixtures.slice().reverse().map((row) => row.id);

    expect((await listClaims(workspace_id)).map((row) => row.id)).toEqual(expectedIds.slice(0, 200));
    expect((await listClaims(workspace_id, { limit: null })).map((row) => row.id)).toEqual(expectedIds);
    expect((await listClaims(workspace_id, { claim_type: "tactic", limit: null })).map((row) => row.id)).toEqual(
      fixtures.filter((row) => row.claim_type === "tactic").reverse().map((row) => row.id),
    );
    expect(await listClaims(workspace_id, { limit: 0 })).toEqual([]);
  });
});
