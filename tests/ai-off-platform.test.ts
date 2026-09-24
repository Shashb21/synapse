import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => undefined,
}));

import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@/modules";
import { AI_OFF_MESSAGE, setAiEnabled } from "@/modules/kernel/ai-switch";
import { POST as stagePost } from "@/app/api/modules/route";
import { POST as evalsPost } from "@/app/api/modules/evals/route";
import { POST as hillclimbPost } from "@/app/api/modules/hillclimb/route";
import { HILLCLIMB_STAGES } from "@/modules/kernel/prompt-versions";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { RunStageButton, stageNeedsAi } from "@/components/platform/run-stage-button";
import { ChainRunner, ModularUploadForm } from "@/components/platform/pipeline-runner";
import { RunEvalsButton } from "@/components/platform/run-evals-button";
import { HillclimbSweepButton } from "@/components/platform/hillclimb-sweep-button";
import { RoutingPanel } from "@/components/platform/routing-panel";
import { ProviderPanel } from "@/components/platform/provider-panel";
import { AiSwitchPanel } from "@/components/platform/ai-switch-panel";
import { SetupWizard } from "@/components/setup/setup-wizard";
import PipelinePage from "@/app/pipeline/page";
import RunsPage from "@/app/runs/page";
import { parsePlanningContext } from "@/lib/iegp/planning-context";

const ACTOR = "AI Off Platform Test";
const IDENTITY = { signed_in: false, actor_name: ACTOR, actor_function: "medical_affairs" as const };

function post(handler: (request: Request) => Promise<Response>, url: string, body: Record<string, unknown>) {
  return handler(
    new Request(`http://localhost${url}`, {
      method: "POST",
      body: JSON.stringify({ actor_name: ACTOR, actor_function: "medical_affairs", ...body }),
    }),
  );
}

function render(node: ReactNode, ai: boolean): string {
  return renderToStaticMarkup(createElement(AiStatusProvider, { enabled: ai }, node));
}

/** Server pages wrap everything in the async AppShell; render what they put inside it. */
function shellChildren(page: ReactElement): ReactNode {
  return createElement(Fragment, null, (page.props as { children: ReactNode }).children);
}

describe("AI off: platform, pipeline, runs, control and setup", () => {
  beforeAll(async () => {
    await setAiEnabled({ enabled: false, actor_name: ACTOR, rationale: "AI off for platform tests" });
  });
  afterAll(async () => {
    // Leave AI on for every other test file.
    await setAiEnabled({ enabled: true, actor_name: ACTOR, rationale: "restore after platform tests" });
  });

  it("stage runs of AI stages answer 409 ai_off instead of a generic 400", async () => {
    for (const stage of ["S0", "S1", "S2", "S3", "S4", "S8", "S9"]) {
      const res = await post(stagePost, "/api/modules", { stage, input: {} });
      expect(res.status, stage).toBe(409);
      expect(await res.json()).toEqual({ code: "ai_off", error: AI_OFF_MESSAGE });
    }
    // Unknown stages are still a plain 400.
    expect((await post(stagePost, "/api/modules", { stage: "S99" })).status).toBe(400);
  });

  it("evals of AI stages and every hillclimb sweep answer 409 ai_off", async () => {
    const evals = await post(evalsPost, "/api/modules/evals", { stage: "S2" });
    expect(evals.status).toBe(409);
    expect(await evals.json()).toMatchObject({ code: "ai_off", error: AI_OFF_MESSAGE });

    const stage = HILLCLIMB_STAGES[0]!;
    const sweep = await post(hillclimbPost, "/api/modules/hillclimb", { stage });
    expect(sweep.status).toBe(409);
    expect(await sweep.json()).toMatchObject({ code: "ai_off", error: AI_OFF_MESSAGE });
  });

  it("RunStageButton hides AI-only stages but keeps S5, S7 and S10", () => {
    for (const stage of ["S0", "S1", "S2", "S3", "S4", "S6", "S8", "S9"]) expect(stageNeedsAi(stage), stage).toBe(true);
    for (const stage of ["S5", "S7", "S10"]) expect(stageNeedsAi(stage), stage).toBe(false);

    const hidden = render(
      createElement(RunStageButton, { stage: "S9", identity: IDENTITY, aiOffFallback: "AI is off — add ideas by hand" }),
      false,
    );
    expect(hidden).toBe("AI is off — add ideas by hand");
    expect(render(createElement(RunStageButton, { stage: "S10", identity: IDENTITY }), false)).toContain("Run S10");
    expect(render(createElement(RunStageButton, { stage: "S7", identity: IDENTITY }), false)).toContain("Run S7");
    expect(render(createElement(RunStageButton, { stage: "S9", identity: IDENTITY }), true)).toContain("Run S9");
  });

  it("chains, upload, evals and hillclimb controls render nothing with AI off", () => {
    const chain = createElement(ChainRunner, { label: "Run chain", identity: IDENTITY, steps: [{ stage: "S2", label: "S2" }] });
    const upload = createElement(ModularUploadForm, { demoOptions: [], identity: IDENTITY });
    const evals = createElement(RunEvalsButton, { stage: "S2", identity: IDENTITY });
    const sweep = createElement(HillclimbSweepButton, { stage: "S2" });
    for (const node of [chain, upload, evals, sweep]) expect(render(node, false)).toBe("");
    expect(render(chain, true)).toContain("Run chain");
    expect(render(upload, true)).toContain("Upload and parse");
    expect(render(evals, true)).toContain("Run evals");
    expect(render(sweep, true)).toContain("Hillclimb S2");
  });

  it("the pipeline page shows the manual path and no AI run, upload or eval button", async () => {
    const html = render(shellChildren(await PipelinePage()), false);
    expect(html).toContain('data-testid="pipeline-ai-off"');
    expect(html).toContain("AI is off — done by hand");
    expect(html).toContain('href="/?place=gaps"');
    expect(html).toContain('href="/tactics"');
    expect(html).toContain('href="/mappings"');
    expect(html).toContain('href="/?place=plan"');
    expect(html).toContain('href="/ideation"');
    expect(html).toContain('href="/timeline"');
    expect(html).not.toContain("Upload and parse");
    expect(html).not.toContain("Upload only");
    expect(html).not.toContain("Run evals");
    for (const stage of ["S1", "S2", "S3", "S4", "S8", "S9"]) {
      expect(html, stage).not.toContain(`Run ${stage}<`);
      expect(html, stage).toContain(`data-testid="ai-off-${stage}"`);
    }
    expect(html).toContain("Run S7");
    expect(html).toContain("Run S10");
  });

  it("the runs page swaps the hillclimb sweep for an AI-off note", async () => {
    const html = render(shellChildren(await RunsPage()), false);
    expect(html).toContain('data-testid="hillclimb-ai-off"');
    expect(html).not.toContain("Hillclimb S");
  });

  it("control panel labels providers and routes as unused, and the switch copy says no upload", () => {
    const routing = render(createElement(RoutingPanel, { routes: [], providers: [], canRoute: true, canActivate: true }), false);
    expect(routing).toContain('data-testid="routing-ai-off"');
    expect(render(createElement(RoutingPanel, { routes: [], providers: [], canRoute: true, canActivate: true }), true)).not.toContain(
      "routing-ai-off",
    );
    const providers = render(
      createElement(ProviderPanel, {
        connections: [],
        defaults: { primary: "xai", alternate: "anthropic" },
        canConnect: true,
        canRoute: true,
      }),
      false,
    );
    expect(providers).toContain('data-testid="providers-ai-off"');
    const panel = render(
      createElement(AiSwitchPanel, {
        ai: { enabled: false, updated_by: ACTOR, updated_at: "now", rationale: "test" },
        mayToggle: false,
        identity: IDENTITY,
      }),
      false,
    );
    expect(panel).toContain("no upload or parsing");
    expect(panel).toContain("Add gaps and Add tactics");
  });

  it("the setup wizard points to Add gaps and Add tactics instead of upload and connecting models", () => {
    const props = {
      initial: parsePlanningContext(null),
      actorName: ACTOR,
      actorFunction: "medical_affairs",
      setupComplete: true,
    };
    const off = render(createElement(SetupWizard, props), false);
    expect(off).toContain("Work by hand");
    expect(off).not.toContain("Connect models");
    expect(off).toContain('href="/?place=gaps"');
    expect(off).toContain('href="/tactics"');
    expect(off).not.toContain("Open pipeline");
    expect(off).not.toContain("upload sources");
    const on = render(createElement(SetupWizard, props), true);
    expect(on).toContain("Connect models");
    expect(on).toContain("Open pipeline");
  });
});
