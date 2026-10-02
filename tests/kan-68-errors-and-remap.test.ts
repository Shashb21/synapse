import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * KAN-68: a failed AI step tells a customer what happened in plain words (never
 * /admin/control or a provider's raw reply) while the owner keeps the detail; a
 * provider's HTTP failure is a typed, classified error that is not retried; and
 * customers can re-run mapping (S4) through /api/modules.
 */

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import { eq } from "drizzle-orm";
import "@/modules";
import { POST as modulesPost } from "@/app/api/modules/route";
import { stageErrorResponse } from "@/app/api/modules/ai-off";
import { apiErrorResponse, stageFailureBody } from "@/modules/auth/api-guard";
import { TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import type { ActorFunction } from "@/lib/iegp/enums";
import type { Role } from "@/modules/auth/roles";
import { createSession } from "@/modules/auth/session";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { anthropicClaude, openAi } from "@/modules/llm/provider";
import { ProviderError, classifyProviderError, parseProviderErrorBody } from "@/modules/llm/provider-error";
import { completeAll } from "@/modules/kernel/llm";
import { IncompleteAnswerError, customerErrorMessage, tagStageError } from "@/modules/kernel/stage-errors";
import { completionFor, resolveRoute, setRouteConfig } from "@/modules/kernel/routing";
import { RunRecorder } from "@/modules/kernel/observability";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";

const SECRET = "sk-ant-test-SECRETVALUE-123456";
const CREDIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
});
const REQUEST = { system: "s", user: "u", model: "claude-sonnet-5-5", temperature: 0, max_tokens: 100 };

function reply(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

async function providerFailure(status: number, body: string, provider = anthropicClaude): Promise<ProviderError> {
  vi.stubGlobal("fetch", vi.fn(async () => reply(status, body)));
  const error = await provider.complete(REQUEST, { api_key: SECRET }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

/** Text a customer may never see. */
function expectCustomerSafe(text: string) {
  expect(text).not.toContain("/admin/control");
  expect(text).not.toMatch(/switch (?:its|the \S+) route/);
  expect(text).not.toContain('{"type"');
  expect(text).not.toMatch(/HTTP \d{3}/);
  expect(text).not.toContain("credit balance");
  expect(text).not.toContain("API_KEY");
  expect(text).not.toContain(SECRET);
}

let savedS4: typeof t.routingConfig.$inferSelect | undefined;
const savedKey = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  await ensurePlatformSchema();
  [savedS4] = await sharedDb().select().from(t.routingConfig).where(eq(t.routingConfig.stage, "S4"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  jar.values.clear();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

afterAll(async () => {
  await sharedDb().delete(t.routingConfig).where(eq(t.routingConfig.stage, "S4"));
  if (savedS4) await sharedDb().insert(t.routingConfig).values(savedS4);
});

describe("KAN-68 provider errors are typed and classified", () => {
  it("classifies billing, auth, rate limit, unavailable and bad request", () => {
    expect(classifyProviderError(400, "invalid_request_error", "Your credit balance is too low")).toBe("billing");
    expect(classifyProviderError(429, "insufficient_quota", "You exceeded your current quota")).toBe("billing");
    expect(classifyProviderError(402, null, "Insufficient credits")).toBe("billing");
    expect(classifyProviderError(401, "authentication_error", "invalid x-api-key")).toBe("auth");
    expect(classifyProviderError(403, "permission_error", "key revoked")).toBe("auth");
    expect(classifyProviderError(429, "rate_limit_error", "Number of requests exceeded")).toBe("rate_limit");
    expect(classifyProviderError(529, "overloaded_error", "Overloaded")).toBe("unavailable");
    expect(classifyProviderError(503, null, null)).toBe("unavailable");
    expect(classifyProviderError(400, "invalid_request_error", "temperature is not supported")).toBe("bad_request");
  });

  it("reads the provider's error type and message from each body shape", () => {
    expect(parseProviderErrorBody(CREDIT_BODY).error_type).toBe("invalid_request_error");
    expect(parseProviderErrorBody(JSON.stringify({ error: { message: "m", type: "insufficient_quota" } }))).toEqual({
      error_type: "insufficient_quota",
      message: "m",
    });
    expect(parseProviderErrorBody(JSON.stringify({ error: "No credits", code: "billing" }))).toEqual({
      error_type: "billing",
      message: "No credits",
    });
    expect(parseProviderErrorBody("<html>Bad gateway</html>").message).toBe("<html>Bad gateway</html>");
  });

  it("an Anthropic credit-balance 400 is a billing error with an admin remedy and no raw JSON or key", async () => {
    const error = await providerFailure(400, CREDIT_BODY);
    expect(error.kind).toBe("billing");
    expect(error.status).toBe(400);
    expect(error.info).toMatchObject({ provider_id: "anthropic-claude", error_type: "invalid_request_error" });
    expect(error.message).toBe(
      "Anthropic rejected the request: the account's credit balance is too low. Add credit at console.anthropic.com → Plans & Billing.",
    );
    expect(error.message).not.toContain("{");
    expect(error.message).not.toContain(SECRET);
  });

  it("a rejected key names the env var, never the key", async () => {
    const error = await providerFailure(
      401,
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${SECRET}` } }),
    );
    expect(error.kind).toBe("auth");
    expect(error.message).toContain("the API key in ANTHROPIC_API_KEY was rejected");
    expect(JSON.stringify(error.info)).not.toContain(SECRET);
    expect(error.message).not.toContain(SECRET);
  });

  it("OpenAI's insufficient_quota 429 is billing; a plain 429 is a rate limit", async () => {
    const quota = await providerFailure(
      429,
      JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } }),
      openAi,
    );
    expect(quota.kind).toBe("billing");
    expect(quota.message).toContain("platform.openai.com");
    const busy = await providerFailure(429, JSON.stringify({ error: { message: "Slow down", type: "rate_limit_error" } }));
    expect(busy.kind).toBe("rate_limit");
  });
});

describe("KAN-68 billing errors are not retried", () => {
  it("completionFor asks once and throws the billing error, not an invalid-JSON retry", async () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    await setRouteConfig({ stage: "S4", provider_id: "anthropic-claude", model: "claude-sonnet-5-5", fallbacks: [], actor_name: "KAN-68" });
    const route = await resolveRoute("S4");
    const fetchSpy = vi.fn(async () => reply(400, CREDIT_BODY));
    vi.stubGlobal("fetch", fetchSpy);
    const recorder = new RunRecorder({
      workspace_id: "test",
      stage: "S4",
      module_id: "kan68.test",
      module_version: "1.0.0",
      actor: { name: "KAN-68", function: "medical_affairs" },
      input: {},
    });
    const error = await completionFor(route, recorder)({ system: "s", user: "{}", purpose: "mapping-table-proposer" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("billing");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("completeAll stops at the first provider failure instead of asking again", async () => {
    const ask = vi.fn(async () => {
      throw new ProviderError({
        provider_id: "anthropic-claude",
        provider_name: "Anthropic",
        key_env: "ANTHROPIC_API_KEY",
        status: 400,
        error_type: "invalid_request_error",
        provider_message: "Your credit balance is too low",
      });
    });
    await expect(completeAll({ ids: ["G1"], what: "mapping", ask })).rejects.toBeInstanceOf(ProviderError);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("KAN-68 customers get customer wording; the owner keeps the detail", () => {
  const S4_REMEDY = "run S4 again or switch the S4 route in /admin/control.";
  const incomplete = () => {
    const error = new IncompleteAnswerError(
      `The model did not return a complete mapping for G1 after 3 attempts. Nothing was saved; ${S4_REMEDY}`,
      "mapping",
    );
    tagStageError(error, "S4");
    return error;
  };
  const billing = () =>
    new ProviderError({
      provider_id: "anthropic-claude",
      provider_name: "Anthropic",
      key_env: "ANTHROPIC_API_KEY",
      status: 400,
      error_type: "invalid_request_error",
      provider_message: "Your credit balance is too low",
    });

  it("an incomplete S4 answer reads as a mapping failure to a customer", () => {
    const body = stageFailureBody(incomplete(), false);
    expect(body.error).toBe(
      "Mapping couldn't finish because the AI didn't return a complete answer. Nothing was saved. Try again; if it keeps failing, contact your Synapse administrator.",
    );
    expect(body.stage).toBe("S4");
    expectCustomerSafe(body.error);
  });

  it("the owner sees the technical remedy", () => {
    expect(stageFailureBody(incomplete(), true).error).toContain(S4_REMEDY);
    expect(stageFailureBody(billing(), true).error).toContain("console.anthropic.com");
  });

  it("a billing failure tells a customer the AI account needs attention", () => {
    const body = stageFailureBody(billing(), false);
    expect(body.error).toBe(
      "The AI provider isn't available right now (the platform's AI account needs attention). Your work is saved; try again later or contact your Synapse administrator.",
    );
    expect(body).toMatchObject({ code: "provider_error", provider_error: "billing" });
    expectCustomerSafe(body.error);
  });

  it("every stage remedy and kernel default is reworded for a customer", () => {
    const owner = [
      "The model did not return a complete review for T1 after 3 attempts. Nothing was saved; run the stage again or switch its route in /admin/control.",
      "Anthropic · Claude did not return valid JSON for s9-proposer after 3 attempts (Unexpected token). Nothing was saved; try again.",
      "Claude's reply was cut off at its max_tokens limit before it finished. Raise Max tokens for this stage in AI & routing.",
      `Parsing failed: f1: ${billing().message}`,
      `api.anthropic.com HTTP 400: ${CREDIT_BODY}`,
    ];
    for (const message of owner) {
      const text = customerErrorMessage(new Error(message));
      expect(text, message).not.toBeNull();
      expectCustomerSafe(text!);
    }
    // A plain validation error is already fine to show and is left alone.
    expect(customerErrorMessage(new Error("A title is required."))).toBeNull();
  });

  it("a customer route's response never carries /admin/control or provider JSON", async () => {
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    for (const error of [incomplete(), billing(), new Error(`api.anthropic.com HTTP 400: ${CREDIT_BODY}`)]) {
      for (const response of [await apiErrorResponse(error), await stageErrorResponse(error, "Stage run failed")]) {
        const text = await response.text();
        expectCustomerSafe(text);
        expect(response.status).toBe(error instanceof ProviderError ? 502 : 400);
      }
    }
  });

  it("the owner (test-stub session) gets the detail from the same route helpers", async () => {
    const json = (await (await apiErrorResponse(incomplete())).json()) as { error: string; stage?: string };
    expect(json.error).toContain("/admin/control");
    expect(json.stage).toBe("S4");
  });

  it("other errors keep their 400 and message", async () => {
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    const response = await apiErrorResponse(new Error("Bad input"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Bad input" });
  });
});

describe("KAN-68 customers can re-run mapping through /api/modules", () => {
  const unique = Math.random().toString(36).slice(2, 8);
  const OWNER_EMAIL = `kan68-owner-${unique}@example.com`;
  type Person = { name: string; fn: ActorFunction; role: Role; email: string };
  const LEAD: Person = { name: "Lead Lena", fn: "medical_affairs", role: "medical_affairs", email: OWNER_EMAIL };
  const CONTRIBUTOR: Person = { name: "Contributor Carl", fn: "heor", role: "contributor", email: `kan68-c-${unique}@example.com` };
  const VIEWER: Person = { name: "Viewer Vera", fn: "medical_affairs", role: "viewer", email: `kan68-v-${unique}@example.com` };
  let workspace: Workspace;

  async function signIn(person: Person) {
    jar.values.clear();
    const session = await createSession({
      provider_id: "demo",
      subject: `demo:${person.name}`,
      email: person.email,
      actor_name: person.name,
      actor_function: person.fn,
      role: person.role,
    });
    jar.values.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
  }

  function rerun() {
    return withWorkspace(workspace.id, () =>
      modulesPost(
        new Request("http://localhost/api/modules", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage: "S4", input: {} }),
        }),
      ),
    );
  }

  beforeAll(async () => {
    vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
    workspace = await createWorkspace({ name: `KAN-68 ${unique}`, owner: OWNER_EMAIL, ai_enabled: true });
    for (const person of [CONTRIBUTOR, VIEWER]) {
      await inviteMember({ workspace_id: workspace.id, email: person.email, by: OWNER_EMAIL });
    }
  }, 60_000);

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a signed-out caller", async () => {
    jar.values.clear();
    const response = await rerun();
    expect(response.status).toBe(401);
  });

  it("refuses a viewer", async () => {
    await signIn(VIEWER);
    const response = await rerun();
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code?: string }).code).toBe("forbidden");
  });

  it("runs for Medical Affairs and for a contributor", async () => {
    for (const person of [LEAD, CONTRIBUTOR]) {
      await signIn(person);
      const response = await rerun();
      const body = (await response.json()) as { ok?: boolean; stage?: string; error?: string };
      expect({ name: person.name, status: response.status, error: body.error }).toEqual({
        name: person.name,
        status: 200,
        error: undefined,
      });
      expect(body.stage).toBe("S4");
    }
  }, 60_000);
});
