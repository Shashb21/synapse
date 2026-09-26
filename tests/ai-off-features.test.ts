import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The routes read the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
// Client components call useRouter; there is no app router mounted in a test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => undefined,
  notFound: () => undefined,
}));

import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { POST as planPost } from "@/app/api/plan/route";
import { setAiEnabled } from "@/modules/kernel/ai-switch";
import { wipePlatform } from "@/modules/kernel/db";
import { listRuns } from "@/modules/kernel/observability";
import { runStage } from "@/modules/kernel/run";
import { loadState, resetSeed } from "@/lib/iegp/store";
import { displayedGapStatus, gapsReadyForPrioritize, isLiveGap } from "@/lib/iegp/engine";
import {
  buildMappingTableView,
  UNMAPPED_RATIONALE_AI,
  UNMAPPED_RATIONALE_MANUAL,
} from "@/lib/iegp/mapping-table";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";
import { latestPlan, timelineModel } from "@/modules/stages/s10-timeline/module";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { ManualStart } from "@/components/plan-cards";
import { PlanChrome, type PlanNavModel } from "@/components/plan-chrome";
import { layoutLabel, pendingReason } from "@/components/timeline/timeline-board";

/**
 * With the admin AI switch off the tool is fully manual: the first screen is
 * Add gaps / Add tactics, nothing is uploaded or parsed, AI actions answer 409
 * ai_off, and a whole plan can be built and saved final by hand.
 */

const ACTOR = { name: "AI Off Planner", function: "medical_affairs" as const };
const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

async function iegp(body: Record<string, string>) {
  const res = await iegpPost(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function plan(body: Record<string, unknown>) {
  const res = await planPost(
    new Request("http://localhost/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const NAV: PlanNavModel = {
  gapsCount: 0,
  unvalidatedCount: 0,
  partialCount: 0,
  gapsUnlocked: false,
  planUnlocked: false,
  tacticsUnlocked: false,
  setupComplete: false,
  readyForPrioritize: false,
};

// Children go in as createElement arguments, so the props types make them optional.
const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
const Chrome = PlanChrome as ComponentType<{ active: "upload"; nav: PlanNavModel; children?: ReactNode }>;

function renderChrome(ai: boolean) {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { enabled: ai },
      createElement(Chrome, { active: "upload", nav: NAV }, "body"),
    ),
  );
}

beforeAll(async () => {
  await setAiEnabled({ enabled: false, actor_name: ACTOR.name, rationale: "Manual-only test run" });
});

afterAll(async () => {
  // Leave AI on for every other test file.
  await setAiEnabled({ enabled: true, actor_name: ACTOR.name, rationale: "restore after the test" });
});

describe("the first screen with AI off", () => {
  it("renders Add gaps and Add tactics, and no ingest", () => {
    const html = renderToStaticMarkup(createElement(ManualStart, { gapCount: 0, tacticCount: 0 }));
    expect(html).toContain("Add gaps");
    expect(html).toContain("Add tactics");
    expect(html).not.toMatch(/ingest|upload|provider|Demo source/i);
  });

  it("wires the home page: IngestPanel only with AI on, ManualStart with AI off", () => {
    const page = src("src/app/page.tsx");
    expect(page).toContain("await aiEnabled()");
    expect(page).toMatch(/\{ai \? \(\s*<IngestPanel/);
    expect(page).toContain("<ManualStart");
    // Gaps never waits for an ingested source with AI off.
    expect(page).toContain("gates.gapsUnlocked || !ai");
    const sources = src("src/app/sources/page.tsx");
    expect(sources).toMatch(/\{ai \? \(\s*<>[\s\S]*<IngestPanel/);
    expect(sources).toMatch(/\{ai \? \(\s*<Link href="\/sources\/new"/);
  });

  it("names the first place Start and unlocks Gaps in the nav", () => {
    const off = renderChrome(false);
    expect(off).toContain("Start");
    expect(off).not.toContain(">Upload<");
    expect(off).toMatch(/href="\/\?place=gaps"/);
    // No readiness strip on an empty manual plan.
    expect(off).not.toContain('aria-label="Prep readiness"');
    const on = renderChrome(true);
    expect(on).toContain("Upload");
    // KAN-24: Gaps still opens with AI on and no source, but shows it is waiting.
    expect(on).toMatch(/href="\/\?place=gaps"/);
    expect(on).toContain('data-testid="nav-waiting-gaps"');
    expect(off).not.toContain('data-testid="nav-waiting-gaps"');
  });

  it("hides AI buttons and switches copy on the other places", () => {
    const matrix = src("src/components/prioritize/prioritize-matrix.tsx");
    expect(matrix).toContain("if (!ai || autoPlaced.current");
    expect(matrix).toContain("if (ai && gapIds.length > 0)");
    expect(matrix).toMatch(/\{ai \? \(\s*<button[\s\S]*Re-suggest unvalidated/);
    expect(src("src/components/split-gap-dialog.tsx")).toMatch(/\{ai \? \(\s*<Button[\s\S]*Suggest a split/);
    const ideation = src("src/app/ideation/page.tsx");
    expect(ideation.match(/\{ai \? \(\s*(<div>\s*)?<RunStageButton/g)?.length).toBe(3);
    expect(ideation).toContain("<AddIdeaDialog");
    expect(src("src/app/tactics/page.tsx")).toContain("ai || rejected.length > 0");
    expect(src("src/app/needs/page.tsx")).toContain("ai || rejected.length > 0");

    expect(layoutLabel(false, false)).toBe("Lay out dates");
    expect(layoutLabel(true, false)).toBe("Rebuild from validated state");
    const reason = "No start date yet. Date it by hand, or rebuild the timeline to have the model estimate it.";
    expect(pendingReason(reason, false)).toBe("No start date yet. Date it by hand or remove it.");
    expect(pendingReason(reason, true)).toBe(reason);
  });
});

describe("AI actions on the plan routes with AI off", () => {
  it("answers ingest with 409 ai_off and opens no run", async () => {
    const before = (await listRuns({ limit: 500 })).length;
    const demo = await iegp({ action: "ingest_demo", demo_id: "any" });
    expect(demo.status).toBe(409);
    expect(demo.json.code).toBe("ai_off");
    const typed = await iegp({
      action: "ingest",
      title: "Advisory board notes",
      source_type: "advisory_board",
      stakeholder_function: "medical_affairs",
      text: "Payers want comparative evidence.",
    });
    expect(typed.status).toBe(409);
    expect(typed.json.code).toBe("ai_off");
    expect((await listRuns({ limit: 500 })).length).toBe(before);
  });
});

describe("a whole plan by hand with AI off", () => {
  let addressedGap = "";
  let openGap = "";
  let inventoryTactic = "";
  let ideaTactic = "";

  beforeAll(async () => {
    await resetSeed();
    await wipePlatform();
  }, 60_000);

  it("adds gaps and tactics by hand", async () => {
    for (const statement of [
      "No real-world persistence data in second line.",
      "No comparative effectiveness evidence versus standard of care.",
    ]) {
      expect((await iegp({ action: "create_gap", statement, domain: "unmet_need" })).status).toBe(200);
    }
    const added = await iegp({
      action: "record_missed_tactic",
      name: "Persistence registry",
      type: "registry",
      status: "ongoing",
      evidence_question: "How long do second-line patients stay on therapy?",
    });
    expect(added.status).toBe(200);

    const state = await loadState();
    const live = state.gaps.filter(isLiveGap);
    addressedGap = live.find((gap) => gap.statement.startsWith("No real-world"))!.id;
    openGap = live.find((gap) => gap.statement.startsWith("No comparative"))!.id;
    inventoryTactic = state.tactics.find((tactic) => tactic.name === "Persistence registry")!.id;
    expect(state.tactics.find((tactic) => tactic.id === inventoryTactic)?.review_status).toBe("accepted");
  });

  it("maps a tactic with a coverage verdict and confirms every gap", async () => {
    const assigned = await iegp({
      action: "assign_tactic",
      gap_id: addressedGap,
      tactic_id: inventoryTactic,
      overall: "full",
      rationale: "The registry answers persistence directly",
    });
    expect(assigned.status).toBe(200);
    for (const gapId of [addressedGap, openGap]) {
      expect((await iegp({ action: "validate_gap", gap_id: gapId, note: "Checked by hand" })).status).toBe(200);
    }
    const state = await loadState();
    expect(displayedGapStatus(state.gaps.find((gap) => gap.id === addressedGap)!)).toBe("validated_addressed");
    expect(displayedGapStatus(state.gaps.find((gap) => gap.id === openGap)!)).toBe("validated_open");
    expect(gapsReadyForPrioritize(state)).toBe(true);
    expect((await iegp({ action: "complete_wizard" })).status).toBe(200);
  });

  it("validates a band by hand", async () => {
    const placed = await plan({
      action: "set_placement",
      gap_id: openGap,
      band: "high",
      validate: true,
      rationale: "Blocks the HTA dossier",
    });
    expect(placed.status).toBe(200);
    const placement = (await listPlacements()).find((row) => row.gap_id === openGap);
    expect(placement).toMatchObject({ band: "high", validated: true, human_band: true });
  });

  it("adds an idea by hand and accepts it", async () => {
    const idea = await plan({
      action: "add_proposal",
      gap_id: openGap,
      name: "Indirect treatment comparison",
      type: "rwe_study",
      evidence_question: "How does the asset compare with standard of care?",
      rationale: "Fastest route to comparative evidence",
    });
    expect(idea.status).toBe(200);
    const id = (idea.json.proposal as { id: string }).id;
    const decided = await plan({
      action: "decide_proposal",
      id,
      decision: "accept",
      rationale: "Agreed in the prep call",
    });
    expect(decided.status).toBe(200);
    ideaTactic = decided.json.tactic_id as string;
    expect(ideaTactic).toBeTruthy();
  });

  it("dates activities by hand, lays out the rest with no model, and saves the plan final", async () => {
    for (const [tacticId, start, end] of [
      [inventoryTactic, "2026-01-01", "2026-12-31"],
      [ideaTactic, "2026-03-01", "2026-09-30"],
    ] as const) {
      const added = await plan({
        action: "add_activity",
        tactic_id: tacticId,
        start_date: start,
        end_date: end,
        rationale: "Dates agreed with the study team",
      });
      expect(added.status).toBe(200);
    }
    // S10 is ai_optional: it runs with AI off and estimates nothing.
    const laid = await runStage<{ pending: unknown[] }>({
      stage: "S10",
      input: { persist: true },
      actor: ACTOR,
      role: "medical_affairs",
    });
    expect(laid.run_id).toBeTruthy();

    const model = await timelineModel();
    expect(model.pending).toHaveLength(0);
    expect(model.activities.map((row) => row.tactic_id).sort()).toEqual([inventoryTactic, ideaTactic].sort());

    const saved = await plan({ action: "save_plan", status: "final", rationale: "Signed off by hand" });
    expect(saved.status).toBe(200);
    expect((await latestPlan())?.status).toBe("final");
  });

  it("uses manual wording for unmapped rows", async () => {
    const state = await loadState();
    const off = buildMappingTableView(state, null, { ai: false }).find((row) => row.gap_id === openGap);
    expect(off?.rationale).toEqual([UNMAPPED_RATIONALE_MANUAL]);
    const on = buildMappingTableView(state, null).find((row) => row.gap_id === openGap);
    expect(on?.rationale).toEqual([UNMAPPED_RATIONALE_AI]);
  });
});
