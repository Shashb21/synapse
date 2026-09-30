import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** Where the signed-in, workspace-selected browser state for the suite is saved. */
export const STORAGE_STATE = "e2e/.auth/user.json";

/** The demo identity every existing spec runs as (matches ACTOR in synapse.ts). */
export const E2E_USER = { actor_name: "Feature E2E", actor_function: "medical_affairs", email: "feature.e2e@demo.synapse.local" };

/** The workspace the suite uses when the Default workspace belongs to someone else. */
export const E2E_FALLBACK_WORKSPACE = "E2E workspace";

export type WorkspaceSummary = { id: string; name: string; role: "owner" | "member"; created_at: string };

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>, what: string): Promise<T> {
  const text = await response.text();
  expect(response.ok(), `${what} → ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

/**
 * Demo sign-in (development builds only). `role` is honoured only under the
 * test stub, as the Playwright dev server runs.
 */
export async function demoSignIn(
  request: APIRequestContext,
  user: { actor_name: string; actor_function?: string; email?: string; role?: string },
): Promise<{ redirect: string }> {
  return ok(await request.post("/api/auth/login", { data: { demo: true, ...user } }), "demo sign-in");
}

export async function listWorkspaces(request: APIRequestContext): Promise<WorkspaceSummary[]> {
  const body = await ok<{ workspaces: WorkspaceSummary[] }>(await request.get("/api/workspaces"), "list workspaces");
  return body.workspaces;
}

export async function createWorkspace(request: APIRequestContext, name: string): Promise<WorkspaceSummary> {
  const body = await ok<{ workspace: WorkspaceSummary }>(
    // The suite's workspaces keep AI on (new workspaces start with it off); AI-off specs turn it off.
    await request.post("/api/workspaces", { data: { name, ai: true } }),
    `create workspace ${name}`,
  );
  return body.workspace;
}

export async function selectWorkspace(request: APIRequestContext, workspace_id: string): Promise<void> {
  await ok(await request.post("/api/workspaces/select", { data: { workspace_id } }), `select ${workspace_id}`);
}

/**
 * Signs in as the suite's demo user and opens the Default workspace (claimed
 * on first sign-in). When the Default workspace already belongs to someone
 * else — a developer who signed in first — the suite uses its own workspace.
 */
export async function signInForSuite(request: APIRequestContext): Promise<WorkspaceSummary> {
  await demoSignIn(request, E2E_USER);
  const mine = await listWorkspaces(request);
  const workspace =
    mine.find((ws) => ws.id === "default") ??
    mine.find((ws) => ws.name === E2E_FALLBACK_WORKSPACE) ??
    (await createWorkspace(request, E2E_FALLBACK_WORKSPACE));
  await selectWorkspace(request, workspace.id);
  return workspace;
}

/**
 * Signed-in people are never asked who they are; the typed-name field only
 * appears on demo gates without a session. Fills it when it is shown.
 */
export async function fillNameIfAsked(scope: Locator | Page, name: string): Promise<void> {
  await scope.getByRole("textbox").first().waitFor();
  const field = scope.getByRole("textbox", { name: /^name$/i });
  if (await field.count()) await field.first().fill(name);
}

export type FreshWorkspace = {
  /** The workspace id. Read it inside a hook or test, once beforeAll has run. */
  readonly id: string;
};

/**
 * Gives the calling spec file (or describe block) its own new, blank
 * workspace, so nothing another spec left behind leaks in and nothing this
 * spec does leaks out. Call it at the top of a describe (or of the file):
 *
 *   const ws = freshWorkspace({ name: "S5", seed: seedMapped });
 *
 * beforeAll creates the workspace (a new schema; creating also selects it) and
 * runs `seed` in it. beforeEach selects it again for the test's own `request`
 * and for the browser `context`: every test starts from the suite's saved
 * storage state, which points at the shared suite workspace. A retry re-runs
 * beforeAll, so a retried serial block gets a new clean workspace too.
 *
 * Platform-wide settings (the AI master switch, model routes) are not per
 * workspace; specs that change them still restore them in afterAll.
 */
export function freshWorkspace(
  opts: { name?: string; seed?: (request: APIRequestContext) => Promise<unknown> } = {},
): FreshWorkspace {
  let workspace: WorkspaceSummary | null = null;
  test.beforeAll(async ({ request }) => {
    workspace = await createWorkspace(request, `E2E ${opts.name ?? "fresh"} ${Date.now().toString(36)}`);
    await opts.seed?.(request);
  });
  test.beforeEach(async ({ request, context }) => {
    await selectWorkspace(request, workspace!.id);
    await selectWorkspace(context.request, workspace!.id);
  });
  return {
    get id() {
      if (!workspace) throw new Error("freshWorkspace: the workspace is created in beforeAll; read id inside a hook or test.");
      return workspace.id;
    },
  };
}
