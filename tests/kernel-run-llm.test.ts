import { describe, expect, it } from "vitest";
import { runMode } from "@/modules/kernel/run";

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
