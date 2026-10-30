/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccuracyGanttBoard } from "@/components/accuracy/accuracy-gantt-board";
import { activitiesToSvg } from "@/accuracy/modules/gantt-project/export-svg";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), post: vi.fn(), download: vi.fn(), raster: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/post-json", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/post-json")>(),
  postJson: mocks.post,
}));
vi.mock("@/components/accuracy/svg-to-png", () => ({ triggerBlobDownload: mocks.download, svgMarkupToPngBlob: mocks.raster }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const frozen = { id: "ACT-T1", tactic_id: "T1", start: "2026-01-01", end: "2026-06-01", readout: null, depends_on: [], gap_ids: [] };
const live = { ...frozen, start: "2027-01-01", end: "2027-06-01" };
const labels = [{ id: "T1", claim_type: "tactic" as const, statement: "Frozen study" }];
const liveLabels = [{ ...labels[0], statement: "Live renamed study" }];
const initial: ComponentProps<typeof AccuracyGanttBoard> = { workspaceId: "ws", activities: [frozen], catalog: labels, planVersion: 1, planStatus: "final", planId: "plan-1", snapshotHash: "hash-1", auditBundleHref: "/audit/1", liveActivities: [live], liveCatalog: liveLabels };
let root: Root;
let host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!;
function mount(props = initial) { act(() => root.render(createElement(AccuracyGanttBoard, props))); }
async function click(label: string) { await act(async () => button(label).click()); }
function note() {
  const input = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Reviewed current live projection");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.raster.mockResolvedValue(new Blob(["png"]));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("saved and live Gantt views", () => {
  it("defaults to saved labels/dates and uses the exact selected SVG for both exports", async () => {
    mount();
    expect(host.textContent).toContain("Frozen study");
    expect(host.textContent).not.toContain("Live renamed study");
    await click("Export SVG");
    expect(mocks.download.mock.calls[0][1]).toBe("synapse-gantt-ws-v1.svg");
    const exportedSvg = await mocks.download.mock.calls[0][0].text();
    expect(exportedSvg).toBe(activitiesToSvg([frozen], labels));
    await click("Export PNG");
    expect(mocks.raster).toHaveBeenCalledWith(exportedSvg);
    expect(mocks.download.mock.calls[1][1]).toBe("synapse-gantt-ws-v1.png");
    await click("Live projection (unsaved)");
    expect(host.textContent).toContain("Live renamed study");
    expect(host.textContent).not.toContain("hash-1");
    expect(host.textContent).not.toContain("latest plan v1");
    expect(host.querySelector('[data-testid="gantt-audit-bundle-link"]')).toBeNull();
    await click("Export PNG");
    expect(mocks.raster).toHaveBeenLastCalledWith(activitiesToSvg([live], liveLabels));
    expect(mocks.download.mock.calls[2][1]).toBe("synapse-gantt-ws-draft.png");
  });
  it("replaces saved bars, labels, version and hash together before a delayed router refresh", async () => {
    mount(); note();
    mocks.post.mockResolvedValue({ ok: true, json: { plan: { id: "plan-2", workspace_id: "ws", version: 2, status: "final", snapshot: { activities: [live], labels: liveLabels } }, snapshot_hash: "hash-2", audit_bundle: { href: "/audit/2" } } });
    await click("Save as final");
    expect(host.textContent).toContain("Live renamed study");
    expect(host.textContent).toContain("2027-01-01");
    expect(host.textContent).toContain("latest plan v2");
    expect(host.textContent).toContain("hash-2");
    expect(host.textContent).not.toContain("hash-1");
    await click("Export PNG");
    expect(mocks.raster).toHaveBeenLastCalledWith(activitiesToSvg([live], liveLabels));
    expect(mocks.download.mock.calls[0][1]).toBe("synapse-gantt-ws-v2.png");
    mount({ ...initial, workspaceId: "other", activities: [], catalog: [], planId: null, planVersion: null, snapshotHash: null, auditBundleHref: null, liveActivities: [], liveCatalog: [] });
    expect(host.textContent).not.toContain("hash-2");
    expect(host.textContent).not.toContain("Live renamed study");
    expect(button("Export PNG").disabled).toBe(true);
  });
  it("uses refreshed same-workspace props after save rather than keeping a local snapshot override", async () => {
    mount(); note();
    mocks.post.mockResolvedValue({ ok: true, json: { plan: { id: "plan-2", workspace_id: "ws", version: 2, status: "final", snapshot: { activities: [live], labels: liveLabels } }, snapshot_hash: "hash-2", audit_bundle: { href: "/audit/2" } } });
    await click("Save as final");
    mount({ ...initial, planId: "plan-3", planVersion: 3, snapshotHash: "hash-3" });
    expect(host.textContent).toContain("hash-3");
    expect(host.textContent).toContain("Frozen study");
    expect(host.textContent).not.toContain("hash-2");
  });
  it("keeps saved exports enabled when the live projection is empty", () => {
    mount({ ...initial, liveActivities: [], liveCatalog: [] });
    expect(button("Export PNG").disabled).toBe(false);
    expect(button("Save as final").disabled).toBe(true);
  });
  it("uses ID fallback for missing saved labels and labels live schedule editors as unsaved", async () => {
    mount({ ...initial, catalog: [], tactics: [{ id: "T1", statement: "Live renamed study", validated: true, start: live.start, end: live.end, readout: "", depends_on: [], dates_locked: false }] });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="T1"]')!.click());
    const detail = host.querySelector('[data-testid="gantt-activity-detail"]')!;
    expect(detail.textContent).toContain("T1");
    expect(detail.textContent).not.toContain("Live renamed study");
    expect(detail.textContent).not.toContain("Edit schedule");
    await click("Live projection (unsaved)");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Live renamed study"]')!.click());
    expect(host.textContent).toContain("Edit live schedule (unsaved)");
  });
  it("retains the coherent prior view when saving fails or returns an incomplete snapshot", async () => {
    mount(); note();
    mocks.post.mockResolvedValue({ ok: false, json: { error: "Save refused" } });
    await click("Save as final");
    expect(host.textContent).toContain("Save refused");
    expect(host.textContent).toContain("hash-1");
    mocks.post.mockResolvedValue({ ok: true, json: { snapshot_hash: "hash-2" } });
    await click("Save as final");
    expect(host.textContent).toContain("Save final failed. Check the current state before trying again. If this continues, contact your Synapse administrator.");
    expect(host.textContent).not.toContain("hash-2");
    expect(host.textContent).toContain("Frozen study");
  });
});
