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
const Chrome = PlanChrome as ComponentType<{ active: "timeline"; nav: PlanNavModel; present?: boolean; children?: ReactNode }>;

const GAPS_DONE: PlanNavModel = {
  gapsCount: 3,
  inventoryAttentionCount: 0,
  unvalidatedCount: 0,
  partialCount: 0,
  gapsUnlocked: true,
  planUnlocked: true,
  tacticsUnlocked: false,
  setupComplete: true,
  readyForPrioritize: true,
};

/** Matches the fallback used by AppShell when navigation data cannot load. */
const EMPTY_NAV: PlanNavModel = {
  gapsCount: 0,
  unvalidatedCount: 0,
  partialCount: 0,
  gapsUnlocked: false,
  planUnlocked: false,
  tacticsUnlocked: false,
  setupComplete: false,
  readyForPrioritize: false,
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
    ).toBe("4 of 4 Open gaps with validated priority · Tactics open");
    expect(readinessText({ ...GAPS_DONE, prioritized: { validated: 1, open: 2 } })).toBe(
      "Prioritizing · 1 of 2 Open gaps with validated priority",
    );
    expect(readinessText({ ...GAPS_DONE, prioritized: { validated: 2, open: 2 } })).toBe(
      "2 of 2 Open gaps with validated priority · Ready for Tactics",
    );
    expect(readinessText({ ...GAPS_DONE, tacticsUnlocked: true, prioritized: { validated: 2, open: 2 } })).toBe(
      "2 of 2 Open gaps with validated priority · Tactics open",
    );
    expect(readinessText({ ...GAPS_DONE, tacticsUnlocked: true })).toBe("Tactics open");
  });

  it("keeps outstanding inventory review visible on an unlocked plan", () => {
    const html = renderToStaticMarkup(createElement(Provider, { enabled: true },
      createElement(Chrome, { active: "timeline", nav: { ...GAPS_DONE, inventoryAttentionCount: 1,
        tacticsUnlocked: true, prioritized: { validated: 2, open: 2 } } }, "body")));
    expect(html).toContain("Inventory review: 1 gaps needing attention");
    expect(html).toContain("2 of 2 Open gaps with validated priority · Tactics open");
    expect(html).toContain('/?place=gaps&amp;gap_filter=needs_attention');
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
    expect(html).toContain("2 of 2 Open gaps with validated priority · Tactics open");
    expect(html).not.toContain("Ready for Prioritize");
  });
});

/** Render only the strip so navigation links cannot satisfy next-action assertions. */
function strip(nav: Partial<PlanNavModel> = {}, enabled = true): string {
  const html = renderToStaticMarkup(createElement(Provider, { enabled },
    createElement(Chrome, { active: "timeline", nav: { ...GAPS_DONE, ...nav } }, "body")));
  return html.match(/<(section|div)[^>]*aria-label="Prep readiness"[\s\S]*?<\/\1>/)?.[0] ?? "";
}

/** Read the prominent action independently from the secondary disclosure. */
function action(html: string): string {
  return html.split("<details")[0];
}

describe("readiness next action and secondary details", () => {
  it("resolves partials before overlapping confirmations without adding the counts", () => {
    const html = strip({ partialCount: 2, unvalidatedCount: 3, inventoryAttentionCount: 4, readyForPrioritize: false });
    expect(action(html)).toContain("Resolve 2 partial gaps");
    expect(action(html)).toContain('/?place=gaps&amp;gap_filter=partial');
    expect(action(html)).not.toContain("5 gaps");
    expect(action(html)).toContain("Split or rewrite partial gaps");
  });

  it("confirms assessments after partials are resolved", () => {
    const html = strip({ unvalidatedCount: 2, inventoryAttentionCount: 3, readyForPrioritize: false });
    expect(action(html)).toContain("Confirm 2 evidence assessments");
    expect(action(html)).toContain('gap_filter=needs_validation');
  });

  it("reviews remaining new-source and mapping attention after confirmation", () => {
    const html = strip({ inventoryAttentionCount: 2 });
    expect(action(html)).toContain("Review 2 gaps needing attention");
    expect(action(html)).toContain('gap_filter=needs_attention');
    expect(action(html)).toContain("new sources and tactic mappings");
  });

  it("keeps reopened review actionable without claiming tactics is locked", () => {
    const html = strip({ tacticsUnlocked: true, partialCount: 1, unvalidatedCount: 1, inventoryAttentionCount: 1 });
    expect(action(html)).toContain("Resolve 1 partial gap");
    expect(action(html)).toContain("Tactics stays available");
    expect(html).toContain("Tactics open");
    expect(action(html)).not.toContain("unlock");
  });

  it("describes unknown review honestly instead of treating it as zero", () => {
    const html = strip({ inventoryAttentionCount: undefined });
    expect(action(html)).toContain("Review Open gap priorities");
    expect(action(html)).toContain("Inventory review data is unavailable");
    expect(action(strip({ inventoryAttentionCount: undefined, tacticsUnlocked: true }))).toContain("/?place=tactics");
    expect(html).toContain("Inventory review: unavailable");
  });

  it("does not invent progress when prioritization data is missing", () => {
    const html = strip();
    expect(action(html)).toContain("Review Open gap priorities");
    expect(action(html)).toContain("Priority progress is unavailable");
    expect(action(html)).toContain('/?place=plan');
    expect(action(html)).not.toContain("0 of");
  });

  it.each([
    { enabled: true, label: "Upload a source or add a gap", href: "/?place=upload" },
    { enabled: false, label: "Add your first gap", href: "/?place=gaps" },
  ])("guides a fresh empty workspace when ingestion is $enabled", ({ enabled, label, href }) => {
    const html = strip({ gapsCount: 0, gapsUnlocked: false, planUnlocked: false,
      readyForPrioritize: false, inventoryAttentionCount: 0 }, enabled);
    expect(action(html)).toContain(label);
    expect(action(html)).toContain(href);
  });

  it.each([true, false])("reports unavailable navigation data when ingestion is %s", (enabled) => {
    const html = renderToStaticMarkup(createElement(Provider, { enabled },
      createElement(Chrome, { active: "timeline", nav: EMPTY_NAV }, "body")));
    const readiness = html.match(/<section[^>]*aria-label="Prep readiness"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(action(readiness)).toContain("Readiness data is unavailable");
    expect(action(readiness)).toContain('/?place=gaps');
    expect(readiness).not.toContain("Add your first gap");
    expect(readiness).not.toContain("Upload a source or add a gap");
    expect(readiness).not.toContain("Gaps 0");
    expect(readiness).not.toContain("Partial 0");
    expect(readiness).not.toContain("Unconfirmed or partial 0");
    expect(readiness).not.toContain("Ready for Prioritize");
    expect(readiness).not.toContain("Not ready for Prioritize");
  });

  it("hides the readiness strip in presentation mode", () => {
    const html = renderToStaticMarkup(createElement(Provider, { enabled: true },
      createElement(Chrome, { active: "timeline", nav: GAPS_DONE, present: true }, "body")));
    expect(html).not.toContain('aria-label="Prep readiness"');
  });

  it("validates remaining Open priorities through the available matrix", () => {
    const html = strip({ prioritized: { validated: 1, open: 3 } });
    expect(action(html)).toContain("Validate 2 Open gap priorities");
    expect(action(html)).toContain('/?place=plan');
  });

  it("honors the legacy matrix gate even when the readiness flag disagrees", () => {
    expect(action(strip({ readyForPrioritize: false, planUnlocked: true,
      prioritized: { validated: 0, open: 3 } }))).toContain('/?place=plan');
    const locked = action(strip({ readyForPrioritize: true, planUnlocked: false,
      prioritized: { validated: 0, open: 3 } }));
    expect(locked).toContain('/?place=gaps');
    expect(locked).not.toContain('/?place=plan');
  });

  it("uses the authoritative tactics gate after priorities are complete", () => {
    const complete = { prioritized: { validated: 3, open: 3 } };
    expect(action(strip({ ...complete, tacticsUnlocked: true }))).toContain('/?place=tactics');
    const locked = action(strip({ ...complete, tacticsUnlocked: false }));
    expect(locked).toContain('/?place=plan');
    expect(locked).not.toContain('/?place=tactics');
  });

  it("uses unlocked tactics when progress is missing without inventing counts", () => {
    const html = action(strip({ tacticsUnlocked: true }));
    expect(html).toContain('/?place=tactics');
    expect(html).not.toContain("0 of");
  });

  it("keeps existing linked counts and the compatible summary in a native disclosure", () => {
    const html = strip({ partialCount: 1, unvalidatedCount: 2, inventoryAttentionCount: 3 });
    const details = html.slice(html.indexOf("<details"));
    expect(details).toContain("<summary");
    expect(details).toContain("Readiness details");
    expect(details).toContain("Gaps 3");
    expect(details).toContain("Partial 1");
    expect(details).toContain("Unconfirmed or partial 2");
    expect(details).toContain("Inventory review: 3 gaps needing attention");
    expect(details).toContain(readinessText({ ...GAPS_DONE, partialCount: 1, unvalidatedCount: 2 }));
    expect(details).not.toMatch(/<details[^>]* open/);
    expect(details).not.toContain('role="button"');
    expect(html).toContain("focus-visible:");
    expect(action(html).match(/<a /g)).toHaveLength(1);
  });
});
