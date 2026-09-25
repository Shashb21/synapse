import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => undefined,
}));

import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { SetupWizard, wizardSteps } from "@/components/setup/setup-wizard";
import {
  AssetStep,
  CompanyStep,
  LandscapeStep,
  ObjectivesStep,
  SettingsStep,
  SetupSummary,
  StakeholdersStep,
  type StepProps,
} from "@/components/setup/setup-steps";
import { RestartWalkthroughButton } from "@/components/walkthrough/restart-walkthrough-button";
import { WalkthroughCard } from "@/components/walkthrough/walkthrough-card";
import { onStepPage, TOUR_STEPS } from "@/components/walkthrough/tour-steps";
import { parsePlanningContext, type PlanningContext } from "@/lib/iegp/planning-context";

const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
const render = (node: ReactNode, ai = true) => renderToStaticMarkup(createElement(Provider, { enabled: ai }, node));

const FILLED = parsePlanningContext({
  asset_name: "Nova",
  inn: "novamab",
  therapeutic_area: "Immunology",
  indications: [
    { name: "Psoriasis", status: "current" },
    { name: "Psoriatic arthritis", status: "planned" },
  ],
  lifecycle_stage: "growth",
  markets: ["US", "Japan"],
  plan_owner: "J. Park",
  sponsoring_function: "Medical Affairs",
  plan_horizon_years: 4,
  objectives: [{ id: "OBJ-1", name: "Win HTA", strategic_importance: 5, key_decision: "NICE submission", decision_date: "2028-01-15" }],
  competitors: [{ name: "JAK class", pressure: "high" }],
  payer_hta_bodies: ["NICE"],
  regulatory_milestones: [{ name: "PMDA filing", date: "2027-09-01" }],
  stakeholders: [{ function: "HEOR", lead: "L. Chen" }],
  treatment_settings: ["1L", "Perioperative"],
  saved_at: "2026-09-20T10:00:00.000Z",
});

function step(view: (props: StepProps) => ReactNode, form: PlanningContext, errors: Record<string, string> = {}) {
  return render(createElement(view as ComponentType<StepProps>, { form, set: () => undefined, errors }));
}

describe("setup wizard steps", () => {
  it("lists every step, with a welcome step for a new workspace and the AI-off label", () => {
    expect(wizardSteps({ ai: true, isNew: true }).map((s) => s.label)).toEqual([
      "Welcome",
      "Asset",
      "Company & plan",
      "Objectives & decisions",
      "Evidence landscape",
      "Stakeholders",
      "Treatment settings",
      "Connect models",
      "Review & finish",
    ]);
    const manual = wizardSteps({ ai: false, isNew: false }).map((s) => s.label);
    expect(manual[0]).toBe("Asset");
    expect(manual).toContain("Work by hand");
    expect(manual).not.toContain("Connect models");
  });

  it("a new workspace opens on the welcome step", () => {
    const html = render(
      createElement(SetupWizard, {
        initial: parsePlanningContext(null),
        actorName: "T",
        actorFunction: "medical_affairs",
        setupComplete: false,
        isNew: true,
        workspaceName: "Nova psoriasis",
      }),
    );
    expect(html).toContain('data-testid="setup-step-welcome"');
    expect(html).toContain("Welcome to your new workspace");
    expect(html).toContain("Nova psoriasis");
    expect(html).toContain("Get started");
  });

  it("a saved draft resumes at its first section with something missing", () => {
    const draft = parsePlanningContext({ ...FILLED, plan_owner: "" });
    const html = render(
      createElement(SetupWizard, { initial: draft, actorName: "T", actorFunction: "medical_affairs", setupComplete: false }),
    );
    expect(html).toContain('data-testid="setup-step-company"');
    expect(html).toContain("Save &amp; continue later");
  });

  it("a completed setup opens on the review with the saved values and a restart-walkthrough button", () => {
    const html = render(
      createElement(SetupWizard, { initial: FILLED, actorName: "T", actorFunction: "medical_affairs", setupComplete: true }),
    );
    expect(html).toContain('data-testid="setup-step-review"');
    expect(html).toContain("This plan is set up");
    for (const text of ["Nova", "Immunology", "Psoriasis (current)", "Growth", "US, Japan", "J. Park", "Win HTA", "NICE submission", "2028-01-15", "JAK class (high)", "PMDA filing (2027-09-01)", "HEOR (L. Chen)", "1L, Perioperative"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('data-testid="restart-walkthrough"');
    expect(html).toContain("Save changes");
  });

  it("renders each section's fields and shows validation messages", () => {
    const empty = parsePlanningContext(null);
    const asset = step(AssetStep, empty, { asset_name: "Name the asset.", markets: "Add at least one market in scope." });
    expect(asset).toContain("Asset / brand name");
    expect(asset).toContain("INN / generic name");
    expect(asset).toContain("Mechanism of action");
    expect(asset).toContain("Therapeutic area");
    expect(asset).toContain("Add indication");
    expect(asset).toContain("Loss of exclusivity (LoE)");
    expect(asset).toContain("Markets in scope");
    expect(asset).toContain("Name the asset.");
    expect(asset).toContain("Add at least one market in scope.");

    const company = step(CompanyStep, FILLED);
    for (const text of ["Company situation", "Plan owner", "Sponsoring function", "Plan horizon (years)", "Planning cycle start", "Planning cycle end"]) {
      expect(company).toContain(text);
    }
    expect(company).toContain('value="J. Park"');

    const objectives = step(ObjectivesStep, FILLED);
    expect(objectives).toContain("Strategic importance (1–5)");
    expect(objectives).toContain('value="NICE submission"');
    expect(objectives).toContain('value="2028-01-15"');
    expect(objectives).toContain('aria-checked="true"');

    const landscape = step(LandscapeStep, FILLED);
    for (const text of ["Overall competitive pressure", "Competitors", "Standard of care", "Comparators", "Key payer / HTA bodies", "Regulatory milestones", "Launch timeline"]) {
      expect(landscape).toContain(text);
    }

    const people = step(StakeholdersStep, FILLED);
    expect(people).toContain('value="L. Chen"');
    expect(people).toContain("+ Medical Affairs");
    expect(people).not.toContain("+ HEOR");

    const settings = step(SettingsStep, FILLED);
    expect(settings).toContain("Perioperative");
    expect(settings).toContain("scope on Prioritize");
    expect(settings).toContain("2L"); // suggestion not yet chosen
  });

  it("the summary flags sections with missing answers", () => {
    const html = render(
      createElement(SetupSummary, {
        form: parsePlanningContext(null),
        onEdit: () => undefined,
        issues: { asset: ["Name the asset."] },
      }),
    );
    expect(html).toContain("Name the asset.");
    expect(html).toContain('data-testid="setup-summary-settings"');
  });
});

describe("walkthrough", () => {
  it("tours the main places in order", () => {
    expect(TOUR_STEPS.map((s) => s.place)).toEqual(["Gaps", "Tactics", "Mapping table", "Prioritize", "Ideation", "Timeline", "Room"]);
    expect(onStepPage(TOUR_STEPS[0]!, "/", new URLSearchParams("place=gaps"))).toBe(true);
    expect(onStepPage(TOUR_STEPS[0]!, "/", new URLSearchParams("place=plan"))).toBe(false);
    expect(onStepPage(TOUR_STEPS[2]!, "/mappings", new URLSearchParams())).toBe(true);
  });

  it("explains the AI path when AI is on and the manual path when it is off", () => {
    const props = { step: 0, onPage: true, highlighted: true, onBack: () => undefined, onNext: () => undefined, onGo: () => undefined, onDismiss: () => undefined };
    const on = render(createElement(WalkthroughCard, { ...props, ai: true }));
    expect(on).toContain("1 of 7");
    expect(on).toContain(TOUR_STEPS[0]!.ai.slice(0, 40));
    expect(on).toContain("Next: Tactics");
    const off = render(createElement(WalkthroughCard, { ...props, ai: false }), false);
    expect(off).toContain("AI is off");
    expect(off).toContain("Add gap");
    const away = render(createElement(WalkthroughCard, { ...props, ai: true, step: 6, onPage: false }));
    expect(away).toContain("Open Room");
    const last = render(createElement(WalkthroughCard, { ...props, ai: true, step: 6 }));
    expect(last).toContain("Finish");
  });

  it("exports a restart button for the nav", () => {
    expect(render(createElement(RestartWalkthroughButton, {}))).toContain("Restart walkthrough");
    expect(render(createElement(RestartWalkthroughButton, { variant: "link", label: "Tour" }))).toContain("Tour");
  });
});
