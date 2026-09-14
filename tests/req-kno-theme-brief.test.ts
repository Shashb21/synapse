import { describe, expect, it } from "vitest";
import { summarizeTheme, formatTerminalTime } from "@/lib/briefing/theme-summary";
import { assignThemes } from "@/lib/cluster/cluster";
import { proposeInsights } from "@/lib/extract/proposer";
import { SEED_DOCUMENTS } from "@/lib/seed/corpus";

describe("REQ-KNO-004 theme-first situation briefs", () => {
  it("writes a time-stamped situation from known, unknown, and opportunity leads", () => {
    const { insights, themes } = assignThemes(
      proposeInsights(SEED_DOCUMENTS, "v1.3-cross-functional"),
    );
    const access = themes.find((t) => t.id === "THEME-ACCESS");
    expect(access).toBeTruthy();
    const brief = summarizeTheme(access!, insights, "2026-09-14T10:00:00.000Z");
    expect(brief.as_of_label).toMatch(/Z$/);
    expect(brief.situation.length).toBeGreaterThan(40);
    expect(brief.posture).not.toBe("EMPTY");
  });

  it("formats terminal timestamps", () => {
    expect(formatTerminalTime("2026-09-14T10:00:00.000Z")).toBe("14-SEP-26 10:00Z");
  });
});
