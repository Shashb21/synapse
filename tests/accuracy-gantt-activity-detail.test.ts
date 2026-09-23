import { describe, expect, it } from "vitest";
import { activityIdForTactic } from "@/accuracy/modules/gantt-project/engine";
import {
  ganttBarAriaLabel,
  resolveActivityDetail,
} from "@/accuracy/modules/gantt-project/activity-detail";
import type { GanttActivity } from "@/accuracy/modules/gantt-project/engine";

const study: GanttActivity = {
  id: activityIdForTactic("T-study"),
  tactic_id: "T-study",
  start: "2026-01-01",
  end: "2026-06-01",
  readout: "2026-07-01",
  depends_on: [],
  gap_ids: ["G-os"],
};

const pubs: GanttActivity = {
  id: activityIdForTactic("T-pubs"),
  tactic_id: "T-pubs",
  start: "2026-07-01",
  end: "2026-12-01",
  readout: null,
  depends_on: [study.id],
  gap_ids: ["G-os"],
};

const catalog = [
  { id: "T-study", claim_type: "tactic" as const, statement: "Pivotal OS follow-up" },
  { id: "T-pubs", claim_type: "tactic" as const, statement: "Congress abstract" },
  { id: "G-os", claim_type: "gap" as const, statement: "Need OS in 2L NSCLC" },
];

describe("gantt activity detail", () => {
  it("builds an accessible label with tactic, gaps, timing, and deps", () => {
    const label = ganttBarAriaLabel(pubs, catalog);
    expect(label).toContain("Congress abstract");
    expect(label).toContain("2026-07-01 to 2026-12-01");
    expect(label).toContain("Need OS in 2L NSCLC");
    expect(label).toContain(`depends on ${study.id}`);
  });

  it("resolves gap, tactic, and interdependency records for click-into", () => {
    const detail = resolveActivityDetail({
      activity: pubs,
      activities: [study, pubs],
      catalog,
    });
    expect(detail.tactic?.statement).toBe("Congress abstract");
    expect(detail.gaps).toEqual([{ id: "G-os", statement: "Need OS in 2L NSCLC" }]);
    expect(detail.depends_on[0]?.statement).toBe("Pivotal OS follow-up");
    expect(detail.dependents).toEqual([]);

    const upstream = resolveActivityDetail({
      activity: study,
      activities: [study, pubs],
      catalog,
    });
    expect(upstream.dependents[0]?.tactic_id).toBe("T-pubs");
  });
});
