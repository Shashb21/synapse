/** @vitest-environment jsdom */
/** Contributor controls exercise visible state and requests through the real client component. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OmissionActions from "@/app/accuracy/runs/[run_id]/omission-actions";

const issue = { issue_id: "issue-1", item_kind: "gap", summary: "Regional evidence need",
  source_ref: { source_file_id: "source-1", block_id: "block-1" }, evidence_quote: "Evidence",
  basis: "explicit", importance: "important", reason: "Missing gap", suggested_action: "Add gap" };
const item = { workspace_id: "ws-1", run_id: "run-1", source_file_id: "source-1",
  call_kind: "need_extract", issue, latest_action: null, blocking: true };
let review: Record<string, unknown>;
let currentItems: unknown[];
let post: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; body: Record<string, unknown> }>;
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  review = { current: true, items: [item], actions: [], extraction_batch_id: "server-batch", source_file_id: "source-1" };
  currentItems = [item];
  post = vi.fn(async () => response({ ok: true }));
  get = vi.fn(async (url: string) => response(url.includes("run_id=") ? review : { items: currentItems }));
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const body = JSON.parse(options.body as string);
      requests.push({ url, body });
      return post(url, body);
    }
    return get(url);
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function mount(canReview = true) {
  await act(async () => root.render(createElement(OmissionActions, { workspaceId: "ws-1", runId: "run-1", canReview })));
}
function text() { return host.textContent ?? ""; }
async function input(label: string, value: string, index = 0) {
  const element = Array.from(host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"))
    .filter((node) => host.querySelector(`label[for="${node.id}"]`)?.textContent === label)[index]!;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(node => node.textContent === label)!;
  expect(button, label).toBeTruthy();
  await act(async () => button.click());
}
async function submit(index = 0) {
  await act(async () => host.querySelectorAll("form")[index]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

/** Hold both review reads so tests observe the intermediate loading render. */
function delayReviewReads() {
  const release: Array<() => void> = [];
  get.mockImplementation((url: string) => new Promise(resolve => {
    release.push(() => resolve(response(url.includes("run_id=") ? review : { items: currentItems })));
  }));
  return async () => { await act(async () => { release.forEach(resolve => resolve()); }); };
}

describe("omission review controls", () => {
  it("shows a paused important issue, exact identity and four contributor choices", async () => {
    await mount();
    expect(text()).toContain("Paused");
    expect(text()).toContain("Current extraction");
    expect(text()).toContain("issue-1");
    expect(host.querySelector("select")?.textContent).toContain("Add item");
    expect(host.querySelector("select")?.textContent).toContain("Link existing item");
    expect(host.querySelector("select")?.textContent).toContain("Dismiss");
    expect(host.querySelector("select")?.textContent).toContain("Reclassify");
    expect(text()).not.toContain("Resume downstream work");
  });
  it("shows an advisory without labeling it paused", async () => {
    review.items = [{ ...item, blocking: false, issue: { ...issue, importance: "advisory", basis: "inferred" } }];
    currentItems = review.items as unknown[];
    await mount();
    expect(text()).toContain("Advisory");
    expect(text()).not.toContain("Paused");
  });
  it("shows linked claim, actor and reason while hiding closed controls", async () => {
    review.items = [{ ...item, blocking: false, latest_action: { action: "link_existing", claim_id: "gap-9",
      actor_name: "Alex", actor_function: "heor", reason: "Already captured", issue_id: "issue-1" } }];
    currentItems = review.items as unknown[];
    await mount();
    expect(text()).toContain("gap-9");
    expect(text()).toContain("Alex");
    expect(text()).toContain("Already captured");
    expect(host.querySelector("form")).toBeNull();
  });
  it("keeps viewer status visible without forms or resume controls", async () => {
    await mount(false);
    expect(text()).toContain("issue-1");
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });
  it("keeps superseded review history visible without action controls", async () => {
    review.current = false;
    await mount();
    expect(text()).toContain("Superseded extraction");
    expect(host.querySelector("form")).toBeNull();
  });
  it("requires explicit distinct confirmation after ambiguity, with a new decision key", async () => {
    post.mockResolvedValueOnce(response({ error: "Ambiguous claim gap-2; confirm this is a distinct item before adding." }, 409));
    await mount();
    await input("Reason", "Separate need");
    await submit();
    expect(requests).toHaveLength(1);
    expect(text()).toContain("Ambiguous claim gap-2");
    expect(requests[0].body).toMatchObject({ workspace_id: "ws-1", run_id: "run-1", issue_id: "issue-1", action: "add", reason: "Separate need" });
    await click("Confirm distinct item and add");
    expect(requests[1].body.confirmed_distinct).toBe(true);
    expect(requests[1].body.idempotency_key).not.toBe(requests[0].body.idempotency_key);
  });
  it("does not offer distinct confirmation for a superseded or equivalent conflict", async () => {
    post.mockResolvedValueOnce(response({ error: "Equivalent claim gap-2 already exists; link it instead." }, 409));
    await mount(); await input("Reason", "New item"); await submit();
    expect(text()).toContain("link it instead");
    expect(text()).not.toContain("Confirm distinct item and add");
    expect(requests).toHaveLength(1);
  });
  it("retains the request key on retry and changes it for an edited decision", async () => {
    post.mockRejectedValueOnce(new TypeError("Network unavailable"));
    post.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await mount(); await input("Reason", "Missing evidence"); await submit();
    expect(text()).toContain("Try again");
    await submit();
    expect(requests[1].body.idempotency_key).toBe(requests[0].body.idempotency_key);
    await input("Reason", "Revised reason"); await submit();
    expect(requests[2].body.idempotency_key).not.toBe(requests[1].body.idempotency_key);
  });
  it("sends link and reclassification fields using the exact issue", async () => {
    await mount(); await input("Action", "link_existing"); await input("Claim ID", "gap-3");
    await input("Reason", "Existing evidence"); await submit();
    expect(requests[0].body).toMatchObject({ action: "link_existing", claim_id: "gap-3", issue_id: "issue-1" });
    await input("Action", "reclassify"); await input("Importance", "advisory"); await submit();
    expect(requests[1].body).toMatchObject({ action: "reclassify", new_importance: "advisory" });
  });
  it("uses only the server batch ID to resume after every workspace blocker clears", async () => {
    review.items = [{ ...item, blocking: false, latest_action: { action: "dismiss", reason: "Duplicate", actor_name: "Alex" } }];
    currentItems = [{ ...item, run_id: "other-run" }];
    await mount();
    expect(text()).not.toContain("Resume downstream work");
    currentItems = [];
    await click("Refresh review");
    await click("Resume downstream work");
    expect(requests[0]).toMatchObject({ url: "/api/accuracy/extract", body: { action: "resume",
      extraction_batch_id: "server-batch", workspace_id: "ws-1", source_file_id: "source-1" } });
    expect(text()).toContain("Downstream work resumed");
  });
  it("does not offer resume when the run still reports a blocker during refresh", async () => {
    currentItems = [];
    await mount();
    expect(text()).not.toContain("Resume downstream work");
  });
  it("resumes a run without findings using the server-owned source identity", async () => {
    review.items = []; currentItems = [];
    await mount(); await click("Resume downstream work");
    expect(requests[0].body).toMatchObject({ source_file_id: "source-1", extraction_batch_id: "server-batch" });
  });
  it("requires a reason before saving and sends a dismiss decision", async () => {
    await mount(); await input("Action", "dismiss"); await submit();
    expect(requests).toHaveLength(0);
    expect(text()).toContain("including a reason");
    await input("Reason", "Unsupported by evidence"); await submit();
    expect(requests[0].body).toMatchObject({ action: "dismiss", reason: "Unsupported by evidence" });
  });
  it("disables fields and exposes pending status until a decision completes", async () => {
    let complete!: (value: ReturnType<typeof response>) => void;
    post.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await mount(); await input("Reason", "Evidence reviewed"); await submit();
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Saving decision");
    await act(async () => complete(response({ ok: true })));
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
  });
  it("invalidates distinct confirmation when the contributor edits the decision", async () => {
    post.mockResolvedValueOnce(response({ error: "Ambiguous claim gap-2; confirm this is a distinct item before adding." }, 409));
    await mount(); await input("Reason", "Separate need"); await submit();
    expect(text()).toContain("Confirm distinct item and add");
    await input("Statement", "Different statement");
    expect(text()).not.toContain("Confirm distinct item and add");
  });
  it("preserves another issue's draft through the delayed refresh after saving", async () => {
    const second = { ...item, issue: { ...issue, issue_id: "issue-2", summary: "Second need" } };
    review.items = [item, second]; currentItems = [item, second];
    await mount();
    await input("Reason", "Carefully written review", 1);
    await input("Statement", "Detailed second statement", 1);
    await input("Reason", "First decision");
    const release = delayReviewReads();
    await submit();
    expect(host.querySelectorAll("form")).toHaveLength(2);
    expect(host.querySelectorAll("fieldset")[1].disabled).toBe(true);
    expect(host.querySelectorAll<HTMLTextAreaElement>("textarea")[3].value).toBe("Carefully written review");
    review.items = [{ ...item, blocking: false, latest_action: { action: "dismiss", actor_name: "Alex", reason: "First decision" } }, second];
    await release();
    const form = host.querySelector('form[aria-label="Review issue issue-2"]')!;
    expect(form.querySelectorAll<HTMLTextAreaElement>("textarea")[0].value).toBe("Detailed second statement");
    expect(form.querySelectorAll<HTMLTextAreaElement>("textarea")[1].value).toBe("Carefully written review");
    expect(form.querySelector("fieldset")?.disabled).toBe(false);
  });
  it("retains fields and the uncertain POST key across a delayed manual refresh", async () => {
    post.mockRejectedValueOnce(new TypeError("Response lost"));
    await mount(); await input("Reason", "Carefully written review"); await submit();
    const firstKey = requests[0].body.idempotency_key;
    const release = delayReviewReads();
    await click("Refresh review");
    expect(host.querySelector("form")).toBeTruthy();
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelectorAll<HTMLTextAreaElement>("textarea")[1].value).toBe("Carefully written review");
    await submit();
    expect(requests).toHaveLength(1);
    await release(); await submit();
    expect(requests[1].body.reason).toBe("Carefully written review");
    expect(requests[1].body.idempotency_key).toBe(firstKey);
  });
  it("prevents manual refresh and repeated submit while a decision POST is pending", async () => {
    let complete!: (value: ReturnType<typeof response>) => void;
    post.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await mount(); await input("Reason", "Pending decision"); await submit();
    const refresh = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Refresh review")!;
    expect(refresh.disabled).toBe(true);
    const readCount = get.mock.calls.length;
    await click("Refresh review"); await submit();
    expect(get.mock.calls).toHaveLength(readCount);
    expect(requests).toHaveLength(1);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => complete(response({ error: "Unavailable" }, 500)));
    expect(refresh.disabled).toBe(false);
  });
  it("keeps ambiguity confirmation and drafts through a failed review refresh", async () => {
    post.mockResolvedValueOnce(response({ error: "Ambiguous claim gap-2; confirm this is a distinct item before adding." }, 409));
    await mount(); await input("Reason", "Separate need"); await submit();
    get.mockResolvedValue(response({ error: "Lookup unavailable" }, 500));
    await click("Refresh review");
    expect(text()).toContain("Confirm distinct item and add");
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelectorAll<HTMLTextAreaElement>("textarea")[1].value).toBe("Separate need");
    get.mockImplementation(async (url: string) => response(url.includes("run_id=") ? review : { items: currentItems }));
    await click("Refresh review");
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    await click("Confirm distinct item and add");
    expect(requests[1].body.confirmed_distinct).toBe(true);
  });
  it("shows errors on lookup failures instead of treating them as clearance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Unavailable" }, 500)));
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
    expect(text()).not.toContain("Resume downstream work");
  });
});
