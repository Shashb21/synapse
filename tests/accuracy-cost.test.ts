import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  formatCostUsd,
  formatTokenUsage,
  parseCostUsd,
  sumRunCostsUsd,
  usageFromMessages,
} from "@/accuracy/kernel/cost";
import {
  createOrganization,
  createWorkspace,
  listWorkspaces,
  setWorkspaceArchived,
} from "@/accuracy/store/tenant";

describe("accuracy cost estimates", () => {
  it("computes non-zero USD for known models", () => {
    const usage = usageFromMessages("system", "user prompt", "completion text");
    const { cost_usd } = estimateCostUsd({
      provider_id: "xai",
      model: "grok-4",
      usage,
    });
    expect(cost_usd).toBeGreaterThan(0);
  });

  it("formats stored numeric strings and token usage for display", () => {
    expect(formatCostUsd("0.00042")).toBe("$0.0004");
    expect(formatCostUsd(0.045)).toBe("$0.045");
    expect(formatCostUsd(1.2)).toBe("$1.20");
    expect(formatCostUsd(0)).toBeNull();
    expect(formatCostUsd(null)).toBeNull();
    expect(parseCostUsd("0.25")).toBe(0.25);
    expect(formatTokenUsage({ total_tokens: 1200 })).toBe("1,200 tok");
    expect(formatTokenUsage({ prompt_tokens: 100, completion_tokens: 50 })).toBe("150 tok");
    expect(sumRunCostsUsd([{ cost_usd: "0.01" }, { cost_usd: "0.02" }, { cost_usd: null }])).toBeCloseTo(
      0.03,
    );
  });
});

describe("workspace archive soft-hide", () => {
  it("hides archived workspaces from the default list and restores them", async () => {
    const org_id = await createOrganization("hygiene-org");
    const workspace_id = await createWorkspace({
      org_id,
      name: "Hygiene Demo",
      slug: `hygiene-${Date.now().toString(36)}`,
    });

    const before = await listWorkspaces(100);
    expect(before.some((w) => w.id === workspace_id)).toBe(true);

    const archived = await setWorkspaceArchived(workspace_id, true);
    expect(archived?.archived_at).toBeTruthy();

    const activeOnly = await listWorkspaces(100);
    expect(activeOnly.some((w) => w.id === workspace_id)).toBe(false);

    const withArchived = await listWorkspaces(100, { includeArchived: true });
    const row = withArchived.find((w) => w.id === workspace_id);
    expect(row?.archived_at).toBeTruthy();

    await setWorkspaceArchived(workspace_id, false);
    const restored = await listWorkspaces(100);
    expect(restored.some((w) => w.id === workspace_id)).toBe(true);
  });
});
