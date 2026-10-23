/** @vitest-environment jsdom */
/** Exercise saved navigation choices through the mounted React component. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { PlanChrome, type PlanNavModel } from "@/components/plan-chrome";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav: PlanNavModel = { gapsCount: 2, unvalidatedCount: 1, partialCount: 0, gapsUnlocked: true, planUnlocked: false, tacticsUnlocked: false, setupComplete: true, readyForPrioritize: false };
// createElement accepts children positionally, but its props overload still
// requires a required children property. Match the existing readiness test.
const Chrome = PlanChrome as ComponentType<Omit<ComponentProps<typeof PlanChrome>, "children"> & { children?: ReactNode }>;
const view = (present = false) => createElement(Chrome, { active: "gaps", nav, present }, "Plan content");
const key = "synapse-navigation-pinned";
let host: HTMLDivElement;
let root: Root;
const mount = () => act(() => root.render(view()));
const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="Pin navigation"]') ?? host.querySelector<HTMLButtonElement>('[aria-label="Unpin navigation"]');
beforeEach(() => {
  // Node can expose an incomplete global localStorage. Supply a deterministic
  // browser-shaped store so these tests exercise the component, not Node flags.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("restores a saved pin after mount without overwriting it, and restores unpin on remount", () => {
  localStorage.setItem(key, "true");
  const write = vi.spyOn(localStorage, "setItem");
  mount();
  expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[data-rail-slot]')?.className).toContain("w-[220px]");
  expect(write).not.toHaveBeenCalled();
  act(() => toggle()!.click());
  expect(localStorage.getItem(key)).toBe("false");
  act(() => root.unmount()); root = createRoot(host); mount();
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('[data-rail-slot]')?.className).toContain("w-[52px]");
});

it("keeps transient pointer opening separate from the saved preference", () => {
  mount();
  const rail = host.querySelector("aside")!;
  const move = new Event("pointermove", { bubbles: true });
  Object.defineProperty(move, "pointerType", { value: "mouse" });
  act(() => rail.dispatchEvent(move));
  expect(rail.getAttribute("data-open")).toBe("true");
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(localStorage.getItem(key)).toBeNull();
  act(() => rail.dispatchEvent(new Event("pointerout", { bubbles: true })));
  expect(rail.getAttribute("data-open")).toBe("false");
  act(() => toggle()!.click());
  act(() => rail.dispatchEvent(new Event("pointerout", { bubbles: true })));
  expect(rail.getAttribute("data-open")).toBe("true");
});

it.each(["getItem", "setItem"] as const)("keeps the toggle usable when storage %s fails", method => {
  vi.spyOn(localStorage, method).mockImplementation(() => { throw new DOMException("Storage blocked", "SecurityError"); });
  mount();
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  act(() => toggle()!.click());
  expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  act(() => toggle()!.click());
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
});

it("renders the server default without browser storage and omits controls when presenting", () => {
  localStorage.setItem(key, "true");
  expect(renderToString(view())).toContain('aria-pressed="false"');
  act(() => root.render(view(true)));
  expect(host.querySelector("aside")).toBeNull();
  expect(toggle()).toBeNull();
  expect(host.textContent).toContain("Plan content");
});
