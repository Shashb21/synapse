import { describe, expect, it } from "vitest";
import { POST as workshopPost, GET as workshopGet } from "@/app/api/accuracy/workshop/route";
import { POST as workshopActionPost } from "@/app/api/accuracy/workshop/actions/route";
import { POST as workshopTagsPost } from "@/app/api/accuracy/workshop/tags/route";
import { registerAccuracyStack } from "@/accuracy";
import {
  boardsFromFacilitatorTags,
  evaluateWorkshopReadiness,
  UNASSIGNED_BOARD_ID,
} from "@/accuracy/modules/workshop/readiness";
import { assertWorkshopAction } from "@/accuracy/modules/workshop/actions";
import { claimMetadata, insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { listCoverageJoins, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import {
  applyWorkshopAction,
  createWorkshopSnapshot,
  getWorkshopSnapshot,
  latestWorkshopSnapshot,
} from "@/accuracy/store/workshop-store";

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
  return { org_id, workspace_id };
}

async function seedReadyWorkspace(label: string) {
  const ctx = await freshWorkspace(label);
  const gap = await insertClaim({
    workspace_id: ctx.workspace_id,
    claim_type: "gap",
    statement: "Need OS by biomarker subgroup",
    validated: true,
    status: "validated",
    metadata: { source_badge: "interview" },
  });
  const tactic = await insertClaim({
    workspace_id: ctx.workspace_id,
    claim_type: "tactic",
    statement: "Prospective biomarker OS follow-up",
    validated: true,
    status: "planned",
    metadata: { origin: "inventory", tactic_status: "planned", gap_ids: [gap.id] },
  });
  return { ...ctx, gap, tactic };
}

function jsonRequest(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workshop readiness gate", () => {
  it("blocks empty live inventory", () => {
    const result = evaluateWorkshopReadiness({ gaps: [] });
    expect(result.ready).toBe(false);
    expect(result.blockers[0]).toMatch(/no live gaps/i);
  });

  it("blocks unvalidated live gaps", () => {
    const result = evaluateWorkshopReadiness({
      gaps: [{ id: "g1", validated: false, status: "draft", coverage_status: "open" }],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/not validated/i);
  });

  it("blocks partial residuals", () => {
    const result = evaluateWorkshopReadiness({
      gaps: [{ id: "g1", validated: true, status: "validated", coverage_status: "partial" }],
    });
    expect(result.ready).toBe(false);
    expect(result.partial_gap_ids).toEqual(["g1"]);
    expect(result.blockers.join(" ")).toMatch(/partially addressed/i);
  });

  it("is ready when every live gap is validated open or addressed", () => {
    const result = evaluateWorkshopReadiness({
      gaps: [
        { id: "g1", validated: true, status: "validated", coverage_status: "open" },
        { id: "g2", validated: true, status: "validated", coverage_status: "addressed" },
        { id: "g3", validated: false, status: "rejected", coverage_status: "open" },
      ],
    });
    expect(result.ready).toBe(true);
    expect(result.live_gap_count).toBe(2);
  });
});

describe("facilitator tag boards", () => {
  it("puts untagged gaps on Unassigned, never chapter-only", () => {
    const boards = boardsFromFacilitatorTags(
      [
        {
          id: "g1",
          statement: "Need A",
          validated: true,
          status: "validated",
          coverage_status: "open",
          priority: null,
          source_badge: null,
        },
        {
          id: "g2",
          statement: "Need B",
          validated: true,
          status: "validated",
          coverage_status: "open",
          priority: null,
          source_badge: null,
        },
      ],
      {
        tags: [{ id: "tag_heor", label: "HEOR access" }],
        assignments: { g1: "tag_heor" },
      },
    );
    expect(boards.map((b) => b.id)).toEqual(["tag_heor", UNASSIGNED_BOARD_ID]);
    expect(boards[0]?.gaps.map((g) => g.id)).toEqual(["g1"]);
    expect(boards[1]?.gaps.map((g) => g.id)).toEqual(["g2"]);
  });
});

describe("workshop action rationale gate", () => {
  it("rejects blank or short rationale before any write", () => {
    expect(() =>
      assertWorkshopAction({ kind: "park", gap_id: "g1", rationale: "  " }),
    ).toThrow(/rationale/i);
    expect(() =>
      assertWorkshopAction({ kind: "mark_addressed", gap_id: "g1", rationale: "no", tactic_id: "t1" }),
    ).toThrow(/rationale/i);
  });

  it("requires a snapshot tactic to mark addressed", () => {
    expect(() =>
      assertWorkshopAction({ kind: "mark_addressed", gap_id: "g1", rationale: "Room agreed" }),
    ).toThrow(/tactic/i);
  });
});

describe("workshop snapshot store", () => {
  it("refuses to freeze when a live gap is unvalidated", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("ws-unval");
    await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Draft gap",
      validated: false,
    });
    await expect(
      createWorkshopSnapshot({
        workspace_id,
        actor: { name: "Ada", function: "medical_affairs" },
      }),
    ).rejects.toThrow(/validated/i);
  });

  it("refuses to freeze validated partial residuals", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("ws-partial");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Partially covered need",
      validated: true,
      status: "validated",
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "Partial inventory tactic",
      validated: true,
      status: "planned",
      metadata: { tactic_status: "planned" },
    });
    await upsertCoverageDecision({
      workspace_id,
      gap_id: gap.id,
      tactic_id: tactic.id,
      overall: "partial",
      rationale: "Only covers the safety slice",
    });
    await expect(
      createWorkshopSnapshot({
        workspace_id,
        actor: { name: "Ada", function: "medical_affairs" },
      }),
    ).rejects.toThrow(/partial/i);
  });

  it("saves a workspace-scoped freeze and hides it from another workspace", async () => {
    registerAccuracyStack();
    const ready = await seedReadyWorkspace("ws-ok");
    const other = await freshWorkspace("ws-other");
    const snapshot = await createWorkshopSnapshot({
      workspace_id: ready.workspace_id,
      actor: { name: "Ada", function: "medical_affairs" },
      note: "Room freeze after coverage",
    });
    expect(snapshot.workspace_id).toBe(ready.workspace_id);
    expect(snapshot.payload.inventory.gaps).toHaveLength(1);
    expect(await latestWorkshopSnapshot(ready.workspace_id)).toMatchObject({ id: snapshot.id });
    expect(await getWorkshopSnapshot(other.workspace_id, snapshot.id)).toBeNull();
    expect(await latestWorkshopSnapshot(other.workspace_id)).toBeNull();
  });
});

describe("workshop rationale-gated writes", () => {
  it("does not write coverage when mark addressed has no rationale", async () => {
    registerAccuracyStack();
    const ready = await seedReadyWorkspace("act-norat");
    const snapshot = await createWorkshopSnapshot({
      workspace_id: ready.workspace_id,
      actor: { name: "Ada", function: "medical_affairs" },
    });
    const res = await workshopActionPost(
      jsonRequest("http://localhost/api/accuracy/workshop/actions", {
        workspace_id: ready.workspace_id,
        snapshot_id: snapshot.id,
        kind: "mark_addressed",
        gap_id: ready.gap.id,
        tactic_id: ready.tactic.id,
        rationale: "x",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/rationale/i);
    expect(await listCoverageJoins(ready.workspace_id)).toHaveLength(0);
  });

  it("mark addressed writes through coverage API semantics with rationale", async () => {
    registerAccuracyStack();
    const ready = await seedReadyWorkspace("act-addr");
    const snapshot = await createWorkshopSnapshot({
      workspace_id: ready.workspace_id,
      actor: { name: "Ada", function: "medical_affairs" },
    });
    const next = await applyWorkshopAction({
      workspace_id: ready.workspace_id,
      snapshot_id: snapshot.id,
      actor: { name: "Ada", function: "medical_affairs" },
      action: {
        kind: "mark_addressed",
        gap_id: ready.gap.id,
        tactic_id: ready.tactic.id,
        rationale: "KOL panel agreed the registry fully covers this need",
      },
    });
    const joins = await listCoverageJoins(ready.workspace_id);
    expect(joins).toHaveLength(1);
    expect(joins[0]?.overall).toBe("covers");
    expect(joins[0]?.rationale).toMatch(/KOL panel/);
    expect(joins[0]?.validated).toBe(true);
    expect(next.payload.overlays[ready.gap.id]?.coverage_status).toBe("addressed");
    expect(next.payload.actions[0]?.origin).toBe("workshop");
  });

  it("park requires rationale and does not edit the ledger claim", async () => {
    registerAccuracyStack();
    const ready = await seedReadyWorkspace("act-park");
    const snapshot = await createWorkshopSnapshot({
      workspace_id: ready.workspace_id,
      actor: { name: "Ada", function: "medical_affairs" },
    });
    const before = await listClaims(ready.workspace_id, { claim_type: "gap" });
    const next = await applyWorkshopAction({
      workspace_id: ready.workspace_id,
      snapshot_id: snapshot.id,
      actor: { name: "Ada", function: "medical_affairs" },
      action: {
        kind: "park",
        gap_id: ready.gap.id,
        rationale: "Park for Friday HEOR breakout",
      },
    });
    const after = await listClaims(ready.workspace_id, { claim_type: "gap" });
    expect(after[0]?.status).toBe(before[0]?.status);
    expect(after[0]?.validated).toBe(true);
    expect(claimMetadata(after[0]!).priority).toBeUndefined();
    expect(next.payload.overlays[ready.gap.id]?.parked).toBe(true);
    expect(await listCoverageJoins(ready.workspace_id)).toHaveLength(0);
  });

  it("priority write records rationale and workshop origin on the claim", async () => {
    registerAccuracyStack();
    const ready = await seedReadyWorkspace("act-pri");
    const snapshot = await createWorkshopSnapshot({
      workspace_id: ready.workspace_id,
      actor: { name: "Ada", function: "medical_affairs" },
    });
    await applyWorkshopAction({
      workspace_id: ready.workspace_id,
      snapshot_id: snapshot.id,
      actor: { name: "Ada", function: "medical_affairs" },
      action: {
        kind: "set_priority",
        gap_id: ready.gap.id,
        priority: "high",
        rationale: "Launch-critical OS question",
      },
    });
    const gaps = await listClaims(ready.workspace_id, { claim_type: "gap" });
    const meta = claimMetadata(gaps[0]!);
    expect(meta.priority).toBe("high");
    expect(meta.priority_rationale).toMatch(/Launch-critical/);
    expect(meta.priority_origin).toBe("workshop");
  });
});

describe("workshop HTTP routes", () => {
  it("POST snapshot returns 409 when the gate fails", async () => {
    registerAccuracyStack();
    const { workspace_id } = await freshWorkspace("http-409");
    await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Still draft",
      validated: false,
    });
    const res = await workshopPost(
      jsonRequest("http://localhost/api/accuracy/workshop", { workspace_id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/validated/i);
  });

  it("GET is workspace-scoped and POST freeze then tag assign works", async () => {
    registerAccuracyStack();
    const ready = await seedReadyWorkspace("http-ok");
    const created = await workshopPost(
      jsonRequest("http://localhost/api/accuracy/workshop", {
        workspace_id: ready.workspace_id,
        note: "Freeze for Tuesday workshop",
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      snapshot: { id: string; payload: { facilitator_tags: { tags: { id: string }[] } } };
    };
    const get = await workshopGet(
      new Request(
        `http://localhost/api/accuracy/workshop?workspace_id=${encodeURIComponent(ready.workspace_id)}`,
      ),
    );
    expect(get.status).toBe(200);
    const got = (await get.json()) as { readiness: { ready: boolean }; snapshot: { id: string } };
    expect(got.readiness.ready).toBe(true);
    expect(got.snapshot.id).toBe(createdBody.snapshot.id);

    const tagged = await workshopTagsPost(
      jsonRequest("http://localhost/api/accuracy/workshop/tags", {
        workspace_id: ready.workspace_id,
        snapshot_id: createdBody.snapshot.id,
        action: "add_tag",
        label: "Biomarkers",
      }),
    );
    expect(tagged.status).toBe(200);
    const taggedBody = (await tagged.json()) as {
      snapshot: { payload: { facilitator_tags: { tags: { id: string; label: string }[] } } };
    };
    expect(taggedBody.snapshot.payload.facilitator_tags.tags[0]?.label).toBe("Biomarkers");
  });
});
