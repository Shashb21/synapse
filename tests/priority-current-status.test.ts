import { afterEach, describe, expect, it, vi } from "vitest";

// Only Next request/browser boundaries are scripted; stores and eligibility are real.
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined,
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrioritizePlace } from "@/components/prioritize/prioritize-place";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { POST } from "@/app/api/iegp/route";
import { buildMappingTableView } from "@/lib/iegp/mapping-table";
import {
  assignTacticToGap, createGap, loadState, lockPriority, persistState,
  recordMissedTactic, resetDemoSetup, validateGap,
} from "@/lib/iegp/store";
import { resetWorkspaceModules } from "@/modules/kernel/db";
import { listEdits } from "@/modules/kernel/edit-records";
import { validatePlacement } from "@/modules/stages/s8-prioritization/module";
import type { IegpState } from "@/lib/iegp/types";
import type { MappingTableRow } from "@/modules/stages/s4-kg-mapping/module";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, withWorkspace } from "@/modules/workspaces/store";

const who = { actor_name: "Priority reviewer", actor_function: "heor" as const };
const actor = { name: who.actor_name, function: who.actor_function };
const rationale = "Payer decision needs this comparison";
afterEach(() => jar.values.clear());

async function openGap(existing = false) {
  await resetDemoSetup();
  await resetWorkspaceModules();
  const gap_id = await createGap({ name: "Current comparison need", statement: "Compare outcomes with standard care", domain: "efficacy", ...who });
  await validateGap({ gap_id, note: "No evidence covers this need yet", ...who });
  const residual_id = (await loadState()).residuals.find((row) => row.gap_id === gap_id)!.id;
  if (existing) await lockPriority({ residual_id, band: "high", override_reason: rationale, ...who });
  return { gap_id, residual_id };
}

async function importHeldOpen(gap_id: string, kind: "stale" | "mismatched") {
  const state = await loadState();
  const gap = state.gaps.find((row) => row.id === gap_id)!;
  gap.status_override = {
    status: "validated_open", from: "validated_partial", to: "validated_open",
    reason: "Historical held Open", ...who, at: "2026-01-01", stale: kind === "stale",
  };
  if (kind === "mismatched") gap.computed_status = "validated_partial";
  await persistState(state);
}

async function post(residual_id: string) {
  return POST(new Request("http://localhost/api/iegp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "lock_priority", residual_id, band: "low", note: rationale, ...who }),
  }));
}

describe("legacy priority current-status guard", () => {
  for (const boundary of ["store", "api"] as const) {
    for (const existing of [false, true]) {
      it.each(["stale", "mismatched"] as const)(`${boundary} refuses %s held Open before ${existing ? "updating" : "creating"} a priority`, async (kind) => {
        const p = await openGap(existing);
        await importHeldOpen(p.gap_id, kind);
        const before = await loadState();
        const edits = await listEdits({ entity_id: p.residual_id });
        if (boundary === "store") {
          await expect(lockPriority({ residual_id: p.residual_id, band: "low", override_reason: rationale, ...who })).rejects.toThrow(/only Open/i);
        } else {
          const response = await post(p.residual_id);
          expect(response.status).toBe(400);
          expect((await response.json()).error).toMatch(/only Open/i);
        }
        const after = await loadState();
        expect(after).toEqual(before);
        expect(await listEdits({ entity_id: p.residual_id })).toEqual(edits);
      });
    }
    it(`${boundary} still publishes a current Open priority with the human rationale and actor`, async () => {
      const p = await openGap();
      if (boundary === "store") {
        await lockPriority({ residual_id: p.residual_id, band: "low", override_reason: rationale, ...who });
      } else {
        expect((await post(p.residual_id)).status).toBe(200);
      }
      expect((await loadState()).priorities.find((row) => row.residual_id === p.residual_id)).toMatchObject({
        band: "low", override_reason: rationale,
        lock: { locked: true, ...who, note: rationale },
      });
    });
  }
});

async function signedWorkspace(role: "medical_affairs" | "viewer", run: () => Promise<void>) {
  const email = `priority-${crypto.randomUUID()}@example.com`;
  const workspace = await createWorkspace({ name: "Priority signed API", owner: email });
  const session = await createSession({ provider_id: "demo", subject: email, email,
    actor_name: "Signed planner", actor_function: "medical_affairs", role });
  jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
  await withWorkspace(workspace.id, run);
}

describe("authenticated legacy priority API", () => {
  it("records the session actor rather than the supplied body actor, with rationale and legacy publication", async () => {
    await signedWorkspace("medical_affairs", async () => {
      const p = await openGap();
      expect((await post(p.residual_id)).status).toBe(200);
      expect((await loadState()).priorities.find((row) => row.residual_id === p.residual_id)).toMatchObject({
        band: "low", override_reason: rationale,
        lock: { locked: true, actor_name: "Signed planner", actor_function: "medical_affairs", note: rationale },
      });
    });
  });
  it.each([false, true])("rejects a signed stale held Open request without mutation (existing priority: %s)", async (existing) => {
    await signedWorkspace("medical_affairs", async () => {
      const p = await openGap(existing);
      await importHeldOpen(p.gap_id, "stale");
      const before = await loadState();
      const edits = await listEdits({ entity_id: p.residual_id });
      const response = await post(p.residual_id);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/only Open/i);
      expect(await loadState()).toEqual(before);
      expect(await listEdits({ entity_id: p.residual_id })).toEqual(edits);
    });
  });
  it("still rejects a signed viewer without changing an eligible Open priority", async () => {
    await signedWorkspace("viewer", async () => {
      const p = await openGap(true);
      const before = await loadState();
      const response = await post(p.residual_id);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("forbidden");
      expect(await loadState()).toEqual(before);
    });
  });
});

async function renderPriority(state: IegpState) {
  const node = await PrioritizePlace({ state, setting: undefined, addressed: [], availableTactics: [] });
  const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
  return renderToStaticMarkup(createElement(Provider, { enabled: false }, node)).replace(/<!--.*?-->/g, "");
}

describe("actual Prioritize screen current-status selection", () => {
  it.each(["stale", "mismatched"] as const)("excludes %s held Open from rendered matrix cards, counts and Continue", async (kind) => {
    const p = await openGap();
    await validatePlacement({ gap_id: p.gap_id, band: "high", rationale, actor });
    await importHeldOpen(p.gap_id, kind);
    const html = await renderPriority(await loadState());
    expect(html).not.toContain("Current comparison need");
    expect(html).toContain("0 of 0 Open gaps validated across all settings");
    expect(html).toContain("No Open gap in all settings.");
    expect(html).not.toContain("Continue to tactics");
  });
  it("renders a current Open card, validated count and Continue, and keeps S8 legacy publication", async () => {
    const p = await openGap();
    await validatePlacement({ gap_id: p.gap_id, band: "high", rationale, actor });
    const state = await loadState();
    expect(state.priorities.find((row) => row.residual_id === p.residual_id)).toMatchObject({ band: "high", override_reason: rationale, lock: { locked: true, ...who } });
    const html = await renderPriority(state);
    expect(html).toContain("Current comparison need");
    expect(html).toContain("1 of 1 Open gaps validated across all settings");
    expect(html).toContain("Continue to tactics");
  });
});

describe("mapping table authoritative status versus draft verdict", () => {
  it.each(["validated_partial", "validated_addressed"] as const)("recomputes legacy cached %s without validation tokens while preserving the model verdict", async (cached) => {
    const p = await openGap();
    await recordMissedTactic({ name: "Historical plan", type: "rwe_study", evidence_question: "Compare outcomes?", status: "planned", ...who });
    const tactic_id = (await loadState()).tactics[0].id;
    await assignTacticToGap({ gap_id: p.gap_id, tactic_id, coverage: "partial", human: true, lock_coverage: true, note: rationale, ...who });
    const state = await loadState();
    const coverage = state.coverages.find((row) => row.gap_id === p.gap_id)!;
    delete coverage.overall_lock.gap_revision;
    delete coverage.overall_lock.tactic_revision;
    const gap = state.gaps.find((row) => row.id === p.gap_id)!;
    gap.status = cached;
    gap.computed_status = cached;
    await persistState(state);
    const proposal: MappingTableRow = { gap_id: p.gap_id, gap_name: gap.name, tactic_ids: [tactic_id], tactic_names: ["Historical plan"], mapping_status: "partially_addressed", confidence: 82, rationale: ["Draft comparison verdict"], mappings: [], review: null };
    const row = buildMappingTableView(await loadState(), [proposal]).find((item) => item.gap_id === p.gap_id);
    expect(row).toMatchObject({ gap_status: "open", mapping_status: "partially_addressed", source: "proposal", rationale: ["Draft comparison verdict"] });
  });
});
