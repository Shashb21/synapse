import { beforeEach, describe, expect, it, vi } from "vitest";

/** An in-memory cookie jar standing in for the browser, shared by every route call. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-synapse-admin-path": "/admin/runs" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/admin/runs",
  useSearchParams: () => new URLSearchParams(),
}));

import { createElement, Fragment, type ComponentType, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@/modules";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { DELETE as pickerDelete, GET as pickerGet, POST as pickerPost } from "@/app/api/admin/workspace/route";
import { POST as adminStagePost } from "@/app/api/admin/modules/route";
import { POST as adminEvalsPost } from "@/app/api/admin/modules/evals/route";
import { POST as customerStagePost } from "@/app/api/modules/route";
import { POST as selectPost } from "@/app/api/workspaces/select/route";
import RunsPage from "@/app/admin/runs/page";
import RunDetailPage from "@/app/admin/runs/[id]/page";
import EvalsPage from "@/app/admin/evals/page";
import { adminWorkspacePickerHref, runTraceHref } from "@/components/admin/admin-nav";
import { AiStatusProvider } from "@/components/platform/ai-status";
import { TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import { listRuns } from "@/modules/kernel/observability";
import { harnessSandboxId, runHarness } from "@/modules/harness/harness";
import { needEvalMetrics, pairNeeds } from "@/lib/iegp/engine";
import { loadState, persistState } from "@/lib/iegp/store";
import { replaceContentsOf } from "@/modules/workspaces/contents";
import {
  ADMIN_WORKSPACE_COOKIE,
  adminReturnPath,
  adminWorkspace,
  NotOwnerError,
  selectAdminWorkspace,
  withAdminWorkspace,
} from "@/modules/workspaces/admin-context";
import { verifyWorkspaceCookie, WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { currentWorkspace } from "@/modules/workspaces/session";
import { createWorkspace, withWorkspace } from "@/modules/workspaces/store";

const unique = () => Math.random().toString(36).slice(2, 8);
const SESSION = "synapse_session";

function req(url: string, method = "GET", body?: Record<string, unknown>) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function json(res: Response) {
  return (await res.json()) as Record<string, unknown> & { error?: string; code?: string };
}

/** Under the test stub a demo session is the owner (modules/auth/roles.ts). */
async function signInAsOwner() {
  jar.clear();
  const res = await loginPost(req("/api/auth/login", "POST", { demo: true, actor_name: "Console Owner", email: `owner-${unique()}@synapse.test` }));
  expect(res.status).toBe(200);
}

/** The same kind of session, opted out of the owner bypass: a customer. */
async function signInAsCustomer(email = `customer-${unique()}@customer.example`) {
  await signInAsOwner();
  jar.set(TEST_AS_CUSTOMER_COOKIE, "customer");
  return email;
}

/** A customer's workspace the owner is not a member of. */
async function customerWorkspace(name = `Customer ${unique()}`) {
  return createWorkspace({ name, owner: `lead-${unique()}@customer.example` });
}

const Provider = AiStatusProvider as ComponentType<{ enabled: boolean; children?: ReactNode }>;
function render(page: ReactElement): string {
  const children = (page.props as { children: ReactNode }).children;
  return renderToStaticMarkup(createElement(Provider, { enabled: true }, createElement(Fragment, null, children)));
}

beforeEach(() => jar.clear());

describe("the admin workspace selection is its own signed cookie", () => {
  it("never verifies as the app's workspace cookie, nor the other way round", () => {
    const admin = workspaceCookieValue("wabc", "session-1", { purpose: "admin" });
    const app = workspaceCookieValue("wabc", "session-1");
    expect(verifyWorkspaceCookie(admin, "session-1", Date.now(), "admin")).toBe("wabc");
    expect(verifyWorkspaceCookie(admin, "session-1")).toBeNull();
    expect(verifyWorkspaceCookie(app, "session-1", Date.now(), "admin")).toBeNull();
    expect(verifyWorkspaceCookie(admin, "session-2", Date.now(), "admin")).toBeNull();
  });

  it("returns only to console pages", () => {
    expect(adminReturnPath("/admin/runs")).toBe("/admin/runs");
    expect(adminReturnPath("/admin/pipeline?x=1")).toBe("/admin/pipeline?x=1");
    expect(adminReturnPath("/timeline")).toBe("/admin");
    expect(adminReturnPath("https://evil.example/admin")).toBe("/admin");
    expect(adminReturnPath("/admin/workspace")).toBe("/admin");
    expect(adminWorkspacePickerHref("/admin/runs")).toBe("/admin/workspace?next=%2Fadmin%2Fruns");
    expect(adminWorkspacePickerHref("/admin")).toBe("/admin/workspace");
    expect(runTraceHref("run-1", "w1")).toBe("/admin/runs/run-1?workspace=w1");
  });
});

describe("the owner picks any customer workspace", () => {
  it("lists every workspace with its id, creator, demo flag and member count", async () => {
    const workspace = await customerWorkspace();
    await signInAsOwner();
    const res = await pickerGet();
    expect(res.status).toBe(200);
    const body = (await json(res)) as unknown as {
      workspaces: { id: string; name: string; created_by: string; demo: boolean; member_count: number }[];
    };
    const row = body.workspaces.find((ws) => ws.id === workspace.id);
    expect(row).toMatchObject({ name: workspace.name, created_by: workspace.created_by, demo: false, member_count: 1 });
  });

  it("works in a non-member workspace for admin pages only, then returns to the page", async () => {
    const workspace = await customerWorkspace();
    await signInAsOwner();
    const res = await pickerPost(req("/api/admin/workspace", "POST", { workspace_id: workspace.id, next: "/admin/runs" }));
    const body = await json(res);
    expect(res.status, body.error).toBe(200);
    expect(body.redirect).toBe("/admin/runs");
    expect(jar.has(ADMIN_WORKSPACE_COOKIE)).toBe(true);
    expect(await adminWorkspace()).toMatchObject({ id: workspace.id, source: "picked" });

    // The customer app is untouched: no app selection, and no membership was added.
    expect(jar.has(WORKSPACE_COOKIE)).toBe(false);
    expect(await currentWorkspace()).toBeNull();
    expect((await selectPost(req("/api/workspaces/select", "POST", { workspace_id: workspace.id }))).status).toBe(404);

    expect((await pickerDelete()).status).toBe(200);
    expect(jar.has(ADMIN_WORKSPACE_COOKIE)).toBe(false);
    expect((await adminWorkspace()).id).not.toBe(workspace.id);
  });

  it("refuses an unknown workspace", async () => {
    await signInAsOwner();
    const res = await pickerPost(req("/api/admin/workspace", "POST", { workspace_id: "wnope" }));
    expect(res.status).toBe(404);
  });
});

describe("a customer can never use the admin picker", () => {
  it("is refused by the picker API, 403 owner_only", async () => {
    const workspace = await customerWorkspace();
    await signInAsCustomer();
    expect((await pickerGet()).status).toBe(403);
    const res = await pickerPost(req("/api/admin/workspace", "POST", { workspace_id: workspace.id }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("owner_only");
    expect(jar.has(ADMIN_WORKSPACE_COOKIE)).toBe(false);
    await expect(selectAdminWorkspace(workspace.id)).rejects.toBeInstanceOf(NotOwnerError);
  });

  it("gets nothing from an admin cookie it somehow holds, here or in the app", async () => {
    const workspace = await customerWorkspace();
    await signInAsCustomer();
    const sessionId = jar.get(SESSION)!;
    jar.set(ADMIN_WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, sessionId, { purpose: "admin" }));
    await expect(adminWorkspace()).rejects.toBeInstanceOf(NotOwnerError);
    await expect(withAdminWorkspace(async () => "read", workspace.id)).rejects.toBeInstanceOf(NotOwnerError);
    const run = await adminStagePost(req("/api/admin/modules", "POST", { stage: "S7", workspace_id: workspace.id }));
    expect(run.status).toBe(403);

    // Copied into the app's cookie, the admin value does not verify: the app never opens that workspace.
    jar.set(WORKSPACE_COOKIE, jar.get(ADMIN_WORKSPACE_COOKIE)!);
    expect(await currentWorkspace()).toBeNull();
    const customer = await customerStagePost(req("/api/modules", "POST", { stage: "S7" }));
    expect(customer.status).toBe(409);
  });
});

describe("the pipeline runs in the console's workspace", () => {
  it("runs S7 and S10 right after sign-in, with no app workspace, in the picked one", async () => {
    const workspace = await customerWorkspace();
    await signInAsOwner();
    // Before this fix the page's buttons called /api/modules: 409 "Choose a workspace first".
    expect((await customerStagePost(req("/api/modules", "POST", { stage: "S7" }))).status).toBe(409);

    await selectAdminWorkspace(workspace.id);
    for (const stage of ["S7", "S10"]) {
      const res = await adminStagePost(
        req("/api/admin/modules", "POST", { stage, input: stage === "S10" ? { persist: true } : {}, workspace_id: workspace.id }),
      );
      const body = await json(res);
      expect(res.status, body.error).toBe(200);
      expect(body.workspace).toEqual({ id: workspace.id, name: workspace.name });
      const runs = await withWorkspace(workspace.id, () => listRuns({ limit: 10 }));
      expect(runs.some((run) => run.id === body.run_id)).toBe(true);
    }
  });

  it("uses the console's pick when the page names no workspace, and refuses an unknown one", async () => {
    const workspace = await customerWorkspace();
    await signInAsOwner();
    await selectAdminWorkspace(workspace.id);
    const res = await adminStagePost(req("/api/admin/modules", "POST", { stage: "S7" }));
    expect((await json(res)).workspace).toMatchObject({ id: workspace.id });
    const unknown = await adminStagePost(req("/api/admin/modules", "POST", { stage: "S7", workspace_id: "wnope" }));
    expect(unknown.status).toBe(404);
    expect((await adminEvalsPost(req("/api/admin/modules/evals", "POST", { stage: "S2", workspace_id: "wnope" }))).status).toBe(404);
  });
});

describe("runs and traces follow the console's workspace", () => {
  it("lists the picked workspace's runs, says which workspace it is, and links traces to it", async () => {
    const workspace = await customerWorkspace();
    await signInAsOwner();
    await selectAdminWorkspace(workspace.id);
    const run = await json(await adminStagePost(req("/api/admin/modules", "POST", { stage: "S7" })));
    const html = render(await RunsPage());
    expect(html).toContain(`data-workspace-id="${workspace.id}"`);
    expect(html).toContain(workspace.name);
    expect(html).toContain(`href="/admin/runs/${run.run_id}?workspace=${workspace.id}"`);
  });

  it("opens a harness run from its sandbox via the workspace the link names", async () => {
    await signInAsOwner();
    const result = await runHarness({
      case: "ingestion",
      input: { mode: "sample", demo_id: "medical-kol" },
      actor: { name: "Harness Trace Test", function: "medical_affairs" },
    });
    expect(result.workspace_id).toBe(await harnessSandboxId());
    const runId = result.steps.at(-1)!.run_id;

    const page = await RunDetailPage({
      params: Promise.resolve({ id: runId }),
      searchParams: Promise.resolve({ workspace: result.workspace_id }),
    });
    const html = render(page);
    expect(html).toContain(`data-workspace-id="${result.workspace_id}"`);
    expect(html).toContain("Steps");

    // Without the workspace the console's own one does not hold it: 404, as before.
    const missing = await RunDetailPage({ params: Promise.resolve({ id: runId }), searchParams: Promise.resolve({}) }).then(
      () => null,
      (error: unknown) => error as { digest?: string },
    );
    expect(missing?.digest).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("is owner only, even with a workspace in the link", async () => {
    const sandbox = await harnessSandboxId();
    await signInAsCustomer();
    const refused = await RunDetailPage({
      params: Promise.resolve({ id: "any" }),
      searchParams: Promise.resolve({ workspace: sandbox }),
    }).then(
      () => null,
      (error: unknown) => error as { digest?: string },
    );
    // forbidden(): its 403 digest in the app; outside next.config (Vitest) it throws naming itself.
    expect(refused).not.toBeNull();
    expect(`${refused?.digest ?? ""} ${String(refused)}`).toMatch(/NEXT_HTTP_ERROR_FALLBACK;403|forbidden\(\)/);
  });
});

describe("evals with no gold set", () => {
  it("leaves recall and the composite unscored instead of a perfect 1", () => {
    const extracted = [{ id: "e1", statement: "Need to understand the economic burden of recurrence.", source_id: "s" }];
    const metrics = needEvalMetrics(pairNeeds(extracted, []), [], extracted.length);
    expect(metrics.scored).toBe(false);
    expect(metrics.recall).toBeNull();
    expect(metrics.f1).toBeNull();
    expect(metrics.composite).toBeNull();

    const notMustFind = [{ id: "g1", statement: extracted[0]!.statement, source_id: "s", must_find: false }];
    expect(needEvalMetrics(pairNeeds(extracted, notMustFind), notMustFind, 1).recall).toBeNull();

    const gold = [{ ...notMustFind[0]!, must_find: true }];
    const scored = needEvalMetrics(pairNeeds(extracted, gold), gold, 1);
    expect(scored.recall).toBe(1);
    expect(scored.composite).toBeCloseTo(1);
  });

  it("says on the eval tape that there is no gold set, and never shows 1.000", async () => {
    // The Velmara demo (sources and committed needs), with its gold set taken away.
    const workspace = await customerWorkspace();
    await replaceContentsOf(workspace.id, "demo");
    await withWorkspace(workspace.id, async () => {
      const state = await loadState();
      expect(state.sources.length).toBeGreaterThan(0);
      await persistState({ ...state, gold_needs: [] });
    });
    await signInAsOwner();
    await selectAdminWorkspace(workspace.id);
    const html = render(await EvalsPage());
    expect(html).toContain(`data-workspace-id="${workspace.id}"`);
    expect(html).toContain('data-testid="evals-no-gold"');
    expect(html).toContain("no gold set to score against");
    expect(html).not.toContain("1.000");
  });
});
