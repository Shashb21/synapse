import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSeed } from "@/lib/iegp/seed";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import type { SourceDocument } from "@/lib/iegp/types";

const fixtures = vi.hoisted(() => ({
  ingestions: [] as { checkpoint: unknown }[],
  axisChosen: false,
  provenance: vi.fn<(stage: string, ids: string[]) => Promise<boolean>>(),
}));
vi.mock("@/modules/kernel/db", async importOriginal => ({
  ...await importOriginal<typeof import("@/modules/kernel/db")>(),
  ensurePlatformSchema: async () => undefined,
  db: () => ({ select: () => ({ from: async () => fixtures.ingestions }) }),
}));
vi.mock("@/lib/demo/mode", () => ({ isDemoModeWorkspace: async () => true }));
vi.mock("@/lib/ingest/compare-source", () => ({ listSourceComparisons: async () => [] }));
vi.mock("@/components/source-comparison-status", () => ({ SourceComparisonStatus: () => null }));
vi.mock("@/components/add-source-form", () => ({ AddSourceForm: () => null }));
vi.mock("@/components/lock-form", () => ({ LockForm: ({ label }: { label: string }) => label }));
vi.mock("@/components/plan-cards", () => ({ GapPlanCard: () => null }));
vi.mock("@/components/prioritize/prioritize-matrix", () => ({
  AxisChooser: () => "Choose axes", PrioritizeMatrix: () => "Priority matrix",
}));
vi.mock("@/modules/auth/session", () => ({ sessionContext: async () => ({ signed_in: true, role: "medical_affairs", actor: { name: "Presenter", function: "medical_affairs" } }) }));
vi.mock("@/modules/kernel/observability", () => ({ hasCompletedDemoReplay: fixtures.provenance }));
vi.mock("@/modules/stages/s8-prioritization/axes", () => ({
  ALL_SETTINGS_SCOPE: "all",
  loadAxes: async () => ({ axes: [{ id: "x" }, { id: "y" }] }),
  loadScopeAxes: async () => fixtures.axisChosen ? { x_axis: "x", y_axis: "y" } : null,
}));
vi.mock("@/modules/stages/s8-prioritization/module", () => ({
  listPlacements: async () => fixtures.axisChosen ? [{ gap_id: "GAP-001", run_id: "recorded-run", suggested_band: "high", suggested_rationale: "Fictional evidence" }] : [],
}));

import { IngestPanel } from "@/components/ingest-panel";
import { PrioritizePlace } from "@/components/prioritize/prioritize-place";

beforeEach(() => {
  fixtures.ingestions = [];
  fixtures.axisChosen = false;
  fixtures.provenance.mockReset();
  fixtures.provenance.mockResolvedValue(false);
});

describe("KAN-263 completed replay labels", () => {
  it("labels a completed pack file as including recorded Velmara steps", async () => {
    const file = CLIENT_DEMO_PACK[0]!;
    const source: SourceDocument = {
      id: "SRC-001", title: file.title, filename: file.filename, full_text: file.text,
      source_type: file.source_type, stakeholder_function: file.stakeholder_function, ingested_at: "2026-10-19T08:00:00Z",
    };
    const checkpoint = { stages: ["S0", "S1", "S2"], completed: 2, result: { source_ids: [source.id] }, execution_source: "demo_replay" };
    fixtures.ingestions = [{ checkpoint }];
    const incomplete = renderToStaticMarkup(await IngestPanel({ compact: true, demoFiles: true, sources: [source] }));
    expect(incomplete).toContain("Ingest this file");
    expect(incomplete).not.toContain("Includes recorded Velmara steps");

    fixtures.ingestions = [{ checkpoint: { ...checkpoint, completed: 3 } }];
    const complete = renderToStaticMarkup(await IngestPanel({ compact: true, demoFiles: true, sources: [source] }));
    expect(complete).toContain("Ingested · Includes recorded Velmara steps");

    fixtures.ingestions = [{ checkpoint: { ...checkpoint, completed: 3, execution_source: undefined } }];
    const live = renderToStaticMarkup(await IngestPanel({ compact: true, demoFiles: true, sources: [source] }));
    expect(live).toContain(">Ingested</span>");
    expect(live).not.toContain("Includes recorded Velmara steps");
  });

  it("labels saved replay suggestions after the axis chooser is replaced by the matrix", async () => {
    const state = buildSeed();
    state.gaps = [{ ...state.gaps[0]!, id: "GAP-001", status: "validated_open", computed_status: "validated_open",
      status_override: null, retired: false, parked_at: null, human_validated: true }];
    const args = { state, setting: undefined, addressed: [], availableTactics: [] };
    const chooser = renderToStaticMarkup(await PrioritizePlace(args));
    expect(chooser).toContain("Choose axes");
    expect(chooser).not.toContain("Recorded Velmara demo suggestions");

    fixtures.axisChosen = true;
    fixtures.provenance.mockResolvedValue(true);
    const matrix = renderToStaticMarkup(await PrioritizePlace(args));
    expect(fixtures.provenance).toHaveBeenLastCalledWith("S8", ["recorded-run"]);
    expect(matrix).toContain("Priority matrix");
    expect(matrix).toContain("Recorded Velmara demo suggestions");
  });
});
