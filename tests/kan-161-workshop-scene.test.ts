/** @vitest-environment jsdom */
/** KAN-161: exercise native scene PATCH responses through the rendered workshop. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkshopStage } from "@/components/accuracy/workshop-stage";
import type { WorkshopSnapshotRecord } from "@/accuracy/store/workshop-store";
import type { WorkshopScene } from "@/accuracy/modules/workshop/readiness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function snapshot(scene: WorkshopScene, version = 1): WorkshopSnapshotRecord {
  return {
    id: "snapshot-161", workspace_id: "workspace-161", version, scene,
    note: null, saved_by: "Owner", saved_function: "Medical", saved_at: "2026-10-25T00:00:00Z",
    payload: {
      scene, overlays: {}, actions: [],
      inventory: {
        workspace_id: "workspace-161", captured_at: "2026-10-25T00:00:00Z", joins: [], tactics: [],
        gaps: ["high", "medium"].map((priority, index) => ({
          id: `gap-${index}`, statement: `Gap ${index} version ${version}`, priority,
          validated: true, status: "active", coverage_status: "open", source_badge: null,
        })),
      },
      facilitator_tags: {
        tags: [{ id: "first", label: "First board" }, { id: "second", label: "Second board" }],
        assignments: { "gap-0": "first", "gap-1": "second" },
      },
    },
  };
}

function render(scene: WorkshopScene) {
  act(() => root.render(createElement(WorkshopStage, {
    workspaceId: "workspace-161", workspaceName: "Scene regression", workspaceSlug: "scene-regression",
    snapshot: snapshot(scene), exitHref: "/admin/accuracy",
  })));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(item => item.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

function selectSecondGap(scene: WorkshopScene) {
  const boards = container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Workshop boards"] button');
  act(() => boards[1]!.click());
  expect(container.querySelector("h2")?.textContent).toBe(scene === "gaps" ? "Second board" : "Medium");
  act(() => container.querySelector<HTMLButtonElement>("main li button")!.click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Gap 1 version 1");
}

it.each([
  ["gaps", "prioritize", "Prioritize", "High"],
  ["prioritize", "gaps", "Gaps", "First board"],
] as const)("switches %s to %s, installs returned snapshot and clears board/selection", async (from, to, label, firstBoard) => {
  let resolve!: (response: Response) => void;
  const request = new Promise<Response>(done => { resolve = done; });
  const fetchMock = vi.fn().mockReturnValue(request);
  vi.stubGlobal("fetch", fetchMock);
  render(from);
  selectSecondGap(from);

  await act(async () => button(label).click());
  expect(button("Gaps").disabled).toBe(true);
  expect(button("Prioritize").disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/accuracy/workshop", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: "workspace-161", snapshot_id: "snapshot-161", scene: to }),
  });
  await act(async () => resolve(new Response(JSON.stringify({ ok: true, snapshot: snapshot(to, 2) }))));

  expect(container.querySelector("h2")?.textContent).toBe(firstBoard);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("frozen v2");
  expect(container.querySelector("main")?.textContent).toContain("Gap 0 version 2");
  expect(button(label).className).toContain("bg-foreground");
  expect(button("Gaps").disabled).toBe(false);
  expect(button("Prioritize").disabled).toBe(false);
  expect(container.textContent).not.toContain("Could not switch scene");
});

it("shows the server error, preserves scene and selection, then permits a successful retry", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Scene is locked by another facilitator" }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, snapshot: snapshot("prioritize", 2) }))));
  render("gaps");
  selectSecondGap("gaps");
  await act(async () => button("Prioritize").click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Scene is locked by another facilitator");
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Gap 1 version 1");
  expect(container.querySelector("h2")?.textContent).toBe("Second board");
  expect(button("Gaps").className).toContain("bg-foreground");
  expect(container.textContent).toContain("frozen v1");
  expect(button("Gaps").disabled).toBe(false);
  expect(button("Prioritize").disabled).toBe(false);

  await act(async () => button("Prioritize").click());
  expect(container.querySelector("h2")?.textContent).toBe("High");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("frozen v2");
  expect(container.textContent).not.toContain("Scene is locked");
});

it.each([
  ["invalid JSON", () => new Response("not JSON")],
  ["null body", () => new Response("null")],
  ["missing snapshot", () => new Response(JSON.stringify({ ok: true }))],
  ["malformed snapshot", () => new Response(JSON.stringify({ ok: true, snapshot: { id: "broken" } }))],
  ["malformed inventory", () => {
    const invalid = snapshot("prioritize", 2);
    return new Response(JSON.stringify({ ok: true, snapshot: { ...invalid, payload: { ...invalid.payload, inventory: null } } }));
  }],
  ["HTTP failure despite ok:true", () => new Response(JSON.stringify({ ok: true, snapshot: snapshot("prioritize", 2) }), { status: 500 })],
] as const)("rejects %s without replacing the current snapshot and clears pending", async (_name, response) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  render("gaps");
  await act(async () => button("Prioritize").click());
  expect(container.textContent).toContain("frozen v1");
  expect(container.querySelector("h2")?.textContent).toBe("First board");
  expect(container.querySelector("p.text-destructive")).not.toBeNull();
  expect(button("Gaps").className).toContain("bg-foreground");
  expect(button("Gaps").disabled).toBe(false);
  expect(button("Prioritize").disabled).toBe(false);
});

it("retains the automatic first populated board policy when no board was chosen", async () => {
  const initial = snapshot("gaps");
  initial.payload.facilitator_tags.assignments["gap-0"] = "second";
  const updated = snapshot("prioritize", 2);
  updated.payload.inventory.gaps[0]!.priority = "medium";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, snapshot: updated }))));
  act(() => root.render(createElement(WorkshopStage, {
    workspaceId: "workspace-161", workspaceName: "Scene regression", workspaceSlug: "scene-regression",
    snapshot: initial, exitHref: "/admin/accuracy",
  })));
  expect(container.querySelector("h2")?.textContent).toBe("Second board");
  await act(async () => button("Prioritize").click());
  expect(container.querySelector("h2")?.textContent).toBe("Medium");
  expect(container.textContent).toContain("frozen v2");
});

it("shows a network failure while preserving the scene and clearing pending", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network connection lost")));
  render("gaps");
  await act(async () => button("Prioritize").click());
  expect(container.querySelector("p.text-destructive")?.textContent).toBe("Network connection lost");
  expect(container.querySelector("h2")?.textContent).toBe("First board");
  expect(container.textContent).toContain("frozen v1");
  expect(button("Gaps").disabled).toBe(false);
  expect(button("Prioritize").disabled).toBe(false);
});
