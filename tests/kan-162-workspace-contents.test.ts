/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkspaceContents } from "@/components/workspaces/workspace-contents";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const props = { workspaceId: "confirmed-a", demo: false, isCurrent: true };
const click = async (text: string, dialog = false) => {
  const selector = dialog ? '[role="dialog"] button' : 'button';
  const button = [...document.querySelectorAll(selector)].find(b => b.textContent?.trim() === text) as HTMLButtonElement;
  await act(async () => button.click());
};
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
it.each([true, false])("sends the confirmed workspace for current=%s", async (isCurrent) => {
  // Arrange: render the real dialog and record outgoing HTTP requests.
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  act(() => root.render(createElement(WorkspaceContents, { ...props, isCurrent })));
  await click("Load demo data");
  // Act: accept the destructive confirmation.
  await click("Replace with demo data", true);
  // Assert: selection precedes replacement only for a non-current card.
  expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual([
    ...(!isCurrent ? [["/api/workspaces/select", { workspace_id: "confirmed-a" }]] : []),
    ["/api/iegp", { action: "load_demo", expected_workspace_id: "confirmed-a" }],
  ]);
  expect(document.body.textContent).toContain("Demo data loaded.");
});
it("a failed select keeps the confirmation open and prevents replacement", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "Selection failed" }, { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  act(() => root.render(createElement(WorkspaceContents, { ...props, isCurrent: false })));
  await click("Load demo data");
  await click("Replace with demo data", true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Selection failed");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
it.each([true, false])("a prop change and mismatch preserve the original target through retry (current=%s)", async (isCurrent) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/workspaces/select" ? Response.json({ ok: true }) : Response.json({ error: "The selected workspace changed. Reopen the intended workspace and try again. No contents were changed.", code: "workspace_mismatch" }, { status: 409 })));
  vi.stubGlobal("fetch", fetchMock);
  act(() => root.render(createElement(WorkspaceContents, { ...props, isCurrent })));
  await click("Reset to blank");
  act(() => root.render(createElement(WorkspaceContents, { ...props, workspaceId: "other-b", isCurrent: false })));
  await click("Reset to blank", true);
  expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual([
    ...(!isCurrent ? [["/api/workspaces/select", { workspace_id: "confirmed-a" }]] : []),
    ["/api/iegp", { action: "reset", expected_workspace_id: "confirmed-a" }],
  ]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reopen the intended workspace");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click("Reset to blank", true);
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body)).expected_workspace_id).toBe("confirmed-a");
});
