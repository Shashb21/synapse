/** @vitest-environment jsdom */
/** Observable draft, announcement, partial completion and uncertain-write regressions. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogTrigger: () => null, DialogClose: () => null,
}));
import { ActionDialog } from "@/components/platform/action-dialog";
import { WorkspaceContents } from "@/components/workspaces/workspace-contents";
import { SourceUploadForm } from "@/components/accuracy/source-upload-form";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { ModularUploadForm, ChainRunner } from "@/components/platform/pipeline-runner";
import { LearningConsole } from "@/components/platform/learning-console";
import { ClearIngestedFiles } from "@/components/clear-ingested-files";
import { SourceComparisonStatus } from "@/components/source-comparison-status";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const identity = { signed_in: true, actor_name: "Owner", actor_function: "medical_affairs" as const };
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); router.refresh.mockReset(); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function button(label: string) { return [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!; }
function render(node: React.ReactNode) { act(() => root.render(node)); }
function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) { act(() => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

describe("KAN-197 presentation", () => {
  it("retains correction input, associates validation and announces a body-sized error", async () => {
    render(<ActionDialog endpoint="/api/test" payload={{}} label="Edit" identity={identity} requireRationale={false} fields={[{ name: "name", label: "Name", required: true }]} />);
    await submit();
    const input = container.querySelector('input[name="name"]')!;
    const alert = container.querySelector('[role="alert"]')!;
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.className).toContain("text-sm");
    expect(alert.textContent).toContain("Name is required");
  });
  it("clears pending after uncertain edits, retains draft and prevents blind repeat", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("SQL secret=sk-test")); vi.stubGlobal("fetch", fetch);
    render(<ActionDialog endpoint="/api/test" payload={{}} label="Edit" identity={identity} requireRationale={false} fields={[{ name: "name", label: "Name", defaultValue: "Draft" }]} />);
    await submit();
    expect((container.querySelector('input[name="name"]') as HTMLInputElement).value).toBe("Draft");
    expect(container.textContent).not.toContain("Saving…");
    expect(container.textContent).not.toContain("sk-test");
    expect(button("Save").disabled).toBe(true);
    await submit(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Check current state");
  });
  it("guards repeated destructive reset after a lost reply and offers a read check", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("lost response")); vi.stubGlobal("fetch", fetch);
    render(<WorkspaceContents workspaceId="w" demo={false} isCurrent />);
    await act(async () => button("Reset to blank").click());
    // Both dialogs are rendered by the lightweight primitive mock; final reset button confirms.
    await act(async () => [...container.querySelectorAll("button")].filter(b => b.textContent?.trim() === "Reset to blank").at(-1)!.click());
    const reset = [...container.querySelectorAll("button")].filter(b => b.textContent?.trim() === "Reset to blank").at(-1)!;
    expect(reset.disabled).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("confirm");
    expect(button("Check workspace contents")).toBeDefined();
  });
  it("blocks another destructive clear until the current sources are checked", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("lost reply")); vi.stubGlobal("fetch", fetch);
    render(<ClearIngestedFiles />);
    await act(async () => button("Clear files and extracted records").click());
    const clear = button("Clear files and extracted records");
    expect(clear.disabled).toBe(true);
    await act(async () => clear.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(button("Check current sources")).toBeDefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("confirm");
  });
  it("states upload partial completion without raw parser diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, filename: "notes.txt", parser: "text", parse_error: "SQL sk-test secret", block_count: 0 })));
    render(<SourceUploadForm workspaceId="w" />);
    Object.defineProperty(container.querySelector('input[type="file"]'), "files", { value: [new File(["notes"], "notes.txt")] });
    await submit();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("registered");
    expect(container.textContent).toContain("reading its contents did not finish");
    expect(container.textContent).toContain("Add block"); expect(container.textContent).not.toContain("sk-test");
  });
  it("retains uploaded-source input and avoids uploading it twice when parsing fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, summary: "Source uploaded" })).mockResolvedValueOnce(Response.json({ error: "SQL sk-test" }, { status: 500 })); vi.stubGlobal("fetch", fetch);
    render(<AiStatusProvider enabled><ModularUploadForm demoOptions={[]} identity={identity} /></AiStatusProvider>);
    change(container.querySelector("textarea")!, "Retained note");
    await act(async () => button("Upload and parse").click());
    expect(container.querySelector("textarea")?.value).toBe("Retained note");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("uploaded");
    expect(button("Upload and parse").disabled).toBe(true);
    expect(container.textContent).not.toContain("sk-test");
  });
  it("keeps completed pipeline work visible and blocks whole-chain repeats", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, summary: "Completed extraction" })).mockResolvedValueOnce(Response.json({ error: "provider secret" }, { status: 500 })); vi.stubGlobal("fetch", fetch);
    render(<AiStatusProvider enabled><ChainRunner label="Build plan" identity={identity} steps={[{stage:"S2",label:"Extract claims"},{stage:"S8",label:"Prioritize gaps"}]} /></AiStatusProvider>);
    await act(async () => button("Build plan").click());
    expect(container.textContent).toContain("Completed extraction");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Prioritize gaps");
    expect(button("Build plan").disabled).toBe(true); expect(container.textContent).not.toContain("provider secret");
  });
  it("keeps confirmed learning changes visible when the refreshed report fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ revision: { id: "candidate-1", instruction_text: "Use reviewed evidence" } })).mockRejectedValueOnce(new Error("SQL sk-test")); vi.stubGlobal("fetch", fetch);
    render(<LearningConsole initial={{ bucket: "day", agreement: [], total: 0, date_range: null, revisions: [] }} />);
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Create"))!.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Candidate created");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("created, but");
    expect(container.textContent).not.toContain("sk-test");
    expect([...container.querySelectorAll("button")].find(b => b.textContent?.includes("Create"))!.disabled).toBe(true);
    expect(button("Reload learning report")).toBeDefined();
  });
  it("does not repeat an unconfirmed prompt candidate creation", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("lost reply")); vi.stubGlobal("fetch", fetch);
    render(<LearningConsole initial={{ bucket: "day", agreement: [], total: 0, date_range: null, revisions: [] }} />);
    const create = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Create"))!;
    await act(async () => create.click()); await act(async () => create.click());
    expect(fetch).toHaveBeenCalledTimes(1); expect(create.disabled).toBe(true);
    expect(container.textContent).toContain("Reload learning report");
  });
  it("never renders persisted comparison exceptions as public details", () => {
    render(createElement(SourceComparisonStatus, { sourceId: "s", comparison: { status: "failed", error: "SQL sk-test secret" } as never }));
    expect(container.textContent).toContain("parsed source remains usable"); expect(container.textContent).not.toContain("sk-test");
  });
});
