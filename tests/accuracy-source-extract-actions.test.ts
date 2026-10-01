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
  await act(async () => root.render(createElement(SourceExtractActions, { workspaceId: "ws", sourceFileId: "source", blockCount: 1, gate: { ready: true, stub: true, connect_path: "/control" } })));
  await act(async () => host.querySelector("button")!.click());
}
it("shows saved paused drafts, counts and review links and refreshes", async () => {
  await extract({ ok: false, paused: true, gaps_inserted: 2, tactics_inserted: 3, extraction_batch_id: "batch", runs: [{ run_id: "need-run", call_kind: "need_extract", summary: "Extracted" }, { run_id: "inventory-run", call_kind: "inventory_extract", summary: "Extracted" }] }, 409);
  expect(host.textContent).toContain("Drafts saved"); expect(host.textContent).toContain("paused");
  expect(host.textContent).toContain("2 gap(s)"); expect(host.textContent).toContain("3 tactic(s)");
  expect(host.textContent).not.toContain("Extract failed");
  expect(host.querySelector('a[href="/accuracy/runs/need-run?workspace_id=ws"]')).not.toBeNull();
  expect(host.querySelector('a[href="/accuracy/runs/inventory-run?workspace_id=ws"]')).not.toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});
it("retains ordinary success", async () => { await extract({ ok: true, gaps_inserted: 1, tactics_inserted: 0 }, 200); expect(host.textContent).toContain("Extracted 1 gap(s)"); expect(refresh).toHaveBeenCalledOnce(); });
it("retains the provider connection gate", async () => { await extract({ ok: false, error: "Connect provider", connect_path: "/control" }, 409); expect(host.textContent).toContain("Connect provider"); expect(host.querySelector('a[href="/control"]')).not.toBeNull(); expect(refresh).not.toHaveBeenCalled(); });
