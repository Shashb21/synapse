import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMode } from "@/modules/kernel/run";
import { requireAccuracyLlm } from "@/accuracy/kernel/routing";
import { ideateModule } from "@/accuracy/modules/ideate/module";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { NoRouteError } from "@/modules/llm/provider";

describe("runStage mode", () => {
  it("believes the mode a stage reports", () => {
    expect(runMode({ mode: "llm", accepted: [] }, [])).toBe("llm");
    expect(runMode({ mode: "deterministic" }, [{ name: "llm:s8:score" }])).toBe("deterministic");
  });

  it("counts recorded llm:* completion steps when the stage reports no mode", () => {
    expect(runMode({ rows: 3 }, [{ name: "route" }, { name: "llm:S2 gap extract" }])).toBe("llm");
  });

  it("is deterministic only when no model was called", () => {
    expect(runMode({ rows: 3 }, [{ name: "route" }, { name: "round1:proposer" }])).toBe("deterministic");
    expect(runMode(null, [])).toBe("deterministic");
  });
});

describe("accuracy stub guard", () => {
  let savedStub: string | undefined;
  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });

  it("requireAccuracyLlm throws on an unconnected route outside the test stub", () => {
    expect(() => requireAccuracyLlm({ connected: false, auth: "none" }, "X")).toThrow(NoRouteError);
    expect(() => requireAccuracyLlm({ connected: true, auth: "oauth" }, "X")).not.toThrow();
    process.env.SYNAPSE_TEST_STUB_LLM = "1";
    expect(() => requireAccuracyLlm({ connected: false, auth: "none" }, "X")).not.toThrow();
  });

  it("ideate throws instead of returning an empty 'skipped' result without an LLM", async () => {
    const complete = vi.fn();
    const ctx = {
      org_id: "o",
      workspace_id: "w",
      actor: { name: "t", function: "medical_affairs" },
      role: "medical_affairs",
      run: { id: "r", note: () => {}, step: async (_n: string, fn: () => unknown) => await fn(), steps: () => [] },
      route: {
        call_kind: "ideate",
        role: "proposer",
        provider_id: "none",
        provider_label: "None",
        model: "none",
        auth: "none",
        connected: false,
        params: { temperature: 0, max_tokens: 0 },
        fallbacks: [],
        degraded: false,
        reason: "mechanical",
      },
      complete,
      noteCost: () => {},
    } as unknown as AccuracyModuleContext;
    await expect(
      ideateModule.run(
        {
          workspace_id: "w",
          gaps: [{ id: "g", statement: "Need OS", status: "open", priority_band: "high", validated: true }],
          existing_tactic_names: [],
          per_gap: 1,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NoRouteError);
    expect(complete).not.toHaveBeenCalled();
  });
});
