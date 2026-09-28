import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/timeline",
  useSearchParams: () => new URLSearchParams(),
}));

import { PlanChrome, readinessText, type PlanNavModel } from "@/components/plan-chrome";
import { AiStatusProvider } from "@/components/platform/ai-status";

const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
const Chrome = PlanChrome as ComponentType<{ active: "timeline"; nav: PlanNavModel; children?: ReactNode }>;

const GAPS_DONE: PlanNavModel = {
  gapsCount: 3,
  unvalidatedCount: 0,
  partialCount: 0,
  gapsUnlocked: true,
  planUnlocked: true,
  tacticsUnlocked: false,
  setupComplete: true,
  readyForPrioritize: true,
};

describe("the Prep readiness strip says the real next step", () => {
  it("before Prioritize, it answers whether Gaps is done", () => {
    expect(readinessText({ ...GAPS_DONE, readyForPrioritize: false, unvalidatedCount: 2 })).toBe(
      "Not ready for Prioritize",
    );
    expect(readinessText({ ...GAPS_DONE, prioritized: { validated: 0, open: 2 } })).toBe("Ready for Prioritize");
    expect(readinessText(GAPS_DONE)).toBe("Ready for Prioritize");
  });

  it("during and after Prioritize, it shows progress instead of a stage already passed", () => {
    // Once Tactics is open, a gap reopened on Gaps shows in the counts, not as "Not ready".
    expect(
      readinessText({ ...GAPS_DONE, readyForPrioritize: false, partialCount: 2, tacticsUnlocked: true, prioritized: { validated: 4, open: 4 } }),
    ).toBe("4 of 4 validated · Tactics open");
    expect(readinessText({ ...GAPS_DONE, prioritized: { validated: 1, open: 2 } })).toBe(
      "Prioritizing · 1 of 2 validated",
    );
    expect(readinessText({ ...GAPS_DONE, prioritized: { validated: 2, open: 2 } })).toBe(
      "2 of 2 validated · Ready for Tactics",
    );
    expect(readinessText({ ...GAPS_DONE, tacticsUnlocked: true, prioritized: { validated: 2, open: 2 } })).toBe(
      "2 of 2 validated · Tactics open",
    );
    expect(readinessText({ ...GAPS_DONE, tacticsUnlocked: true })).toBe("Tactics open");
  });

  it("renders the verdict in the strip on Timeline once tactics are unlocked", () => {
    const html = renderToStaticMarkup(
      createElement(
        Provider,
        { enabled: true },
        createElement(
          Chrome,
          { active: "timeline", nav: { ...GAPS_DONE, tacticsUnlocked: true, prioritized: { validated: 2, open: 2 } } },
          "body",
        ),
      ),
    );
    expect(html).toContain('aria-label="Prep readiness"');
    expect(html).toContain("2 of 2 validated · Tactics open");
    expect(html).not.toContain("Ready for Prioritize");
  });
});
