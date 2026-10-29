/** @vitest-environment jsdom */
/** Switch saves expose confirmed state and accessible, safe feedback. */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiToggle } from "@/components/platform/ai-toggle";
import { AiSectionToggle } from "@/components/platform/ai-section-toggle";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function render(element: ReactElement) { act(() => root.render(element)); }
function button() { return container.querySelector("button")!; }
async function click() { await act(async () => button().click()); }
function response(json: unknown, ok = true) { return { ok, status: ok ? 200 : 500, json: async () => json }; }
const controls = [
  { name: "master", render: (enabled: boolean) => createElement(AiToggle, { enabled, actorName: "Admin" }), payload: (enabled: boolean) => ({ ok: true, ai: { enabled } }), scope: "all workspaces" },
  { name: "section", render: (enabled: boolean) => createElement(AiSectionToggle, { section: "ingestion", label: "Ingestion", enabled }), payload: (enabled: boolean) => ({ ok: true, ai_sections: { ingestion: enabled } }), scope: "Ingestion" },
];
describe.each(controls)("$name saved feedback", control => {
  it("announces delayed saving, blocks synchronous duplicates and keeps confirmed state", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise(done => { resolve = done; }));
    render(control.render(false));
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    act(() => { button().click(); button().click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-checked")).toBe("false");
    expect(status?.textContent).toContain("Saving");
    expect(button().getAttribute("aria-describedby")?.split(" ")).toContain(status?.id);
    await act(async () => resolve(response(control.payload(true))));
    expect(button().getAttribute("aria-checked")).toBe("true");
    expect(status?.textContent).toContain(control.scope);
    expect(status?.textContent).toMatch(/on/i);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
  it("keeps Saving and the duplicate guard when changed server props arrive during a save", async () => {
    // Arrange: persistence remains outstanding while another refresh confirms a changed state.
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise(done => { resolve = done; }));
    render(control.render(false));
    const status = container.querySelector('[role="status"]')!;
    act(() => button().click());

    // Act: merge the changed server state before the original POST completes.
    render(control.render(true));
    act(() => { button().click(); button().click(); });

    // Assert: confirmed props reconcile, but pending feedback and request protection survive.
    expect(button().getAttribute("aria-checked")).toBe("true");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe(`Saving AI for ${control.scope}…`);
    expect(button().getAttribute("aria-describedby")?.split(" ")).toContain(status.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => resolve(response(control.payload(true))));
    expect(button().disabled).toBe(false);
    expect(status.textContent).toContain("Saved.");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
  it("uses persisted responses for successive saves and reconciles changed server props", async () => {
    fetchMock.mockResolvedValueOnce(response(control.payload(true))).mockResolvedValueOnce(response(control.payload(false)));
    render(control.render(false));
    await click();
    expect(button().getAttribute("aria-checked")).toBe("true");
    await click();
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).enabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/off/i);
    render(control.render(true));
    expect(button().getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
  it("keeps saved feedback when refreshed props acknowledge the confirmed response", async () => {
    fetchMock.mockResolvedValue(response(control.payload(true)));
    render(control.render(false));
    await click();
    render(control.render(true));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
    expect(button().getAttribute("aria-checked")).toBe("true");
  });
  it("trusts the persisted value even when it differs from the requested value", async () => {
    fetchMock.mockResolvedValue(response(control.payload(false)));
    render(control.render(false));
    await click();
    expect(button().getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/off/i);
  });
  it.each(["http", "network", "missing", "null", "wrong-type", "invalid-json"])("handles %s failure safely and permits retry", async failure => {
    if (failure === "network") fetchMock.mockRejectedValueOnce(new TypeError("secret database password"));
    else if (failure === "invalid-json") fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError("secret database password"); } });
    else fetchMock.mockResolvedValueOnce(response(failure === "null" ? null : failure === "wrong-type" ? control.payload("yes" as unknown as boolean) : { error: "secret database password" }, failure !== "http"));
    fetchMock.mockResolvedValueOnce(response(control.payload(true)));
    render(control.render(false));
    await click();
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-checked")).toBe("false");
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(control.scope);
    expect(alert.textContent).toMatch(/turn on/i);
    expect(alert.textContent).toMatch(/try again/i);
    expect(container.textContent).not.toContain("secret");
    await click();
    expect(container.querySelector('[role="alert"]')?.textContent ?? "").toBe("");
    expect(button().getAttribute("aria-checked")).toBe("true");
  });
});
it("keeps section feedback independent and prevents master-disabled activation", async () => {
  fetchMock.mockResolvedValue(response({ ok: true, ai_sections: { ingestion: true } }));
  const sections = (disabled = false) => createElement("div", null,
    createElement(AiSectionToggle, { section: "ingestion", label: "Ingestion", enabled: false, disabled }),
    createElement(AiSectionToggle, { section: "mapping", label: "Mapping", enabled: false, disabled }));
  render(sections());
  await click();
  const statuses = container.querySelectorAll('[role="status"]');
  expect(statuses[0]?.textContent).toContain("Ingestion");
  expect(statuses[1]?.textContent).toBe("");
  render(sections(true));
  await click();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect([...container.querySelectorAll("button")].every(value => value.disabled)).toBe(true);
});

it("explains master-off manual continuity and recovery, and qualifies master-on availability", async () => {
  fetchMock.mockResolvedValueOnce(response({ ok: true, ai: { enabled: false } }))
    .mockResolvedValueOnce(response({ ok: true, ai: { enabled: true } }));
  render(createElement(AiToggle, { enabled: true, actorName: "Admin" }));
  await click();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("All customers can continue manual flows");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Use this switch to turn AI back on");
  await click();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved section preferences still apply");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("configured providers");
});
