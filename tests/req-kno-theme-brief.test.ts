import { describe, expect, it } from "vitest";
import { summarizeTheme, formatTerminalTime } from "@/lib/briefing/theme-summary";
import { assignThemes } from "@/lib/cluster/cluster";
import { proposeInsights } from "@/lib/extract/proposer";
import { SEED_DOCUMENTS, THEME_CATALOG } from "@/lib/seed/corpus";
import { THEME_STYLES, themeStyle } from "@/lib/theme-style";

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

  it("REQ-CLU-005 residual briefs stay out of named themes", () => {
    const { insights, themes } = assignThemes(
      proposeInsights(SEED_DOCUMENTS, "v1.3-cross-functional"),
    );
    const residual = themes.find((t) => t.id === "THEME-RESIDUAL");
    expect(residual).toBeTruthy();
    const brief = summarizeTheme(residual!, insights, "2026-09-14T10:00:00.000Z");
    expect(brief.situation).toMatch(/catalog floor/i);
  });

  it("formats terminal timestamps", () => {
    expect(formatTerminalTime("2026-09-14T10:00:00.000Z")).toBe("14-SEP-26 10:00Z");
  });

  it("gives every catalog theme a distinct color", () => {
    const hues = THEME_CATALOG.map((theme) => themeStyle(theme.id).hue);
    expect(new Set(hues).size).toBe(THEME_CATALOG.length);
    expect(THEME_STYLES["THEME-ACCESS"]!.hue).not.toBe(
      THEME_STYLES["THEME-EVIDENCE"]!.hue,
    );
  });
});
