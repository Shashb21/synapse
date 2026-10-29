/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { ClearIngestedFiles } from "@/components/clear-ingested-files";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); router.refresh.mockClear(); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
describe("clear source inventory confirmation", () => {
  it("explains current-source removal and retained history, cancels safely, then sends an explicit confirmation and refreshes", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); vi.stubGlobal("fetch", fetcher);
    act(() => root.render(createElement(ClearIngestedFiles)));
    await act(async () => button("Clear ingested files").click());
    expect(document.body.textContent).toContain("all current sources (uploaded and typed)");
    expect(document.body.textContent).toContain("Historical audit records, run traces, saved plans and saved learning evidence remain");
    await act(async () => button("Cancel").click());
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => button("Clear ingested files").click());
    await act(async () => button("Clear files and extracted records").click());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: "clear_ingested_files", confirmation: "clear_ingested_files" });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Current sources and their extracted records cleared");
  });
  it("shows a busy response and leaves confirmation available for retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ safe_error: true, request_outcome: "rejected", error: "An ingestion step is still running." }) }));
    act(() => root.render(createElement(ClearIngestedFiles)));
    await act(async () => button("Clear ingested files").click());
    await act(async () => button("Clear files and extracted records").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("ingestion step is still running");
    expect(button("Clear files and extracted records").disabled).toBe(false);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
