/** @vitest-environment jsdom */
/** Session identity remains visible while development-only sign-in is disclosed. */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { SessionPanel } from "@/components/platform/session-panel";
import { NETWORK_ERROR } from "@/lib/post-json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
const defaults: ComponentProps<typeof SessionPanel> = { actorName: "Ada", role: "medical_affairs", signedIn: false, demo: true, demoSession: false, owner: false, providers: [] };
function render(props: Partial<ComponentProps<typeof SessionPanel>> = {}, Component = SessionPanel) {
  act(() => root.render(createElement(Component, { ...defaults, ...props })));
}
function button(name: string) { return [...container.querySelectorAll("button")].find(element => element.textContent?.includes(name))!; }
function fillName(value: string) {
  const input = container.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
function response(json: unknown, status = 200) { return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }); }
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); router.refresh.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("KAN-196 session context", () => {
  it("shows compact real signed-in owner identity even when no providers are configured", () => {
    render({ signedIn: true, demo: true, owner: true });
    expect(container.textContent).toContain("Ada · Medical Affairs");
    expect(container.textContent).toContain("Signed in");
    expect(container.textContent).toContain("Owner");
    expect(container.textContent).not.toContain("Demo session");
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Who is acting");
    expect(container.textContent).not.toContain("Owns the plan:");
    expect(button("Sign out")).toBeDefined();
  });
  it("omits an unconfirmed owner indicator when the caller lacks owner information", () => {
    render({ signedIn: true, owner: undefined });
    expect(container.textContent).not.toContain("Owner");
  });
  it("identifies an actual demo session even when identity providers are configured", () => {
    render({ signedIn: true, demo: false, demoSession: true, providers: [{ id: "google", label: "Google" }] });
    expect(container.textContent).toContain("Demo session");
    expect(container.textContent).toContain("Signed in");
    expect(container.textContent).not.toContain("Owner");
    expect(container.querySelector("details")).toBeNull();
  });
  it("keeps unsigned identity and genuine sign-in outside an initially closed native disclosure", () => {
    render({ providers: [{ id: "google", label: "Google" }] });
    expect(container.textContent).toContain("Ada · Medical Affairs");
    expect(container.textContent).toContain("Unsigned");
    const details = container.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Developer tools");
    expect(details.querySelector("form")).not.toBeNull();
    expect(details.contains(button("Continue with Google"))).toBe(false);
    expect(container.textContent).toContain("No identity provider is configured");
  });
  it("omits all demo controls in production and retains genuine sign-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Re-evaluate the existing build-time guard without resetting React's module identity.
    const productionModule = "@/components/platform/session-panel?production";
    const { SessionPanel: ProductionPanel } = await import(productionModule);
    render({ providers: [{ id: "google", label: "Google" }] }, ProductionPanel);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(button("Continue with Google")).toBeDefined();
    expect(container.textContent).not.toContain("In development");
  });
  it("keeps provider sign-in and sign-out request payloads", async () => {
    fetchMock.mockResolvedValue(response({ ok: true }));
    render({ providers: [{ id: "google", label: "Google" }] });
    await act(async () => button("Continue with Google").click());
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login", expect.objectContaining({ method: "POST", body: JSON.stringify({ provider_id: "google" }) }));
    expect(router.refresh).toHaveBeenCalledOnce();
    render({ signedIn: true });
    await act(async () => button("Sign out").click());
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/logout", expect.objectContaining({ body: JSON.stringify({ action: "sign_out" }) }));
  });
  it("preserves demo payload, prevents pending repeats, and shows a safe error outside the disclosure before retry", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    render();
    expect(button("Continue as a demo user").disabled).toBe(true);
    fillName("   ");
    expect(button("Continue as a demo user").disabled).toBe(true);
    fillName("Ada");
    act(() => {
      const [fn, role] = container.querySelectorAll("select");
      fn.value = "regulatory"; fn.dispatchEvent(new Event("change", { bubbles: true }));
      role.value = "viewer"; role.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("Continue as a demo user").disabled).toBe(false);
    await submit();
    expect(button("Continue as a demo user").disabled).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/login", expect.objectContaining({ body: JSON.stringify({ demo: true, actor_name: "Ada", actor_function: "regulatory", role: "viewer" }) }));
    await act(async () => finish(response({ error: "secret database password" }, 500)));
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("We couldn't complete this action");
    expect(alert.textContent).not.toContain("password");
    expect(container.querySelector("details")!.contains(alert)).toBe(false);
    fetchMock.mockResolvedValueOnce(response({ ok: true }));
    await submit();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(router.refresh).toHaveBeenCalledOnce();
  });
  it.each(["network", "invalid-json", "safe-rejection"])("recovers safely from %s", async failure => {
    render(); fillName("Ada");
    if (failure === "network") fetchMock.mockRejectedValueOnce(new TypeError("secret network diagnostic"));
    else if (failure === "invalid-json") fetchMock.mockResolvedValueOnce(new Response("private html", { status: 502 }));
    else fetchMock.mockResolvedValueOnce(response({ error: "Choose a valid name.", safe_error: true }, 400));
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(failure === "safe-rejection" ? "Choose a valid name." : NETWORK_ERROR);
    expect(button("Continue as a demo user").disabled).toBe(false);
  });
});
