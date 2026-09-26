import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { PlanChrome, type PlanNavModel } from "@/components/plan-chrome";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { StepWaiting } from "@/components/step-waiting";
import { TacticsPlace } from "@/components/tactics-place";

const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
const Chrome = PlanChrome as ComponentType<{ active: "upload"; nav: PlanNavModel; children?: ReactNode }>;

const NOTHING_DONE: PlanNavModel = {
  gapsCount: 0,
  unvalidatedCount: 0,
  partialCount: 0,
  gapsUnlocked: false,
  planUnlocked: false,
  tacticsUnlocked: false,
  setupComplete: false,
  readyForPrioritize: false,
};

function chrome(nav: PlanNavModel) {
  return renderToStaticMarkup(createElement(Provider, { enabled: true }, createElement(Chrome, { active: "upload", nav }, "body")));
}

describe("KAN-24: every section opens, and says what it waits on", () => {
  it("links every place in the nav even when nothing is done, marking the waiting ones", () => {
    const html = chrome(NOTHING_DONE);
    for (const place of ["upload", "gaps", "plan", "tactics"]) expect(html).toContain(`href="/?place=${place}"`);
    expect(html).toContain('href="/timeline"');
    expect(html).not.toContain("aria-disabled");
    for (const id of ["gaps", "plan", "tactics"]) expect(html).toContain(`data-testid="nav-waiting-${id}"`);
    expect(html).not.toContain('data-testid="nav-waiting-upload"');
    expect(html).toContain("Waiting on Upload: ingest a source first");
  });

  it("drops the waiting marks once each step is done", () => {
    const html = chrome({ ...NOTHING_DONE, gapsUnlocked: true, planUnlocked: true, tacticsUnlocked: true });
    expect(html).not.toContain("nav-waiting-");
  });

  it("the banner names the prior step and links to it", () => {
    const html = renderToStaticMarkup(
      createElement(StepWaiting, { title: "Waiting on Gaps", body: "Validate first.", href: "/?place=gaps", cta: "Go to Gaps" }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Waiting on Gaps");
    expect(html).toContain('href="/?place=gaps"');
    expect(html).toContain("Go to Gaps");
  });

  it("Tactics renders its content with a waiting banner instead of a lock", () => {
    const waiting = renderToStaticMarkup(createElement(TacticsPlace, { ready: false, openGaps: [], availableTactics: [] }));
    expect(waiting).toContain("Waiting on Prioritize");
    expect(waiting).toContain('aria-labelledby="tactic-library"');
    expect(waiting).not.toMatch(/is locked/i);
    const ready = renderToStaticMarkup(createElement(TacticsPlace, { ready: true, openGaps: [], availableTactics: [] }));
    expect(ready).not.toContain("Waiting on Prioritize");
  });
});
