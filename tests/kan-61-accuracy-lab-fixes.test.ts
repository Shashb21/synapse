import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A request cookie jar the route handlers read and signInDemo/signOut write. */
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import type { ReactElement } from "react";
import { eq, sql } from "drizzle-orm";
import { registerAccuracyStack } from "@/accuracy";
import { POST as claimsPost } from "@/app/api/accuracy/claims/route";
import { POST as validatePost } from "@/app/api/accuracy/claims/validate/route";
import { POST as priorityPost } from "@/app/api/accuracy/claims/priority/route";
import { POST as mergePost } from "@/app/api/accuracy/claims/merge/route";
import { POST as coveragePost } from "@/app/api/accuracy/coverage/route";
import { POST as ideatePost } from "@/app/api/accuracy/ideate/route";
import { POST as reviewPost } from "@/app/api/accuracy/review/route";
import { POST as saveFinalPost } from "@/app/api/accuracy/gantt/save-final/route";
import { PATCH as workshopPatch, POST as workshopPost } from "@/app/api/accuracy/workshop/route";
import { POST as workshopActionsPost } from "@/app/api/accuracy/workshop/actions/route";
import { POST as workshopTagsPost } from "@/app/api/accuracy/workshop/tags/route";
import { POST as hygienePost } from "@/app/api/accuracy/hygiene/route";
import { POST as routingPost } from "@/app/api/accuracy/routing/route";
import { POST as workspacesPost } from "@/app/api/accuracy/workspaces/route";
import { POST as harnessPost } from "@/app/api/admin/harness/route";
import AccuracyAuditPage from "@/app/admin/accuracy/audit/page";
import AccuracyCoveragePage from "@/app/admin/accuracy/coverage/page";
import AccuracyLedgerPage from "@/app/admin/accuracy/ledger/page";
import AccuracyPlanPage from "@/app/admin/accuracy/plan/page";
import AccuracyReviewPage from "@/app/admin/accuracy/review/page";
import AccuracyRunsPage from "@/app/admin/accuracy/runs/page";
import AccuracySourcesPage from "@/app/admin/accuracy/sources/page";
import AccuracyTimelinePage from "@/app/admin/accuracy/timeline/page";
import AccuracyWorkshopPage from "@/app/admin/accuracy/workshop/page";
import AiHarnessPage from "@/app/admin/harness/page";
import { AccuracyAppShell } from "@/components/accuracy-app-shell";
import { LedgerNewClaimForm } from "@/components/accuracy/ledger-new-claim-form";
import { UnknownWorkspaceNotice } from "@/components/accuracy/unknown-workspace";
import { AiHarness } from "@/components/admin/ai-harness";
import { NO_MODEL_ROUTE, runRouteLabel } from "@/accuracy/domain/run-route";
import { accuracyRouteConfig, setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { claimMetadata, getClaim, insertClaim } from "@/accuracy/store/claim-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import {
  createOrganization,
  createWorkspace,
  DuplicateWorkspaceSlugError,
  getWorkspaceBySlug,
  listWorkspaces,
} from "@/accuracy/store/tenant";
import { signInDemo } from "@/modules/auth/session";
import { HarnessAiOffError, harnessNoModelMessage, runHarness } from "@/modules/harness/harness";
import { setAiEnabled } from "@/modules/kernel/ai-switch";

registerAccuracyStack();

const run = Math.random().toString(36).slice(2, 8);
const ADMIN = "KAN-61 test";

function request(url: string, method: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function labWorkspace(label: string, plan_label?: "IEP" | "IEGP") {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-kan61-${label}-${run}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `KAN-61 ${label} ${run}`,
    slug: `kan61-${label}-${run}-${Math.random().toString(36).slice(2, 6)}`,
    plan_label,
  });
  return { org_id, workspace_id, name: `KAN-61 ${label} ${run}` };
}

/** Every element in a server-rendered tree, without rendering client components. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if ("props" in node && "type" in node) {
    const element = node as ReactElement<Record<string, unknown>>;
    out.push(element);
    for (const value of Object.values(element.props ?? {})) elements(value, out);
  }
  return out;
}

/** The text a server-rendered tree prints directly (client components excluded). */
function texts(tree: ReactElement[]): string {
  const out: string[] = [];
  for (const el of tree) {
    const children = (el.props as { children?: unknown }).children;
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === "string" || typeof child === "number") out.push(String(child));
    }
  }
  return out.join("");
}

/** Who the claim's last human edit is credited to. */
function lastEditBy(meta: ReturnType<typeof claimMetadata>): unknown {
  const edit = meta.last_human_edit as { by?: unknown } | undefined;
  return edit?.by;
}

beforeEach(() => {
  jar.values.clear();
});

afterAll(async () => {
  await setAiEnabled({ enabled: true, actor_name: ADMIN, rationale: "restore after KAN-61 tests" });
});

describe("lab workspace lists show every workspace (KAN-61 item 1)", () => {
  it("lists past 50 and a page opened by URL shows the name and plan label, not the ID", async () => {
    const oldest = await labWorkspace("oldest", "IEP");
    for (let index = 0; index < 51; index += 1) await labWorkspace(`bulk-${index}`);

    const all = await listWorkspaces();
    expect(all.length).toBeGreaterThan(51);
    expect(all.map((row) => row.id)).toContain(oldest.workspace_id);

    const plan = elements(await AccuracyPlanPage({ searchParams: Promise.resolve({ workspace_id: oldest.workspace_id }) }));
    const shell = plan.find((el) => el.type === AccuracyAppShell);
    expect((shell?.props as { planLabel?: unknown }).planLabel).toBe("IEP");
    expect(texts(plan)).toContain(`Workspace · ${oldest.name} · IEP`);
    expect(texts(plan)).not.toContain(oldest.workspace_id);
  }, 120_000);
});

describe("unknown workspace (KAN-61 item 2)", () => {
  const missing = `ws-nope-${run}`;

  it("POST /api/accuracy/claims returns 404 and writes no orphan row", async () => {
    const res = await call(
      await claimsPost(
        request("/api/accuracy/claims", "POST", {
          workspace_id: missing,
          claim_type: "gap",
          statement: "Orphan gap",
        }),
      ),
    );
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("Unknown workspace");
    const rows = await accuracyDb()
      .select({ id: t.accuracyClaims.id })
      .from(t.accuracyClaims)
      .where(eq(t.accuracyClaims.workspace_id, missing));
    expect(rows).toHaveLength(0);
  });

  it("every accuracy write route that takes workspace_id answers 404", async () => {
    const writes: [string, (req: Request) => Promise<Response>, string, Record<string, unknown>][] = [
      ["manual claim", claimsPost, "POST", { claim_type: "tactic", statement: "Orphan", rationale: "typed by hand" }],
      ["validate", validatePost, "POST", { claim_ids: ["c1"], action: "validate", rationale: "ok" }],
      ["priority", priorityPost, "POST", { claim_id: "c1", priority: "high", rationale: "because" }],
      ["merge", mergePost, "POST", { action: "dismiss", claim_id: "c1", rationale: "not the same" }],
      ["coverage", coveragePost, "POST", { gap_id: "g", tactic_id: "t", overall: "covers", rationale: "covered" }],
      ["ideate", ideatePost, "POST", { gap_id: "g", title: "A hand-written tactic", rationale: "manual" }],
      ["review", reviewPost, "POST", { block_id: "b", action: "dismiss", rationale: "noise" }],
      ["save final", saveFinalPost, "POST", { note: "final" }],
      ["workshop save", workshopPost, "POST", {}],
      ["workshop scene", workshopPatch, "PATCH", { snapshot_id: "s", scene: "gaps" }],
      ["workshop action", workshopActionsPost, "POST", { snapshot_id: "s", kind: "adapt", gap_id: "g", rationale: "r" }],
      ["workshop tag", workshopTagsPost, "POST", { snapshot_id: "s", action: "add_tag", label: "Tag" }],
      ["archive", hygienePost, "POST", { action: "archive_workspace" }],
    ];
    for (const [label, handler, method, body] of writes) {
      const res = await call(await handler(request("/api/accuracy/x", method, { workspace_id: missing, ...body })));
      expect({ label, status: res.status }).toEqual({ label, status: 404 });
      expect(String(res.json.error)).toMatch(/^Unknown workspace/);
    }
  });

  it("lab pages opened with an unknown workspace_id say so and offer no add form", async () => {
    const searchParams = Promise.resolve({ workspace_id: missing });
    const pages = [
      AccuracyLedgerPage,
      AccuracyPlanPage,
      AccuracyCoveragePage,
      AccuracySourcesPage,
      AccuracyAuditPage,
      AccuracyRunsPage,
      AccuracyTimelinePage,
      AccuracyReviewPage,
      AccuracyWorkshopPage,
    ] as ((props: { searchParams: typeof searchParams }) => Promise<unknown>)[];
    for (const Page of pages) {
      const tree = elements(await Page({ searchParams }));
      expect({ page: Page.name, notice: tree.some((el) => el.type === UnknownWorkspaceNotice) }).toEqual({
        page: Page.name,
        notice: true,
      });
      expect(tree.some((el) => el.type === LedgerNewClaimForm)).toBe(false);
    }
  });
});

describe("lab workspace slugs are unique (KAN-61 item 3)", () => {
  it("rejects a duplicate slug with 409 and a clear message, and slug lookups stay unambiguous", async () => {
    const slug = `kan61-dup-${run}`;
    const first = await call(await workspacesPost(request("/api/accuracy/workspaces", "POST", { name: "Dup one", slug })));
    expect(first.status).toBe(200);
    const orgsBefore = await accuracyDb().execute(sql`select count(*)::int as n from accuracy_organizations`);

    const second = await call(await workspacesPost(request("/api/accuracy/workspaces", "POST", { name: "Dup two", slug })));
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/already used/);
    // Refused before the org is created: no orphan organization.
    const orgsAfter = await accuracyDb().execute(sql`select count(*)::int as n from accuracy_organizations`);
    expect(orgsAfter).toEqual(orgsBefore);

    await expect(
      createWorkspace({ org_id: String(first.json.org_id), name: "Dup three", slug }),
    ).rejects.toBeInstanceOf(DuplicateWorkspaceSlugError);
    expect((await getWorkspaceBySlug(slug))?.id).toBe(first.json.workspace_id);
  });
});

describe("the audit trail credits the signed-in owner (KAN-61 item 4)", () => {
  it("ignores a body actor_name and records the owner's name", async () => {
    const ownerName = `KAN-61 Owner ${run}`;
    await signInDemo({ actor_name: ownerName, actor_function: "medical_affairs" });
    const { workspace_id } = await labWorkspace("actor");

    const created = await call(
      await claimsPost(
        request("/api/accuracy/claims", "POST", {
          workspace_id,
          claim_type: "gap",
          statement: "No persistence data beyond 12 months",
          rationale: "From the KOL call",
          actor_name: "Impostor",
        }),
      ),
    );
    expect(created.status).toBe(200);
    const claimId = (created.json.claim as { id: string }).id;
    expect(lastEditBy(claimMetadata((await getClaim(workspace_id, claimId))!))).toBe(ownerName);

    const validated = await call(
      await validatePost(
        request("/api/accuracy/claims/validate", "POST", {
          workspace_id,
          claim_ids: [claimId],
          action: "validate",
          rationale: "Checked against the source",
          actor_name: "Accuracy reviewer",
        }),
      ),
    );
    expect(validated.status).toBe(200);
    const meta = claimMetadata((await getClaim(workspace_id, claimId))!);
    expect(meta.validation?.by).toBe(ownerName);

    const prioritized = await call(
      await priorityPost(
        request("/api/accuracy/claims/priority", "POST", {
          workspace_id,
          claim_id: claimId,
          priority: "high",
          rationale: "Payers ask for it",
          actor_name: "Accuracy planner",
        }),
      ),
    );
    expect(prioritized.status).toBe(200);
    expect(lastEditBy(claimMetadata((await getClaim(workspace_id, claimId))!))).toBe(ownerName);
  });
});

describe("malformed JSON is a 400, never a 500 (KAN-61 item 5)", () => {
  it("answers 400 Invalid JSON on the accuracy and admin routes", async () => {
    const handlers: [string, (req: Request) => Promise<Response>][] = [
      ["/api/accuracy/routing", routingPost],
      ["/api/accuracy/claims", claimsPost],
      ["/api/accuracy/workspaces", workspacesPost],
      ["/api/accuracy/hygiene", hygienePost],
      ["/api/admin/harness", harnessPost],
    ];
    for (const [url, handler] of handlers) {
      const res = await call(await handler(request(url, "POST", "{not json")));
      expect({ url, status: res.status, error: res.json.error }).toEqual({ url, status: 400, error: "Invalid JSON" });
    }
  });
});

describe("validator errors read as one short line (KAN-61 item 6)", () => {
  it("returns the first issue's path and message, not raw zod JSON", async () => {
    const bad = await call(
      await workspacesPost(request("/api/accuracy/workspaces", "POST", { name: "Bad slug", slug: "Bad Slug!" })),
    );
    expect(bad.status).toBe(400);
    const error = String(bad.json.error);
    expect(error).toMatch(/^slug: /);
    expect(error).not.toMatch(/[[{]/);
    expect(error.length).toBeLessThan(161);

    const coverage = await call(
      await coveragePost(request("/api/accuracy/coverage", "POST", { workspace_id: "x", gap_id: "g" })),
    );
    expect(coverage.status).toBe(400);
    expect(String(coverage.json.error)).toMatch(/^tactic_id: /);
  });
});

describe("runs show the actual route (KAN-61 item 7)", () => {
  it("labels mechanical runs No model and model runs by their route", () => {
    const grok = { provider_id: "xai", provider_label: "xAI · Grok", model: "grok-4", degraded: false };
    expect(runRouteLabel(grok, false)).toBe(NO_MODEL_ROUTE);
    expect(runRouteLabel(null, true)).toBe(NO_MODEL_ROUTE);
    expect(runRouteLabel({ provider_id: "none", provider_label: "None", model: "none" }, true)).toBe(NO_MODEL_ROUTE);
    expect(runRouteLabel(grok, true)).toBe("xAI · Grok · grok-4");
    expect(runRouteLabel({ ...grok, degraded: true }, true)).toBe("xAI · Grok · grok-4 (degraded)");
  });

  it("a validation run on the Runs page reads No model", async () => {
    const { workspace_id } = await labWorkspace("runs");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "A gap to validate" });
    const res = await validatePost(
      request("/api/accuracy/claims/validate", "POST", {
        workspace_id,
        claim_ids: [gap.id],
        action: "validate",
        rationale: "Fine",
      }),
    );
    expect(res.status).toBe(200);
    const tree = elements(await AccuracyRunsPage({ searchParams: Promise.resolve({ workspace_id }) }));
    const routes = tree.filter((el) => (el.props as Record<string, unknown>)["data-testid"] === "run-route");
    expect(routes.length).toBeGreaterThan(0);
    for (const el of routes) expect((el.props as { children?: unknown }).children).toBe(NO_MODEL_ROUTE);
  });
});

describe("the AI harness follows the platform AI switch (KAN-61 item 8)", () => {
  it("refuses with 409 ai_off and the page says AI is off", async () => {
    await setAiEnabled({ enabled: false, actor_name: ADMIN, rationale: "KAN-61 harness AI-off check" });
    try {
      await expect(
        runHarness({ case: "ingestion", input: { mode: "sample" }, actor: { name: ADMIN, function: "medical_affairs" } }),
      ).rejects.toBeInstanceOf(HarnessAiOffError);

      const res = await call(await harnessPost(request("/api/admin/harness", "POST", { case: "ingestion", mode: "sample" })));
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("ai_off");
      expect(String(res.json.error)).toMatch(/AI is turned off for the platform/);

      const page = elements(await AiHarnessPage());
      expect(page.some((el) => (el.props as Record<string, unknown>)["data-testid"] === "harness-ai-off")).toBe(true);
      expect(page.some((el) => el.type === AiHarness)).toBe(false);
    } finally {
      await setAiEnabled({ enabled: true, actor_name: ADMIN, rationale: "KAN-61 harness AI back on" });
    }
    const page = elements(await AiHarnessPage());
    expect(page.some((el) => el.type === AiHarness)).toBe(true);
  });

  it("says where to set the API key once, not twice", () => {
    const routed = harnessNoModelMessage(
      "S1",
      "xAI · Grok: no API key (set XAI_API_KEY in the server environment). Set the provider's API key in the server environment (.env.local or your host's settings), then retry.",
    );
    expect(routed).not.toMatch(/\.\./);
    expect(routed.match(/Set the provider's API key/g)).toHaveLength(1);
    expect(routed).toMatch(/then retry\.$/);
    expect(harnessNoModelMessage("S2", "xAI · Grok: unknown provider")).toBe(
      "No live model is available for S2: xAI · Grok: unknown provider. Set the provider's API key in the server environment.",
    );
  });
});

describe("accuracy set_route validates its parameters (KAN-61)", () => {
  const base = { action: "set_route", call_kind: "need_extract", agent_role: "proposer", provider_id: "xai-grok", model: "" };

  it("rejects out-of-range numbers and unknown fallbacks; blank keeps the current value", async () => {
    const original = await accuracyRouteConfig("need_extract", "proposer");
    try {
      const saved = await call(
        await routingPost(request("/api/accuracy/routing", "POST", { ...base, temperature: 0.3, max_tokens: 4096, fallbacks: "" })),
      );
      expect(saved.status).toBe(200);
      const before = await accuracyRouteConfig("need_extract", "proposer");
      expect(before.params).toEqual({ temperature: 0.3, max_tokens: 4096 });

      for (const [body, message] of [
        [{ temperature: 5 }, /Temperature must be a number from 0 to 2/],
        [{ temperature: "warm" }, /Temperature/],
        [{ max_tokens: 0 }, /Max tokens must be a whole number from 1 to 200000/],
        [{ max_tokens: 1.5 }, /Max tokens/],
        [{ max_tokens: 300_000 }, /Max tokens/],
        [{ fallbacks: "anthropic-claude, nope-provider" }, /Unknown fallback provider: nope-provider/],
      ] as const) {
        const res = await call(await routingPost(request("/api/accuracy/routing", "POST", { ...base, ...body })));
        expect(res.status).toBe(400);
        expect(String(res.json.error)).toMatch(message);
      }
      expect(await accuracyRouteConfig("need_extract", "proposer")).toMatchObject({ params: before.params });

      const blank = await call(
        await routingPost(request("/api/accuracy/routing", "POST", { ...base, temperature: "", max_tokens: "", fallbacks: "" })),
      );
      expect(blank.status).toBe(200);
      const after = await accuracyRouteConfig("need_extract", "proposer");
      expect(after.params).toEqual({ temperature: 0.3, max_tokens: 4096 });
      expect(after.fallbacks).toEqual(before.fallbacks);
    } finally {
      await setAccuracyRouteConfig({
        call_kind: "need_extract",
        agent_role: "proposer",
        provider_id: original.provider_id,
        model: original.model,
        temperature: original.params.temperature,
        max_tokens: original.params.max_tokens,
        fallbacks: original.fallbacks,
        actor_name: ADMIN,
      });
    }
  });
});
