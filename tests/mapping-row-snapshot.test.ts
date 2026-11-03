/** Mapping-row snapshots ignore collection order while preserving stale-write protection. */
import { beforeEach, describe, expect, it } from "vitest";
import "@/modules";
import { POST } from "@/app/api/iegp/route";
import { buildMappingTableView } from "@/lib/iegp/mapping-table";
import { requireRelationshipSnapshot } from "@/lib/iegp/relationship-change";
import { mappingRowRelationshipVersion, relationshipVersion } from "@/lib/iegp/relationship-version";
import { buildSeed } from "@/lib/iegp/seed";
import { loadState, persistState } from "@/lib/iegp/store";

function fixture() {
  const state = buildSeed();
  const gapId = state.gaps[0].id;
  const coverage = state.coverages[0];
  state.coverages = [
    { ...coverage, id: "coverage-z", gap_id: gapId, tactic_id: state.tactics[0].id },
    { ...coverage, id: "coverage-a", gap_id: gapId, tactic_id: state.tactics[1].id },
  ];
  state.mapping_suggestions = state.coverages.map(row => ({
    gap_id: gapId, tactic_id: row.tactic_id, status: "accepted" as const, lock: coverage.overall_lock,
  }));
  return { state, gapId };
}

function openingToken(state: ReturnType<typeof buildSeed>, gapId: string) {
  return buildMappingTableView(state, null).find(row => row.gap_id === gapId)!.relationships_version!;
}

describe("mapping-row opening snapshots", () => {
  it.each(["coverages", "decisions", "both"])("produces the same token when unchanged %s arrive reordered", collection => {
    // Arrange: the same logical records, with independent collection order.
    const { state, gapId } = fixture();
    const original = openingToken(state, gapId);
    const reordered = {
      ...state,
      coverages: collection === "decisions" ? state.coverages : [...state.coverages].reverse(),
      mapping_suggestions: collection === "coverages" ? state.mapping_suggestions : [...state.mapping_suggestions].reverse(),
    };

    // Act / Assert: neither the token nor its guard mistakes row order for an edit.
    expect(openingToken(reordered, gapId)).toBe(original);
    expect(() => requireRelationshipSnapshot(reordered, { action: "save_mapping_row", gap_id: gapId, expected_relationship: original })).not.toThrow();
    expect(state.coverages.map(row => row.id)).toEqual(["coverage-z", "coverage-a"]);
  });

  it("accepts already-open legacy tokens with unsorted collections", () => {
    const { state, gapId } = fixture();
    // This is the exact serialization used before mapping-row canonicalization.
    const legacy = relationshipVersion({ coverages: [...state.coverages].reverse(), decisions: [...state.mapping_suggestions].reverse() });
    expect(() => requireRelationshipSnapshot(state, { action: "save_mapping_row", gap_id: gapId, expected_relationship: legacy })).not.toThrow();
  });

  it.each(["coverage content", "decision content", "additional coverage", "removed decision"] as const)("rejects a genuine change to %s", change => {
    const { state, gapId } = fixture();
    const expected_relationship = openingToken(state, gapId);
    if (change === "coverage content") state.coverages[0] = { ...state.coverages[0], overall_rationale: "A newer assessment" };
    if (change === "decision content") state.mapping_suggestions[0] = { ...state.mapping_suggestions[0], status: "rejected" };
    if (change === "additional coverage") state.coverages.push({ ...state.coverages[0], id: "coverage-new" });
    if (change === "removed decision") state.mapping_suggestions.pop();
    expect(() => requireRelationshipSnapshot(state, { action: "save_mapping_row", gap_id: gapId, expected_relationship })).toThrow(/Relationship changed/);
  });

  it.each(["", "invalid JSON", "null", "{}", '{"coverages":[null],"decisions":[]}'])("rejects malformed or missing opening snapshot %j", expected_relationship => {
    const { state, gapId } = fixture();
    expect(() => requireRelationshipSnapshot(state, { action: "save_mapping_row", gap_id: gapId, expected_relationship })).toThrow(/Relationship changed/);
  });

  it("preserves ordered nested arrays in mapping-row and generic serializers", () => {
    const forward = { coverages: [{ id: "coverage-a", assessment_history: [{ action: "invalidate" }, { action: "reassess" }] }], decisions: [] };
    const reverse = { coverages: [{ id: "coverage-a", assessment_history: [{ action: "reassess" }, { action: "invalidate" }] }], decisions: [] };
    expect(mappingRowRelationshipVersion(forward)).not.toBe(mappingRowRelationshipVersion(reverse));
    expect(relationshipVersion(forward)).not.toBe(relationshipVersion(reverse));
  });
});

describe("mapping-row route snapshots", () => {
  beforeEach(async () => { await persistState(fixture().state); });

  it("saves unchanged relationships from a reversed legacy token", async () => {
    // Arrange: reverse only the request's opening order, without changing persisted records.
    const state = await loadState();
    const gapId = state.gaps[0].id;
    const expected_relationship = relationshipVersion({
      coverages: state.coverages.filter(row => row.gap_id === gapId).reverse(),
      decisions: state.mapping_suggestions.filter(row => row.gap_id === gapId).reverse(),
    });

    // Act: exercise the real route, transaction lock and snapshot guard.
    const response = await POST(new Request("http://localhost/api/iegp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_mapping_row", gap_id: gapId,
        tactic_ids: state.coverages.filter(row => row.gap_id === gapId).map(row => row.tactic_id).join(","),
        mapping_status: "partially_addressed", rationale: "Review unchanged parent choices",
        actor_name: "Snapshot reviewer", actor_function: "medical_affairs", expected_relationship }),
    }));

    // Assert: order alone is accepted and the selected relationships survive.
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    expect((await loadState()).coverages.filter(row => row.gap_id === gapId).map(row => row.id).sort()).toEqual(["coverage-a", "coverage-z"]);
  });

  it("rejects a stale content token without saving the requested selection", async () => {
    const state = await loadState();
    const gapId = state.gaps[0].id;
    const expected_relationship = openingToken(state, gapId);
    state.coverages[0].overall_rationale = "Assessment updated after opening";
    await persistState(state);
    const before = await loadState();

    const response = await POST(new Request("http://localhost/api/iegp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_mapping_row", gap_id: gapId, tactic_ids: "",
        mapping_status: "open", rationale: "Stale attempt to clear parent choices",
        actor_name: "Snapshot reviewer", actor_function: "medical_affairs", expected_relationship }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/Relationship changed/) });
    const after = await loadState();
    expect(after.coverages).toEqual(before.coverages);
    expect(after.mapping_suggestions).toEqual(before.mapping_suggestions);
  });
});
