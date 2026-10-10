import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** A request cookie jar the route handlers read and createSession writes. */
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import { eq, sql } from "drizzle-orm";
import "@/modules";
import { GET as finalGet } from "@/app/api/plan/final/[version]/route";
import * as iegp from "@/lib/iegp/schema";
import { db as workspaceDb } from "@/lib/iegp/db";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState, resetDemo } from "@/lib/iegp/store";
import { db, ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import { listEdits } from "@/modules/kernel/edit-records";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";
import {
  addTimelineActivity,
  planVersion,
  savePlan,
  timelineModel,
} from "@/modules/stages/s10-timeline/module";
import {
  canonicalJson,
  FINAL_PACKAGE_SCHEMA,
  LEGACY_PACKAGE_NOTE,
  NO_WORKSHOP,
  packageFingerprint,
  type FinalPackage,
} from "@/modules/stages/s10-timeline/final-package";
import { finalPlanView } from "@/modules/stages/s10-timeline/final-view";
import { makeFinalReady } from "./support/final-ready";

/**
 * KAN-86: a final save freezes the complete IEGP (gap inventory, tactics,
 * prioritisation, roadmap, open items and lineage) as one fingerprinted
 * version, read back only from what was frozen.
 */

const ACTOR = { name: "Final Plan Lead", function: "medical_affairs" as const };

async function dateEverything() {
  const pending = (await timelineModel()).pending;
  for (const [index, row] of pending.entries()) {
    await addTimelineActivity({
      tactic_id: row.tactic_id,
      expansion_id: row.expansion_id,
      start_date: `${2026 + index}-01-01`,
      end_date: `${2026 + index}-06-01`,
      rationale: "Dated in planning",
      actor: ACTOR,
    });
  }
}

/** A seeded plan with every activity dated by hand (no estimates to review). */
async function datedDemo() {
  await resetDemo();
  await wipePlatform();
  await ensurePlatformSchema();
  await dateEverything();
}

describe("KAN-86: the final plan is the complete, frozen IEGP", () => {
  beforeAll(async () => {
    await datedDemo();
  }, 60_000);

  it("refuses a final while gaps are unresolved, names each one, and still saves a draft", async () => {
    const state = await loadState();
    const partial = state.gaps.filter(isLiveGap).find((gap) => displayedGapStatus(gap) === "validated_partial")!;
    const refusal = await savePlan({ status: "final", note: "Sign off", actor: ACTOR }).catch((error: Error) => error.message);
    expect(refusal).toMatch(/complete plan cannot be saved as final yet/);
    expect(refusal).toContain(`${partial.name} (${partial.id}) is Partially Addressed`);
    expect(refusal).toMatch(/is still a candidate/);
    expect(refusal).toMatch(/Unscheduled, deferred, parked and excluded gaps do not block it/);
    const draft = await savePlan({ status: "draft", note: "Work in progress", actor: ACTOR });
    expect(draft.snapshot.package).toBeUndefined();
  });

  it("freezes every part of the plan, with a fingerprint over the whole package", async () => {
    await makeFinalReady(ACTOR);
    await dateEverything();
    const plan = await savePlan({ status: "final", note: "Signed off in the Q1 review", actor: ACTOR });
    const pkg = plan.snapshot.package!;
    expect(pkg.schema_version).toBe(FINAL_PACKAGE_SCHEMA);
    expect(plan.snapshot.schema_version).toBe(FINAL_PACKAGE_SCHEMA);
    const state = await loadState();
    const live = state.gaps.filter(isLiveGap);
    // Every live gap, whatever its status or band.
    expect(pkg.evidence_gap_inventory.map((g) => g.id).sort()).toEqual(live.map((g) => g.id).sort());
    expect(pkg.evidence_gap_inventory.some((g) => g.effective_status === "validated_addressed")).toBe(true);
    const withSource = pkg.evidence_gap_inventory.find((g) => g.needs.some((n) => n.source));
    expect(withSource, "needs carry their source documents").toBeTruthy();
    expect(pkg.evidence_tactics.length).toBe(state.tactics.length);
    expect(pkg.evidence_tactics.every((x) => x.evidence_state && x.origin)).toBe(true);
    expect(pkg.prioritisation.placements.every((p) => live.some((g) => g.id === p.gap_id))).toBe(true);
    const open = live.filter((g) => displayedGapStatus(g) === "validated_open");
    for (const gap of open) {
      expect(pkg.prioritisation.placements.find((p) => p.gap_id === gap.id)?.validated).toBe(true);
    }
    expect(pkg.roadmap.activities.length).toBeGreaterThan(0);
    expect(pkg.roadmap.fingerprint).toBe(plan.snapshot.fingerprint);
    expect(pkg.workshop_outcomes).toEqual({ status: "none", note: NO_WORKSHOP });
    expect(pkg.open_items.limitations).toContain(NO_WORKSHOP);
    expect(pkg.lineage.source_ids.length).toBe(state.sources.length);
    expect(plan.snapshot.package_fingerprint).toBe(packageFingerprint(pkg));
    expect(plan.snapshot.package_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The save is on the record with its fingerprint.
    const edit = (await listEdits({ entity_id: plan.id })).find((row) => row.entity_type === "iegp_plan");
    expect(edit?.after).toContain(plan.snapshot.package_fingerprint!);

    // Read back only from what was frozen.
    const view = finalPlanView((await planVersion(plan.version))!);
    expect(view.kind).toBe("complete");
    if (view.kind === "complete") {
      expect(view.intact).toBe(true);
      expect(canonicalJson(view.package)).toBe(canonicalJson(pkg));
    }
  });

  it("keeps a saved final exactly as it was after live gap, tactic and priority edits; a new save is a new version", async () => {
    const [latest] = await db().select().from(t.iegpPlans).orderBy(sql`version desc`).limit(1);
    const before = canonicalJson(latest!.snapshot);
    const state = await loadState();
    const gap = state.gaps.filter(isLiveGap).find((g) => displayedGapStatus(g) === "validated_open")!;
    const tactic = state.tactics[0]!;
    await workspaceDb().update(iegp.gaps).set({ statement: "Edited after the final was saved." }).where(eq(iegp.gaps.id, gap.id));
    await workspaceDb().update(iegp.tactics).set({ owner: "Someone new" }).where(eq(iegp.tactics.id, tactic.id));
    const band = (await listPlacements()).find((p) => p.gap_id === gap.id)!.band === "high" ? "low" : "high";
    await validatePlacement({ gap_id: gap.id, band, rationale: "Re-banded after the review", actor: ACTOR });

    const reread = await planVersion(latest!.version);
    expect(canonicalJson(reread!.snapshot)).toBe(before);
    const frozenGap = (reread!.snapshot.package as FinalPackage).evidence_gap_inventory.find((g) => g.id === gap.id)!;
    expect(frozenGap.statement).not.toBe("Edited after the final was saved.");

    const next = await savePlan({ status: "final", note: "Re-signed after edits", actor: ACTOR });
    expect(next.version).toBe(latest!.version + 1);
    expect(next.snapshot.package_fingerprint).not.toBe((latest!.snapshot as { package_fingerprint: string }).package_fingerprint);
    expect(next.snapshot.package!.evidence_gap_inventory.find((g) => g.id === gap.id)!.statement).toBe("Edited after the final was saved.");
  });

  it("gives concurrent saves different versions", async () => {
    const [a, b] = await Promise.all([
      savePlan({ status: "draft", note: "First at once", actor: ACTOR }),
      savePlan({ status: "draft", note: "Second at once", actor: ACTOR }),
    ]);
    expect(a.version).not.toBe(b.version);
    expect(Math.abs(a.version - b.version)).toBe(1);
  });

  it("writes nothing when the save fails part-way", async () => {
    const count = async () => (await db().select().from(t.iegpPlans)).length;
    const before = await count();
    // The edit record is the last write: make it fail and the plan row must go with it.
    await db().execute(sql.raw(`CREATE OR REPLACE FUNCTION kan86_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.entity_type = 'iegp_plan' THEN RAISE EXCEPTION 'kan86 forced failure'; END IF; RETURN NEW; END $$`));
    await db().execute(sql.raw(`DROP TRIGGER IF EXISTS kan86_fail ON public.edit_records`));
    await db().execute(sql.raw(`CREATE TRIGGER kan86_fail BEFORE INSERT ON public.edit_records FOR EACH ROW EXECUTE FUNCTION kan86_fail()`));
    try {
      await expect(savePlan({ status: "final", note: "Should roll back", actor: ACTOR })).rejects.toThrow();
    } finally {
      await db().execute(sql.raw(`DROP TRIGGER IF EXISTS kan86_fail ON public.edit_records`));
    }
    expect(await count()).toBe(before);
  });
});

describe("KAN-86: the fingerprint covers every material field", () => {
  it("changes when any part of the plan changes, not when only the build time does", async () => {
    const latest = (await db().select().from(t.iegpPlans).orderBy(sql`version desc`)).find(
      (row) => (row.snapshot as { package?: unknown }).package,
    );
    const pkg = (latest!.snapshot as { package: FinalPackage }).package;
    const base = packageFingerprint(pkg);
    const variants: [string, (p: FinalPackage) => void][] = [
      ["gap statement", (p) => void (p.evidence_gap_inventory[0]!.statement += " changed")],
      ["gap status", (p) => void (p.evidence_gap_inventory[0]!.effective_status = "validated_addressed_x")],
      ["need quote", (p) => void (p.evidence_gap_inventory.find((g) => g.needs.length)!.needs[0]!.quote = "other")],
      ["tactic owner", (p) => void (p.evidence_tactics[0]!.owner = "Another owner")],
      ["tactic state", (p) => void (p.evidence_tactics[0]!.evidence_state = "cancelled")],
      ["priority band", (p) => void (p.prioritisation.placements[0]!.band = "defer")],
      ["roadmap date", (p) => void (p.roadmap.activities[0]!.end_date = "2099-01-01")],
      ["limitations", (p) => void p.open_items.limitations.push("A new limitation")],
      ["plan context", (p) => void (p.plan_context.asset.indication = "Something else")],
    ];
    for (const [label, mutate] of variants) {
      const copy = structuredClone(pkg);
      mutate(copy);
      expect(packageFingerprint(copy), label).not.toBe(base);
    }
    const rebuilt = structuredClone(pkg);
    rebuilt.built_at = "2099-12-31T00:00:00.000Z";
    expect(packageFingerprint(rebuilt)).toBe(base);
  });
});

describe("KAN-86: older finals stay readable as legacy packages", () => {
  it("marks a timeline-only final as legacy and fills in nothing", async () => {
    const [max] = (await db().execute(sql`select coalesce(max(version), 0)::int as max from iegp_plans`)) as unknown as { max: number }[];
    const version = max!.max + 1;
    await db().insert(t.iegpPlans).values({
      id: newId("plan"),
      version,
      status: "final",
      note: "Saved before KAN-86",
      saved_by: "Earlier Lead",
      saved_function: "medical_affairs",
      saved_at: nowIso(),
      snapshot: {
        activities: [],
        window: { start: "2026-01-01", end: "2026-12-31", months: 12 },
        lanes: [],
        unscheduled: [],
        counts: { gaps: 3, tactics: 2, open: 1, addressed: 2 },
      },
    });
    const view = finalPlanView((await planVersion(version))!);
    expect(view.kind).toBe("legacy");
    if (view.kind === "legacy") {
      expect(view.legacy_note).toBe(LEGACY_PACKAGE_NOTE);
      expect(view.timeline.counts.gaps).toBe(3);
      expect(view.timeline.fingerprint).toBeNull();
      expect("package" in view).toBe(false);
    }
  });
});

describe("KAN-86: the export is for members of the workspace only", () => {
  const unique = Math.random().toString(36).slice(2, 8);
  const OWNER = `kan86-owner-${unique}@example.com`;
  const OUTSIDER = `kan86-outsider-${unique}@example.com`;
  let home: Workspace;
  let other: Workspace;
  let version = 0;

  async function signIn(email: string, workspace: Workspace) {
    jar.values.clear();
    const session = await createSession({
      provider_id: "demo",
      subject: `demo:${email}`,
      email,
      actor_name: email,
      actor_function: "medical_affairs",
      role: "medical_affairs",
    });
    jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
  }

  const get = (v: number | string) =>
    finalGet(new Request(`http://localhost/api/plan/final/${v}`), { params: Promise.resolve({ version: String(v) }) });

  beforeAll(async () => {
    vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
    home = await createWorkspace({ name: `KAN-86 home ${unique}`, owner: OWNER });
    other = await createWorkspace({ name: `KAN-86 other ${unique}`, owner: OUTSIDER });
    await withWorkspace(home.id, async () => {
      await resetDemo();
      await dateEverything();
      await makeFinalReady(ACTOR);
      await dateEverything();
      version = (await savePlan({ status: "final", note: "Home sign-off", actor: ACTOR })).version;
    });
  }, 90_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    jar.values.clear();
  });

  it("returns the frozen package to a member", async () => {
    await signIn(OWNER, home);
    const res = await withWorkspace(home.id, () => get(version));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; package: FinalPackage; package_fingerprint: string };
    expect(body.kind).toBe("complete");
    expect(body.package.schema_version).toBe(FINAL_PACKAGE_SCHEMA);
    expect(body.package_fingerprint).toBe(packageFingerprint(body.package));
  });

  it("asks a signed-out caller to sign in", async () => {
    jar.values.clear();
    const res = await withWorkspace(home.id, () => get(version));
    expect(res.status).toBe(401);
  });

  it("does not show another workspace's plan, and refuses a bad version", async () => {
    await signIn(OUTSIDER, other);
    const res = await withWorkspace(other.id, () => get(version));
    expect(res.status).toBe(404);
    expect((await withWorkspace(other.id, () => get("abc"))).status).toBe(400);
  });
});
