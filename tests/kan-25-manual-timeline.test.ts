import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/timeline",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => undefined,
}));

import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@/modules";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { TimelineBoard } from "@/components/timeline/timeline-board";
import { dateAtPos } from "@/components/timeline/gap-gantt";
import { monthPos } from "@/components/timeline/gantt-chart";
import { ensurePlatformSchema, wipePlatform } from "@/modules/kernel/db";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { listEdits } from "@/modules/kernel/edit-records";
import { isLiveGap, displayedGapStatus } from "@/lib/iegp/engine";
import { loadState, resetWorkedExample } from "@/lib/iegp/store";
import { GET as planGet, POST as planPost } from "@/app/api/plan/route";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";
import { timelineModel, timelineModule } from "@/modules/stages/s10-timeline/module";
import {
  dependencyConflicts,
  gapTimelineView,
  type GapTimelineView,
} from "@/modules/stages/s10-timeline/gap-view";

/**
 * KAN-25: the owner builds the timeline by hand. Every prioritized gap is a
 * group with its tactics beneath it; activities are created, dated, moved and
 * sequenced with no stage run and no model, and an S10 run keeps every edit.
 */

const ACTOR = { name: "Timeline Owner", function: "medical_affairs" as const };
const TODAY = "2026-09-26";

function post(body: Record<string, unknown>) {
  return planPost(
    new Request("http://localhost/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
}

async function ok(body: Record<string, unknown>) {
  const response = await post(body);
  const json = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(json)).toBe(200);
  return json;
}

async function currentView(): Promise<GapTimelineView> {
  const response = await planGet();
  const json = (await response.json()) as { timeline_view: GapTimelineView };
  return json.timeline_view;
}

function stubContext(ai: boolean): ModuleContext {
  const route: ResolvedRoute = {
    stage: "S10",
    provider_id: "anthropic-claude",
    provider_label: "Claude",
    model: "claude-test",
    auth: "api_key",
    connected: true,
    params: { temperature: 0, max_tokens: 4096 },
    fallbacks: [],
    degraded: false,
    reason: null,
  };
  return {
    ai,
    workspace_id: "default",
    actor: ACTOR,
    role: "medical_affairs",
    route,
    run: { id: "kan-25", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    complete: async () => ({}),
  };
}

describe("KAN-25 gap-grouped view (pure)", () => {
  it("flags a finish-to-start dependency whose successor starts before its predecessor ends", () => {
    const rows = [
      { id: "A", tactic_name: "Study A", start_date: "2026-01-01", end_date: "2026-06-30", depends_on: [] },
      { id: "B", tactic_name: "Study B", start_date: "2026-05-01", end_date: "2026-09-30", depends_on: ["A"] },
      { id: "C", tactic_name: "Paper C", start_date: "2026-07-01", end_date: "2026-08-30", depends_on: ["A"] },
    ];
    expect(dependencyConflicts(rows)).toEqual([
      {
        predecessor_id: "A",
        predecessor_name: "Study A",
        predecessor_end: "2026-06-30",
        successor_id: "B",
        successor_name: "Study B",
        successor_start: "2026-05-01",
      },
    ]);
  });

  it("maps chart positions back to dates for drag and resize", () => {
    for (const iso of ["2026-01-01", "2026-02-15", "2026-12-31", "2027-03-10"]) {
      expect(dateAtPos("2026-01-01", monthPos("2026-01-01", iso))).toBe(iso);
    }
    expect(dateAtPos("2026-01-01", 0)).toBe("2026-01-01");
  });
});

describe("KAN-25 manual timeline, no stage run, AI off", () => {
  let high: string;
  let low: string;
  let createdUndated: string;
  let createdDated: string;
  let savedStub: string | undefined;

  beforeAll(async () => {
    await resetWorkedExample();
    await wipePlatform();
    await ensurePlatformSchema();
    const state = await loadState();
    const open = state.gaps.filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open");
    expect(open.length).toBeGreaterThan(2);
    // Validate two bands by hand; every other open gap stays not prioritized.
    [low, high] = [open[0]!.id, open[1]!.id];
    await validatePlacement({ gap_id: low, band: "low", rationale: "Nice to have", actor: ACTOR });
    await validatePlacement({ gap_id: high, band: "high", rationale: "Launch critical", actor: ACTOR });
  }, 60_000);

  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  it("shows every prioritized gap by band then name, with its tactics as unscheduled rows", async () => {
    const view = await currentView();
    expect(view.prioritized.map((group) => group.gap_id)).toEqual([high, low]);
    expect(view.prioritized.map((group) => group.band)).toEqual(["high", "low"]);
    // Nothing has been dated: every tactic under a gap is unscheduled, and so is the gap.
    for (const group of view.prioritized) {
      expect(group.start).toBeNull();
      for (const item of group.items) {
        expect(item.activity).toBeNull();
        expect(item.pending).not.toBeNull();
      }
    }
    const state = await loadState();
    const openIds = state.gaps
      .filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open")
      .map((gap) => gap.id);
    const shown = [...view.prioritized, ...view.not_prioritized].map((group) => group.gap_id);
    // Nothing silently disappears.
    expect(shown).toEqual(expect.arrayContaining(openIds));
    expect(view.not_prioritized.map((group) => group.gap_id)).not.toContain(high);
    const names = view.not_prioritized.map((group) => group.gap_name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("creates activities under a gap from the timeline, dated or unscheduled, marked human and audited", async () => {
    const undated = await ok({
      action: "create_activity",
      gap_id: high,
      name: "KAN-25 treatment patterns study",
      type: "rwe_study",
      evidence_question: "How are patients treated today?",
      start_date: "",
      end_date: "",
      rationale: "Added in the planning session",
    });
    createdUndated = String(undated.activity_id);
    expect(undated.scheduled).toBe(false);

    const dated = await ok({
      action: "create_activity",
      gap_id: high,
      name: "KAN-25 burden of illness survey",
      type: "patient_survey",
      evidence_question: "What does the disease cost patients?",
      start_date: "2026-10-01",
      end_date: "2027-03-31",
      readout_date: "2027-05-01",
      rationale: "Added in the planning session",
    });
    createdDated = String(dated.activity_id);
    expect(dated.scheduled).toBe(true);

    const refused = await post({
      action: "create_activity",
      gap_id: high,
      name: "Half dated",
      type: "rwe_study",
      evidence_question: "q",
      start_date: "2026-10-01",
      rationale: "Only a start",
    });
    expect(refused.status).toBe(400);

    const view = await currentView();
    const group = view.prioritized.find((row) => row.gap_id === high)!;
    const undatedItem = group.items.find((item) => item.activity_id === createdUndated)!;
    expect(undatedItem.activity).toBeNull();
    expect(undatedItem.tactic_status).toBe("proposed");
    const datedItem = group.items.find((item) => item.activity_id === createdDated)!;
    expect(datedItem.activity?.start_date).toBe("2026-10-01");
    expect(datedItem.activity?.meta.schedule_basis).toEqual({ start: "human", end: "human", readout: "human" });
    expect(group.start).toBe("2026-10-01");
    expect(group.end).toBe("2027-03-31");

    const edits = await listEdits({ stage: "S10" });
    expect(edits.filter((edit) => edit.field === "created")).toHaveLength(2);
    expect(edits.map((edit) => edit.actor.name)).toEqual(edits.map(() => ACTOR.name));
  });

  it("sets dates, reschedules, adds and removes a dependency, and warns without shifting", async () => {
    await ok({
      action: "add_activity",
      tactic_id: createdUndated.replace(/^ACT-/, ""),
      start_date: "2027-01-01",
      end_date: "2027-06-30",
      rationale: "Set dates from the timeline",
    });
    // The successor waits on the survey, which ends 2027-03-31: this breaks it.
    await ok({ action: "set_dependencies", id: createdUndated, depends_on: [createdDated], rationale: "Needs the survey" });
    let view = await currentView();
    expect(view.conflicts).toEqual([
      expect.objectContaining({ predecessor_id: createdDated, successor_id: createdUndated, successor_start: "2027-01-01" }),
    ]);
    // Not auto-shifted: the date the person set stands.
    let model = await timelineModel();
    expect(model.activities.find((row) => row.id === createdUndated)!.start_date).toBe("2027-01-01");

    // Dragging the successor after the predecessor's end clears the warning.
    await ok({
      action: "move_activity",
      id: createdUndated,
      start_date: "2027-04-01",
      end_date: "2027-09-30",
      rationale: "Moved on the timeline",
    });
    view = await currentView();
    expect(view.conflicts).toEqual([]);

    // Remove, then add back, the dependency.
    await ok({ action: "set_dependencies", id: createdUndated, depends_on: [], rationale: "Can run in parallel" });
    model = await timelineModel();
    expect(model.activities.find((row) => row.id === createdUndated)!.depends_on).toEqual([]);
    await ok({ action: "set_dependencies", id: createdUndated, depends_on: [createdDated], rationale: "Needs the survey after all" });

    await ok({ action: "remove_activity", id: createdDated, rationale: "Descoped" });
    model = await timelineModel();
    expect(model.removed.map((row) => row.activity_id)).toContain(createdDated);
    await ok({ action: "add_activity", tactic_id: createdDated.replace(/^ACT-/, ""), rationale: "Back in scope" });
  });

  it("keeps every human edit through an S10 run, with AI on or off", async () => {
    const before = await timelineModel();
    const mine = (model: typeof before) =>
      model.activities
        .filter((row) => row.id === createdDated || row.id === createdUndated)
        .map((row) => ({
          id: row.id,
          name: row.tactic_name,
          start: row.start_date,
          end: row.end_date,
          readout: row.readout_date,
          depends_on: row.depends_on,
          basis: row.meta.schedule_basis,
          depends_locked: row.meta.depends_locked,
        }));
    expect(mine(before)).toHaveLength(2);

    // AI off: nothing is estimated, and nothing a person set changes.
    delete process.env.SYNAPSE_TEST_STUB_LLM;
    await timelineModule.run(timelineModule.inputSchema.parse({ persist: true, anchor: "2026-01-01" }), stubContext(false));
    expect(mine(await timelineModel())).toEqual(mine(before));

    // AI on (the test stub stands in for the model and dates the rest).
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    const { output } = await timelineModule.run(
      timelineModule.inputSchema.parse({ persist: true, anchor: "2026-01-01" }),
      stubContext(true),
    );
    expect(output.pending).toHaveLength(0);
    const after = await timelineModel();
    expect(mine(after)).toEqual(mine(before));
    expect(after.activities.find((row) => row.id === createdUndated)!.depends_on).toEqual([createdDated]);
    // The stage dated what nobody had, and those rows say the model did it.
    const estimated = after.activities.filter((row) => row.meta.schedule_basis.end === "model");
    expect(estimated.length).toBeGreaterThan(0);
  });

  it("shows key decisions from the setup context as markers", async () => {
    const state = await loadState();
    const decisions = state.objectives.filter((objective) => objective.key_decision && /^\d{4}-\d{2}-\d{2}$/.test(objective.decision_date));
    expect(decisions.length).toBeGreaterThan(0);
    const view = gapTimelineView({ model: await timelineModel(), state, placements: await listPlacements(), today: TODAY });
    expect(view.markers.filter((marker) => marker.kind === "key_decision")).toHaveLength(decisions.length);
    for (const marker of view.markers) expect(marker.date >= view.window.start && marker.date <= view.window.end).toBe(true);
  });

  it("renders edit controls for an editor and none for a viewer", async () => {
    const model = await timelineModel();
    const state = await loadState();
    const view = gapTimelineView({ model, state, placements: await listPlacements(), today: TODAY });
    // One more unscheduled tactic so the "Set dates" action has a row to sit on.
    expect(view.prioritized.length).toBeGreaterThan(0);
    const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
    const render = (editor: boolean) =>
      renderToStaticMarkup(
        createElement(
          Provider,
          { enabled: false },
          createElement(TimelineBoard, {
            model,
            view,
            today: TODAY,
            identity: { signed_in: true, actor_name: ACTOR.name, actor_function: ACTOR.function },
            plan: null,
            history: [],
            canSaveFinal: editor,
            canReschedule: editor,
            canRun: editor,
            canCreate: editor,
            canEditDetails: editor,
            gapDomains: {},
            addable: [],
          }),
        ),
      );
    const editor = render(true);
    expect(editor).toContain("HIGH PRIORITY");
    expect(editor).toContain("NOT PRIORITIZED");
    expect(editor).toContain("Add activity");
    expect(editor).toContain("Drag a bar to move it");
    const viewer = render(false);
    expect(viewer).toContain("HIGH PRIORITY");
    for (const control of ["Add activity", "Set dates", "Save as final", "Lay out dates", "Drag a bar", "Remove"]) {
      expect(viewer, control).not.toContain(control);
    }
    expect(viewer).toContain("Read-only");
  });
});
