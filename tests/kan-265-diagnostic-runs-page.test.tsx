import { afterEach, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RunsPage from "@/app/admin/runs/page";
import { AiStatusProvider } from "@/components/platform/ai-status";
import * as routing from "@/modules/kernel/approved-evaluation-route";
import * as owner from "@/modules/auth/owner";
import * as admin from "@/modules/workspaces/admin-context";
import * as workspaces from "@/modules/workspaces/store";
import * as llm from "@/modules/kernel/llm";
import * as registry from "@/modules/kernel/registry";
import * as switches from "@/modules/kernel/ai-switch";
import * as history from "@/modules/kernel/observability";
import * as edits from "@/modules/kernel/edit-records";
import * as signals from "@/modules/kernel/hillclimb";
import * as evals from "@/modules/kernel/evals";
import * as usage from "@/modules/kernel/llm-calls";
import type { SynapseModule } from "@/modules/kernel/contracts";
afterEach(() => vi.restoreAllMocks());

it("renders only supported sweeps with curated cases and describes the separate owner decision", async () => {
  vi.spyOn(owner, "requireOwnerPage").mockResolvedValue({} as Awaited<ReturnType<typeof owner.requireOwnerPage>>);
  vi.spyOn(admin, "withAdminWorkspace").mockImplementation(async (fn) =>
    fn({ id: "fiction", name: "Workspace", schema_name: "public", demo: false, source: "picked" }),
  );
  vi.spyOn(workspaces, "getWorkspace").mockResolvedValue({ id: "fiction", demo_mode: false } as workspaces.Workspace);
  vi.spyOn(llm, "isTestStub").mockReturnValue(false);
  vi.spyOn(switches, "aiEnabled").mockResolvedValue(true);
  vi.spyOn(switches, "aiSectionEnabled").mockResolvedValue(true);
  vi.spyOn(history, "listRuns").mockResolvedValue([]);
  vi.spyOn(history, "stageHealth").mockResolvedValue([]);
  vi.spyOn(edits, "listEdits").mockResolvedValue([]);
  vi.spyOn(signals, "listSignals").mockResolvedValue([]);
  vi.spyOn(evals, "listEvalRuns").mockResolvedValue([]);
  vi.spyOn(usage, "llmTotalsByStage").mockResolvedValue({});
  vi.spyOn(routing, "approvedEvaluationRoute").mockResolvedValue(
    {} as Awaited<ReturnType<typeof routing.approvedEvaluationRoute>>,
  );
  const active = vi.spyOn(registry, "activeModule").mockImplementation(
    async (stage) =>
      ({
        freeze: async () => ({}),
        evals: {
          variantInstruction: (version: string) => version,
          cases: async () => (stage === "S2" ? [{ name: "curated", gold: { must_match: ["target"] } }] : []),
        },
      }) as unknown as SynapseModule<unknown, unknown>,
  );
  const render = async () => renderToStaticMarkup(<AiStatusProvider enabled>{await RunsPage()}</AiStatusProvider>);
  const html = await render();
  expect(html).toContain("Hillclimb S2");
  expect(html).not.toMatch(/Hillclimb S[34689]/);
  expect(html).toContain("historical drift");
  expect(html).toContain("explicit owner approval");
  expect(html).not.toMatch(/promote the winning variant|Scored in the hillclimb sweep/);
  active.mockClear();
  vi.mocked(llm.isTestStub).mockReturnValue(true);
  expect(await render()).toContain('data-testid="hillclimb-unavailable"');
  expect(active).not.toHaveBeenCalled();
});
