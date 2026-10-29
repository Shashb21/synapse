/** @vitest-environment jsdom */
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

  it("exports the selected catalog labels and falls back to IDs without live lookups", () => {
    const activity = { id: "ACT-T1", tactic_id: "T1", start: "2026-01-01", end: "2026-06-01", readout: null, depends_on: [], gap_ids: [] };
    expect(activitiesToSvg([activity], [{ id: "T1", claim_type: "tactic", statement: "Frozen study" }])).toContain("Frozen study");
    expect(activitiesToSvg([activity], [])).toContain(">T1</text>");
    expect(activitiesToSvg([activity], [{ id: "T1", claim_type: "tactic", statement: 'Frozen & <reviewed> "study"' }])).toContain("Frozen &amp; &lt;reviewed&gt; &quot;study&quot;");
  });

  it("keeps complete wrapped statements above their own bars and below the preceding row", () => {
    const activity = { id: "ACT-T1", tactic_id: "T1", start: "2026-01-01", end: "2026-06-01", readout: null, depends_on: [], gap_ids: [] };
    const statements = [
      "A multicenter phase III randomized overall survival follow-up study for patients with advanced disease and extended longitudinal assessment of outcomes and safety",
      "X".repeat(200),
    ];
    const svg = activitiesToSvg(
      [activity, { ...activity, id: "ACT-T2", tactic_id: "T2" }],
      statements.map((statement, index) => ({ id: `T${index + 1}`, claim_type: "tactic", statement })),
    );
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const bars = [...document.querySelectorAll('rect[fill="#333"]')];
    const labels = [...document.querySelectorAll('text[font-size="11"]')];
    let previousBarBottom = 18;
    bars.forEach((bar, index) => {
      const barTop = Number(bar.getAttribute("y"));
      const lines = labels.filter(label => {
        const baseline = Number(label.getAttribute("y"));
        return baseline > previousBarBottom && baseline < barTop;
      });
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.map(line => line.textContent).join(index === 0 ? " " : "")).toBe(statements[index]);
      for (const line of lines) {
        // Reserve ascent/descent space around every label, not only its baseline.
        const baseline = Number(line.getAttribute("y"));
        const fontSize = Number(line.getAttribute("font-size"));
        expect(baseline - fontSize).toBeGreaterThan(previousBarBottom);
        expect(baseline + fontSize).toBeLessThan(barTop);
        expect([...line.textContent!].length * fontSize + Number(line.getAttribute("x"))).toBeLessThan(960);
      }
      previousBarBottom = barTop + Number(bar.getAttribute("height"));
    });
    expect(svgViewport(svg).height).toBeGreaterThan(previousBarBottom);
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
