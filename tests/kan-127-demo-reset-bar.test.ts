/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DemoResetBar } from "@/components/workspaces/demo-reset-bar";

/** KAN-127: a demo workspace's owner resets it to the clean demo in one confirm. */

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
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const workspace = (role: "owner" | "member") => ({ id: "wdemo", name: "Client demo", role, demo: true });
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("Reset demo bar", () => {
  it("a member sees that it is a demo, with no reset", () => {
    act(() => root.render(createElement(DemoResetBar, { workspace: workspace("member") })));
    expect(container.textContent).toContain("Demo workspace");
    expect(button("Reset demo")).toBeUndefined();
  });

  it("the owner confirms, and it loads the demo and opens the home page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    act(() => root.render(createElement(DemoResetBar, { workspace: workspace("owner") })));
    await act(async () => button("Reset demo")!.click());
    expect(document.body.textContent).toContain("Reset the demo?");
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Reset demo") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/iegp");
    expect(JSON.parse(String(init.body))).toEqual({ action: "load_demo" });
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("a refused reset stays open and says why", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Only the workspace owner can replace its contents." }, { status: 403 })));
    act(() => root.render(createElement(DemoResetBar, { workspace: workspace("owner") })));
    await act(async () => button("Reset demo")!.click());
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Reset demo") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/owner/);
    expect(document.body.textContent).toContain("Reset the demo?");
  });
});
