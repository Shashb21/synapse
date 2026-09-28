import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiOffBanner, AiStatusProvider } from "@/components/platform/ai-status";
import {
  aiConfirmCopy,
  MEMBER_NOTE,
  PLATFORM_OFF_NOTE,
  WorkspaceAiSetting,
  type WorkspaceAiModel,
} from "@/components/workspaces/workspace-ai-switch";

/** The AI assistance switch on the workspace settings page, rendered. */

const BASE: WorkspaceAiModel = {
  workspaceId: "w1",
  workspaceName: "Velmara EU",
  enabled: true,
  platformEnabled: true,
  owner: true,
  isCurrent: true,
};

function render(node: ReactNode, ai = true, offBy: "platform" | "workspace" | null = null) {
  return renderToStaticMarkup(createElement(AiStatusProvider, { enabled: ai, offBy }, node));
}

function setting(overrides: Partial<WorkspaceAiModel>) {
  return render(createElement(WorkspaceAiSetting, { model: { ...BASE, ...overrides } }));
}

describe("AI toggle in settings: the switch", () => {
  it("is an accessible switch the owner can flip", () => {
    const html = setting({});
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-labelledby="ws-ai"');
    expect(html).toContain(">AI assistance<");
    expect(html).not.toContain("aria-disabled");
    expect(setting({ enabled: false })).toContain('aria-checked="false"');
  });

  it("is read only for a member", () => {
    const html = setting({ owner: false });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(MEMBER_NOTE);
  });

  it("is off and disabled while the platform master switch is off", () => {
    const html = setting({ platformEnabled: false });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(PLATFORM_OFF_NOTE);
    expect(PLATFORM_OFF_NOTE).toBe("Turned off by your Synapse administrator");
  });

  it("the confirm explains what changes each way, with no reason asked", () => {
    const off = aiConfirmCopy(false, "Velmara EU");
    expect(off.title).toMatch(/turn off ai assistance for velmara eu/i);
    expect(off.body).toMatch(/Start with Add gaps and Add tactics/);
    expect(off.body).toMatch(/Generate ideas, the model's first placement on the matrix, Re-suggest/);
    expect(off.body).toMatch(/other workspaces are not affected/i);
    const on = aiConfirmCopy(true, "Velmara EU");
    expect(on.body).toMatch(/Upload replaces Start/);
    expect(`${off.body}${on.body}`).not.toMatch(/rationale|reason/i);
  });

  it("the banner names which switch turned AI off", () => {
    expect(render(createElement(AiOffBanner), true)).toBe("");
    expect(render(createElement(AiOffBanner), false, "workspace")).toContain("off for this workspace");
    expect(render(createElement(AiOffBanner), false, "platform")).toContain("AI is off.");
  });
});
