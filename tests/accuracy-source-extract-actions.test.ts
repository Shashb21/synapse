/** @vitest-environment jsdom */
/** Saved draft outcomes remain reviewable from the initiating extraction screen. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceExtractActions } from "@/components/accuracy/source-extract-actions";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  refresh.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function extract(body: object, status: number) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));
  await act(async () => root.render(createElement(SourceExtractActions, { workspaceId: "ws", sourceFileId: "source", blockCount: 1, gate: { ready: true, stub: true, connect_path: "/admin/control" } })));
  await act(async () => host.querySelector("button")!.click());
}
it("shows saved paused drafts, counts and review links and refreshes", async () => {
  await extract({ ok: false, paused: true, gaps_inserted: 2, tactics_inserted: 3, extraction_batch_id: "batch", runs: [{ run_id: "need-run", call_kind: "need_extract", summary: "Extracted" }, { run_id: "inventory-run", call_kind: "inventory_extract", summary: "Extracted" }] }, 409);
  expect(host.textContent).toContain("Drafts saved"); expect(host.textContent).toContain("paused");
  expect(host.textContent).toContain("2 gap(s)"); expect(host.textContent).toContain("3 tactic(s)");
  expect(host.textContent).not.toContain("Extract failed");
  expect(host.querySelector('a[href="/admin/accuracy/runs/need-run?workspace_id=ws"]')).not.toBeNull();
  expect(host.querySelector('a[href="/admin/accuracy/runs/inventory-run?workspace_id=ws"]')).not.toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});
it("retains ordinary success", async () => { await extract({ ok: true, gaps_inserted: 1, tactics_inserted: 0 }, 200); expect(host.textContent).toContain("Extracted 1 gap(s)"); expect(refresh).toHaveBeenCalledOnce(); });
it("retains the provider connection gate", async () => { await extract({ ok: false, error: "Connect provider", connect_path: "/admin/control" }, 409); expect(host.textContent).toContain("Connect provider"); expect(host.querySelector('a[href="/admin/control"]')).not.toBeNull(); expect(refresh).not.toHaveBeenCalled(); });

it("shows saved incomplete pages and retries with their source cursor", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, incomplete: true, gaps_inserted: 1,
    source_progress: { complete: false, next_cursor: "page-cursor", processed_units: 1, expected_units: 2 },
    runs: [{ run_id: "page1", call_kind: "need_extract" }] }) }).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, gaps_inserted: 2 }) });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(SourceExtractActions, { workspaceId: "ws", sourceFileId: "source", blockCount: 90, gate: { ready: true, stub: true, connect_path: "/admin/control" } })));
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("incomplete");
  expect(host.textContent).toContain("1/2");
  const retry = [...host.querySelectorAll("button")].find(b => b.textContent === "Retry remaining pages");
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ workspace_id: "ws", source_file_id: "source", cursor: "page-cursor", kinds: ["need", "inventory"] });
  expect(host.textContent).toContain("Extracted 2 gap(s)");
});
it("reports request failure and leaves extraction available for a retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network failed"); }));
  await act(async () => root.render(createElement(SourceExtractActions, { workspaceId: "ws", sourceFileId: "source", blockCount: 1, gate: { ready: true, stub: true, connect_path: "/admin/control" } })));
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Extract request failed");
  expect(host.querySelector("button")!.disabled).toBe(false);
});
it("restores a saved incomplete cursor on reload and distinguishes full-source completeness", async () => {
  await act(async () => root.render(createElement(SourceExtractActions, { workspaceId: "ws", sourceFileId: "source", blockCount: 1,
    gate: { ready: true, stub: true, connect_path: "/admin/control" }, checkpoint: { progress: { complete: false, full_source_complete: false, next_cursor: "saved", processed_units: 1, expected_units: 2, failed_units: 1, pages: [] } as never, kinds: ["need", "inventory"], stale: false } })));
  expect(host.textContent).toContain("Source progress: 1/2");
  expect(host.textContent).toContain("Full source: incomplete");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Retry remaining pages")).toBe(true);
});
it("shows incomplete proposal linking and can resume the same batch", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false, assembly_incomplete: true, gaps_inserted: 1, tactics_inserted: 1, extraction_batch_id: "batch-link", runs: [{ run_id: "need-run", call_kind: "need_extract", summary: "Extracted" }] }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, gaps_inserted: 1, tactics_inserted: 1 }) });
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(SourceExtractActions, { workspaceId: "ws", sourceFileId: "source", blockCount: 1, gate: { ready: true, stub: true, connect_path: "/admin/control" } })));
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Complete proposal linking is incomplete");
  const resume = [...host.querySelectorAll("button")].find(button => button.textContent === "Resume proposal linking")!;
  await act(async () => resume.click());
  expect(fetcher).toHaveBeenLastCalledWith("/api/accuracy/extract", expect.objectContaining({
    body: JSON.stringify({ action: "resume", workspace_id: "ws", source_file_id: "source", extraction_batch_id: "batch-link", idempotency_key: "resume:batch-link" }),
  }));
  expect(host.textContent).toContain("Extracted 1 gap(s)");
});
