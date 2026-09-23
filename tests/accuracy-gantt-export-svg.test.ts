import { describe, expect, it } from "vitest";
import {
  activitiesToSvg,
  ganttExportFileName,
  svgMarkupForRaster,
  svgViewport,
} from "@/accuracy/modules/gantt-project/export-svg";
import { activityIdForTactic } from "@/accuracy/modules/gantt-project/engine";

describe("gantt SVG export", () => {
  it("renders an empty placeholder when there are no activities", () => {
    const svg = activitiesToSvg([]);
    expect(svg).toContain("<svg");
    expect(svg).toContain("No activities");
  });

  it("renders bars for each activity with tactic labels", () => {
    const svg = activitiesToSvg([
      {
        id: activityIdForTactic("T1"),
        tactic_id: "T1",
        start: "2026-01-01",
        end: "2026-06-01",
        readout: null,
        depends_on: [],
        gap_ids: [],
      },
      {
        id: activityIdForTactic("T2"),
        tactic_id: "T2",
        start: "2026-04-01",
        end: "2026-12-01",
        readout: "2027-01-15",
        depends_on: ["T1"],
        gap_ids: ["G1"],
      },
    ]);
    expect(svg).toContain("T1");
    expect(svg).toContain("T2");
    expect(svg).toContain("<rect");
    expect(svg).toContain("2026-01-01");
    expect(svg).toContain("2026-12-01");
    expect(svg).toContain("readout 2027-01-15");
  });

  it("names PNG exports from workspace and plan version", () => {
    expect(ganttExportFileName({ workspace_id: "ws-1", version: 3, ext: "png" })).toBe(
      "synapse-gantt-ws-1-v3.png",
    );
    expect(ganttExportFileName({ workspace_id: "ws-1", ext: "png" })).toBe(
      "synapse-gantt-ws-1-draft.png",
    );
  });

  it("strips the XML declaration and reads viewport for PNG rasterization", () => {
    const svg = activitiesToSvg([
      {
        id: activityIdForTactic("T1"),
        tactic_id: "T1",
        start: "2026-01-01",
        end: "2026-06-01",
        readout: null,
        depends_on: [],
        gap_ids: [],
      },
    ]);
    const raster = svgMarkupForRaster(svg);
    expect(raster.startsWith("<svg")).toBe(true);
    expect(raster).not.toMatch(/<\?xml/);
    expect(svgViewport(svg)).toEqual({ width: 960, height: 84 });
  });
});
