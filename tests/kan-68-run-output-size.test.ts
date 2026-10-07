import { describe, expect, it } from "vitest";
import { closeRun, getRun, openRun, RunRecorder } from "@/modules/kernel/observability";

/**
 * KAN-68: a run's output is read back by the app (the mapping table reads the
 * latest S4 output). A real plan's S4 output is ~50 KB; it used to be cut to a
 * 2 KB preview at 40 KB, so every gap showed "Not mapped yet".
 */
describe("KAN-68 run output size", () => {
  const recorder = () =>
    new RunRecorder({
      workspace_id: "default",
      stage: "S4",
      module_id: "kan68.output-size",
      module_version: "1.0.0",
      actor: { name: "KAN-68 test", function: "medical_affairs" },
      input: {},
    });

  it("stores a 60 KB output whole", async () => {
    const run = recorder();
    await openRun(run);
    const rows = Array.from({ length: 60 }, (_, i) => ({ gap_id: `GAP-${i}`, rationale: "x".repeat(1_000) }));
    await closeRun({ recorder: run, status: "ok", output: { rows } });
    const stored = await getRun(run.id);
    expect((stored?.output as { rows?: unknown[] }).rows).toHaveLength(60);
  });

  it("still cuts an oversized trace step to a preview", async () => {
    const run = recorder();
    await openRun(run);
    run.note("big", { blob: "y".repeat(50_000) });
    await closeRun({ recorder: run, status: "ok", output: {} });
    const stored = await getRun(run.id);
    const step = stored?.steps.find((s) => s.name === "big");
    expect(step?.data).toMatchObject({ truncated: true });
  });
});
