import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * KAN-89: configuration and workspace changes land in the audit log with
 * before/after, and a reset keeps the workspace's own audit and gap version
 * history. The audit log is append-only, so assertions are scoped by this
 * run's ids. Owner actions run under the test owner bypass (no session).
 */

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

import "@/modules";
import { sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";
import { loadState } from "@/lib/iegp/store";
import { gapVersionsFor, WORKSPACE_RESET_ACTION } from "@/lib/iegp/gap-history";
import { POST as controlPost } from "@/app/api/control/route";
import { POST as accuracyRoutingPost } from "@/app/api/accuracy/routing/route";
import { accuracyRouteConfig } from "@/accuracy/kernel/routing";
import { listAuditEvents, type AuditEvent } from "@/modules/kernel/audit";
import { aiSwitch, storedAiSections } from "@/modules/kernel/ai-switch";
import { routeConfig, routeConfigs, setRouteConfig, stageHasRoute, type RouteConfig } from "@/modules/kernel/routing";
import { stageWiring } from "@/modules/kernel/registry";
import { loadAxes, loadScopeAxes, saveAxes, saveScopeAxes } from "@/modules/stages/s8-prioritization/axes";
import { replaceContents } from "@/modules/workspaces/contents";
import { createWorkspace, inviteMember, removeMember, renameWorkspace, withWorkspace } from "@/modules/workspaces/store";

const run = Math.random().toString(36).slice(2, 8);
const OWNER = `kan89-owner-${run}@kan89.example.test`;
const ACTOR = `KAN-89 ${run}`;

function post(handler: (request: Request) => Promise<Response>, url: string, body: Record<string, unknown>) {
  return handler(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR, actor_function: "medical_affairs", ...body }),
    }),
  );
}

async function control(body: Record<string, unknown>) {
  const res = await post(controlPost, "/api/control", body);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return res;
}

/** The newest audit event for this action and entity recorded since `since`. */
async function latest(action: string, entity_id: string | null, since: string): Promise<AuditEvent> {
  const { events } = await listAuditEvents({ action, ...(entity_id ? { entity_id } : {}), from: since }, { limit: 50 });
  const exact = events.filter((event) => event.action === action);
  expect(exact.length, `${action} ${entity_id ?? ""}`).toBeGreaterThan(0);
  return exact[0]!;
}

const restoreRoutes: RouteConfig[] = [];

afterAll(async () => {
  for (const route of restoreRoutes.filter((row) => stageHasRoute(row.stage))) {
    await setRouteConfig({
      stage: route.stage,
      provider_id: route.provider_id,
      model: route.model,
      temperature: route.params.temperature,
      max_tokens: route.params.max_tokens,
      fallbacks: route.fallbacks,
      actor_name: "test restore",
    });
  }
});

describe("KAN-89: configuration changes are audited", () => {
  it("records the AI switch and an AI section with before and after", async () => {
    const since = new Date().toISOString();
    const ai = await aiSwitch();
    await control({ action: "set_ai_enabled", enabled: ai.enabled, rationale: `kan89 ${run}` });
    const enabled = await latest("set_ai_enabled", "ai", since);
    expect(enabled).toMatchObject({ category: "config", before: { enabled: ai.enabled }, after: { enabled: ai.enabled } });
    expect(enabled.rationale).toBe(`kan89 ${run}`);

    const section = Object.keys((await storedAiSections()).sections)[0]!;
    const was = (await storedAiSections()).sections[section as keyof Awaited<ReturnType<typeof storedAiSections>>["sections"]];
    await control({ action: "set_ai_section", section, enabled: !was });
    await control({ action: "set_ai_section", section, enabled: was });
    const toggles = (await listAuditEvents({ action: "set_ai_section", entity_id: section, from: since })).events;
    expect(toggles.map((event) => event.after)).toEqual([{ enabled: was }, { enabled: !was }]);
    expect(toggles[1]!.before).toEqual({ enabled: was });

    await control({ action: "set_ai_sections", enabled: true });
    expect((await latest("set_ai_sections", "all", since)).after).toMatchObject({ [section]: true });
  });

  it("records a route change and the default provider with each stage before and after", async () => {
    const since = new Date().toISOString();
    restoreRoutes.push(...(await routeConfigs()));
    const s9 = await routeConfig("S9");
    await control({ action: "set_route", stage: "S9", provider_id: "xai-grok", model: "grok-4", max_tokens: 4321, fallbacks: "" });
    const route = await latest("set_route", "S9", since);
    expect(route.before).toMatchObject({ provider_id: s9.provider_id, model: s9.model });
    expect(route.after).toMatchObject({ provider_id: "xai-grok", model: "grok-4", params: { max_tokens: 4321 } });

    await control({ action: "set_default_provider", provider_id: "anthropic-claude" });
    const fleet = await latest("set_default_provider", "all", since);
    expect((fleet.before as Record<string, { provider_id: string }>).S9!.provider_id).toBe("xai-grok");
    expect((fleet.after as Record<string, { provider_id: string }>).S9!.provider_id).toBe("anthropic-claude");
  });

  it("records module activation and who computed lessons, with counts", async () => {
    const since = new Date().toISOString();
    const wired = (await stageWiring()).find((row) => row.active)!;
    await control({ action: "activate_module", stage: wired.stage, module_id: wired.active!.id });
    const activation = await latest("activate_module", wired.stage, since);
    expect(activation.after).toEqual({ module_id: wired.active!.id, version: wired.active!.version });

    await control({ action: "compute_lessons", limit: 0 });
    const lessons = await latest("compute_lessons", null, since);
    expect(lessons.meta).toEqual({ limit: 0, ok: 0, failed: 0, pending: 0 });
  });

  it("records accuracy-lab routing changes", async () => {
    const since = new Date().toISOString();
    const current = await accuracyRouteConfig("parse", "proposer");
    const res = await post(accuracyRoutingPost, "/api/accuracy/routing", {
      action: "set_route",
      call_kind: "parse",
      agent_role: "proposer",
      provider_id: current.provider_id,
      model: current.model,
    });
    expect(res.status).toBe(200);
    const event = await latest("accuracy.set_route", "parse:proposer", since);
    expect(event.before).toMatchObject({ provider_id: current.provider_id, model: current.model });
    expect(event.after).toMatchObject({ provider_id: current.provider_id, model: current.model });
  });

  it("records the prioritization axes and a scope's axes in their workspace", async () => {
    const since = new Date().toISOString();
    const ws = await createWorkspace({ name: `KAN-89 axes ${run}`, owner: OWNER });
    await withWorkspace(ws.id, async () => {
      const axes = await loadAxes();
      const swapped = { axes: axes.axes, x_axis: axes.y_axis, y_axis: axes.x_axis, bands: axes.bands };
      await saveAxes({ config: swapped, actor_name: ACTOR });
      const saved = (await listAuditEvents({ action: "save_axes", workspace_id: ws.id, from: since })).events[0]!;
      expect(saved.before).toMatchObject({ x_axis: axes.x_axis, y_axis: axes.y_axis });
      expect(saved.after).toMatchObject({ x_axis: axes.y_axis, y_axis: axes.x_axis });

      await saveScopeAxes({ scope: "all", x_axis: axes.x_axis, y_axis: axes.y_axis, actor_name: ACTOR });
      expect(await loadScopeAxes("all")).toMatchObject({ x_axis: axes.x_axis });
      const scope = (await listAuditEvents({ action: "save_scope_axes", workspace_id: ws.id, from: since })).events[0]!;
      expect(scope.before).toBeNull();
      expect(scope.after).toEqual({ x_axis: axes.x_axis, y_axis: axes.y_axis });
    });
  });
});

describe("KAN-89: workspace changes are audited", () => {
  it("records create, rename (old to new), invite and remove", async () => {
    const ws = await createWorkspace({ name: `KAN-89 team ${run}`, owner: OWNER });
    await renameWorkspace({ workspace_id: ws.id, name: `KAN-89 renamed ${run}`, by: OWNER });
    const guest = `kan89-guest-${run}@kan89.example.test`;
    await inviteMember({ workspace_id: ws.id, email: guest, by: OWNER });
    await removeMember({ workspace_id: ws.id, principal: guest, by: OWNER });

    const events = (await listAuditEvents({ category: "workspace", entity_id: ws.id })).events;
    expect(events.map((event) => event.action).reverse()).toEqual([
      "workspace.create",
      "workspace.rename",
      "workspace.member_invite",
      "workspace.member_remove",
    ]);
    for (const event of events) {
      expect(event.actor_principal).toBe(OWNER);
      expect(event.workspace_id).toBe(ws.id);
    }
    const rename = events.find((event) => event.action === "workspace.rename")!;
    expect(rename.before).toEqual({ name: `KAN-89 team ${run}` });
    expect(rename.after).toEqual({ name: `KAN-89 renamed ${run}` });
    expect(events.find((event) => event.action === "workspace.member_invite")!.after).toEqual({ principal: guest, role: "member" });
    expect(events.find((event) => event.action === "workspace.member_remove")!.before).toEqual({ principal: guest, role: "member" });
  });

  it("keeps the workspace audit and gap history through reset and demo load, and records both with counts", async () => {
    const ws = await createWorkspace({ name: `KAN-89 reset ${run}`, owner: OWNER });
    await withWorkspace(ws.id, async () => {
      await replaceContents(ws.id, "demo", { name: ACTOR, function: "medical_affairs" });
      const demo = await loadState();
      const gap = demo.gaps[0]!;
      // A version of the demo gap, as a merge or retirement would write it.
      await db().execute(sql`
        insert into gap_versions (id, live_gap_id, retired_gap_id, name, statement, status, domain, event, at, actor_name, actor_function)
        values ('GV-001', ${gap.id}, ${gap.id}, ${gap.name}, ${gap.statement}, ${gap.status}, ${gap.domain}, 'merged', ${new Date().toISOString()}, ${ACTOR}, 'medical_affairs')`);
      expect(gapVersionsFor(await loadState(), gap.id)).toHaveLength(1);
      const auditBefore = (await loadState()).audit.map((row) => row.id);

      await replaceContents(ws.id, "blank", { name: ACTOR, function: "medical_affairs" });
      const blank = await loadState();
      expect(blank.gaps).toHaveLength(0);
      expect(blank.gap_versions.map((row) => row.id)).toContain("GV-001");
      expect(blank.audit.map((row) => row.id)).toEqual(expect.arrayContaining(auditBefore));
      expect(blank.audit.filter((row) => row.action === WORKSPACE_RESET_ACTION)).toHaveLength(2);

      await replaceContents(ws.id, "demo", { name: ACTOR, function: "medical_affairs" });
      const reloaded = await loadState();
      // The reloaded gap reuses the id, but not the replaced gap's history.
      expect(reloaded.gaps.some((row) => row.id === gap.id)).toBe(true);
      expect(gapVersionsFor(reloaded, gap.id)).toHaveLength(0);
      expect(reloaded.gap_versions).toHaveLength(1);
      expect(reloaded.audit.filter((row) => row.action === WORKSPACE_RESET_ACTION && row.actor_name === ACTOR)).toHaveLength(3);
    });

    const events = (await listAuditEvents({ category: "workspace", entity_id: ws.id })).events;
    expect(events.map((event) => event.action).reverse()).toEqual([
      "workspace.create",
      "workspace.load_demo",
      "workspace.reset_blank",
      "workspace.load_demo",
    ]);
    const reset = events.find((event) => event.action === "workspace.reset_blank")!;
    expect((reset.before as { gaps: number }).gaps).toBeGreaterThan(0);
    expect(reset.after).toMatchObject({ gaps: 0, tactics: 0, gap_versions: 1 });
  });
});
