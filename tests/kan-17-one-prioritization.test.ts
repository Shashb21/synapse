import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes read the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import nextConfig, { RETIRED_PLAN_REDIRECTS } from "../next.config";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { iegpActionCapability } from "@/app/api/iegp/capabilities";
import { db } from "@/lib/iegp/db";
import { legacyPlanCarryOverStatements } from "@/lib/iegp/legacy-plan";
import { buildSeed } from "@/lib/iegp/seed";
import { loadState, persistState } from "@/lib/iegp/store";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";

const LEAD = { locked: true, actor_name: "S. Iyer", actor_function: "evidence_lead", locked_at: "2026-03-01T09:00:00.000Z", note: null };
const OPEN = { locked: false, actor_name: null, actor_function: null, locked_at: null, note: null };

async function exec(statement: string) {
  return db().execute(sql.raw(statement));
}

async function carryOver() {
  for (const statement of legacyPlanCarryOverStatements()) await exec(statement);
}

const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

async function legacyPriority(id: string, residual: string, band: string, lock: object, reason: string | null = null) {
  await exec(
    `INSERT INTO priorities (id, residual_id, suggested_score, suggested_band, band, override_reason, reasons, lock)
     VALUES ('${id}', '${residual}', 0, '${band}', '${band}', ${reason ? `'${reason}'` : "NULL"}, '[]'::jsonb, ${json(lock)})`,
  );
}

async function legacyRoadmap(id: string, tactic: string, residuals: string[]) {
  await exec(
    `INSERT INTO roadmap (id, tactic_id, residual_ids, start_date, evidence_available, owner, note, lock)
     VALUES ('${id}', '${tactic}', ${json(residuals)}, NULL, NULL, 'L. Chen', NULL, ${json(LEAD)})`,
  );
}

describe("KAN-17: one prioritization system", () => {
  beforeEach(async () => {
    await persistState(buildSeed());
    await resetWorkspaceModules();
    await carryOver(); // add the marker columns before the fixtures use them
  });

  it("carries locked legacy bands into S8 as validated bands, once, without overwriting S8", async () => {
    await validatePlacement({
      gap_id: "GAP-CNS",
      band: "high",
      rationale: "Set on the matrix before the board retired",
      actor: { name: "A. Rao", function: "heor" },
    });
    await legacyPriority("PRI-T1", "RES-PERSIST", "critical", LEAD);
    await legacyPriority("PRI-T2", "RES-CNS", "low", LEAD, "Board said low");
    await legacyPriority("PRI-T3", "RES-OS", "medium", OPEN);
    await legacyPriority("PRI-T4", "RES-CAREGIVER", "low", LEAD, "Not HTA-critical this cycle");

    await carryOver();
    const byGap = new Map((await listPlacements()).map((row) => [row.gap_id, row]));
    // Critical folds into High; the person who locked it stays the actor.
    expect(byGap.get("GAP-PERSIST")).toMatchObject({ band: "high", validated: true, actor_name: "S. Iyer", human_band: true });
    expect(byGap.get("GAP-PERSIST")?.rationale).toMatch(/retired priority board \(critical\)/);
    expect(byGap.get("GAP-CAREGIVER")).toMatchObject({ band: "low", validated: true, rationale: "Not HTA-critical this cycle" });
    // S8 already had a band: the matrix wins.
    expect(byGap.get("GAP-CNS")).toMatchObject({ band: "high", actor_name: "A. Rao" });
    // An unlocked legacy band was never a decision.
    expect(byGap.has("GAP-OS")).toBe(false);

    const audit = (await loadState()).audit.filter((row) => row.action === "carry_over_priority");
    expect(audit.map((row) => row.entity_id).sort()).toEqual(["GAP-CAREGIVER", "GAP-PERSIST"]);

    // Processed rows are marked; a later run (or a later legacy edit) changes nothing.
    await exec("UPDATE priorities SET band = 'medium' WHERE id = 'PRI-T4'");
    await carryOver();
    expect((await listPlacements()).find((row) => row.gap_id === "GAP-CAREGIVER")?.band).toBe("low");
    const marked = (await exec("SELECT count(*)::int AS n FROM priorities WHERE carried_over_at IS NULL")) as unknown as { n: number }[];
    expect(marked[0]!.n).toBe(0);
  });

  it("maps tactics the roadmap planned against a gap's residual, unassessed, unless mapped or rejected", async () => {
    await exec(
      `INSERT INTO mapping_suggestions (gap_id, tactic_id, status, lock) VALUES ('GAP-SEQ', 'TAC-HCRU', 'rejected', ${json(LEAD)})`,
    );
    await legacyRoadmap("RM-T1", "TAC-REG", ["RES-OS"]);
    await legacyRoadmap("RM-T2", "TAC-LTFU", ["RES-OS"]); // already mapped (COV-OS-LTFU)
    await legacyRoadmap("RM-T3", "TAC-HCRU", ["RES-SEQ"]); // a person rejected this pair

    await carryOver();
    await carryOver();
    const state = await loadState();
    const reg = state.coverages.filter((row) => row.gap_id === "GAP-OS" && row.tactic_id === "TAC-REG");
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ overall: "unassessed", stale: false });
    expect(reg[0]!.overall_lock.locked).toBe(false);
    expect(reg[0]!.overall_rationale).toMatch(/retired roadmap/);
    expect(state.coverages.filter((row) => row.gap_id === "GAP-OS" && row.tactic_id === "TAC-LTFU")).toHaveLength(1);
    expect(state.coverages.some((row) => row.gap_id === "GAP-SEQ" && row.tactic_id === "TAC-HCRU")).toBe(false);
    const audit = state.audit.filter((row) => row.action === "carry_over_roadmap");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_id: "GAP-OS", actor_name: "S. Iyer" });
  });

  it("refuses the retired actions with 410 and says where they went", async () => {
    for (const [action, where] of [
      ["lock_priority", /Prioritize matrix/],
      ["lock_residual", /reviewed on Gaps/],
      ["lock_roadmap", /Timeline/],
    ] as const) {
      expect(iegpActionCapability(action)).toBeUndefined();
      const res = await iegpPost(
        new Request("http://localhost/api/iegp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, residual_id: "RES-OS", band: "high", tactic_id: "TAC-REG" }),
        }),
      );
      expect(res.status, action).toBe(410);
      expect(((await res.json()) as { error: string }).error).toMatch(where);
    }
  });

  it("redirects the retired pages to the canonical ones and removes them from the nav", async () => {
    const rules = await nextConfig.redirects!();
    const destination = (source: string) => rules.find((rule) => rule.source === source)?.destination;
    expect(destination("/residuals")).toBe("/?place=gaps");
    expect(destination("/roadmap")).toBe("/timeline");
    expect(RETIRED_PLAN_REDIRECTS).toHaveLength(2);
    for (const page of ["residuals", "roadmap"]) {
      expect(existsSync(path.join(process.cwd(), "src/app", page, "page.tsx"))).toBe(false);
    }
    const chrome = readFileSync(path.join(process.cwd(), "src/components/plan-chrome.tsx"), "utf8");
    expect(chrome).not.toMatch(/"\/residuals"|"\/roadmap"/);
  });

  it("no longer mirrors S8 bands into the legacy board", async () => {
    await validatePlacement({
      gap_id: "GAP-PERSIST",
      band: "medium",
      rationale: "Matrix decision only",
      actor: { name: "A. Rao", function: "heor" },
    });
    const rows = (await exec("SELECT count(*)::int AS n FROM priorities")) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });
});
