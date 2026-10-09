import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory cookie jar standing in for the browser. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { sharedDb, sslFor } from "@/lib/iegp/db";
import { ensurePlatformSchema } from "@/modules/kernel/db";
import { safeNext } from "@/modules/auth/redirect";
import { createSession, currentSession, SESSION_COOKIE, sessionKey, signOut } from "@/modules/auth/session";
import { ApiGuardError, apiErrorResponse, readJsonBody } from "@/modules/auth/api-guard";
import { BodyTooLargeError, DEFAULT_JSON_BODY_MAX_BYTES, jsonBodyMaxBytes, readBodyText } from "@/lib/http/body-limit";
import { DEFAULT_PROVIDER_TIMEOUT_MS, fetchProvider, ProviderError, providerTimeoutMs } from "@/modules/llm/provider-error";
import { parseLimitError, parseLimits, structureWithLlm } from "@/lib/ingest/llm-structure";
import {
  assertCanCreateWorkspace,
  createWorkspace,
  DEFAULT_MAX_WORKSPACES_PER_USER,
  workspaceCreationLimit,
  WorkspaceLimitError,
} from "@/modules/workspaces/store";
import { POST as workspacesPost } from "@/app/api/workspaces/route";

const unique = () => Math.random().toString(36).slice(2, 10);

beforeEach(() => jar.clear());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("KAN-20: safeNext only allows same-origin relative paths", () => {
  it("keeps ordinary paths, with their query and hash", () => {
    expect(safeNext("/timeline")).toBe("/timeline");
    expect(safeNext("/gaps/G-1?tab=tactics#t2")).toBe("/gaps/G-1?tab=tactics#t2");
    expect(safeNext("/search?q=a%20b")).toBe("/search?q=a%20b");
  });

  const attacks = [
    "//evil.example",
    "///evil.example",
    "//evil.example/%2F..",
    "/\\evil.example",
    "\\\\evil.example",
    "/\\/evil.example",
    "\\/evil.example",
    "https://evil.example",
    "http:evil.example",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.example",
    "/%2F%2Fevil.example",
    "%2F%2Fevil.example",
    "/%2fevil.example",
    "/%5Cevil.example",
    "/%5cevil.example",
    "/%252F%252Fevil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/%09/evil.example",
    "/%0d%0a/evil.example",
    " //evil.example",
    "/%00",
    "/login",
    "/LOGIN",
    "/%6Cogin",
    "/workspaces?new=1",
    "/api/auth/logout",
    "",
  ];
  it.each(attacks)("refuses %j", (attack) => {
    expect(safeNext(attack)).toBe("/");
    expect(safeNext(attack, "/admin")).toBe("/admin");
  });

  it("returns the fallback for null and undefined", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined, "/x")).toBe("/x");
  });
});

describe("KAN-20: session ids are stored hashed", () => {
  it("stores sha256 of the cookie token, never the token, and looks it up by hash", async () => {
    const subject = `kan20-${unique()}`;
    const session = await createSession({
      provider_id: "demo",
      subject,
      actor_name: "Hash Test",
      actor_function: "medical_affairs",
      role: "medical_affairs",
    });
    const token = jar.get(SESSION_COOKIE)!;
    expect(token).toBe(session.id);
    const rows = (await sharedDb().execute(
      sql`select id from auth_sessions where subject = ${subject}`,
    )) as unknown as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(sessionKey(token));
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.id).not.toContain(token);

    expect((await currentSession())?.subject).toBe(subject);
    // A stolen database row is not a cookie: presenting the stored id signs no one in.
    jar.set(SESSION_COOKIE, rows[0]!.id);
    expect(await currentSession()).toBeNull();

    jar.set(SESSION_COOKIE, token);
    await signOut();
    const left = (await sharedDb().execute(
      sql`select count(*)::int as n from auth_sessions where subject = ${subject}`,
    )) as unknown as { n: number }[];
    expect(left[0]!.n).toBe(0);
  });

  it("ends sessions stored before hashing (those people sign in again)", async () => {
    await ensurePlatformSchema();
    const subject = `kan20-legacy-${unique()}`;
    const legacyToken = "legacyRawToken0123456789abcdefgh";
    const at = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await sharedDb().execute(sql`
      insert into auth_sessions (id, provider_id, subject, email, actor_name, actor_function, role, created_at, expires_at)
      values (${legacyToken}, 'demo', ${subject}, null, 'Legacy', 'medical_affairs', 'medical_affairs', ${at}, ${later})`);
    // The raw-token row cannot sign anyone in: lookups go by hash.
    jar.set(SESSION_COOKIE, legacyToken);
    expect(await currentSession()).toBeNull();
    // The platform migration removes it on the next start.
    (globalThis as { synapsePlatformSchema?: Promise<void> }).synapsePlatformSchema = undefined;
    await ensurePlatformSchema();
    const left = (await sharedDb().execute(
      sql`select count(*)::int as n from auth_sessions where subject = ${subject}`,
    )) as unknown as { n: number }[];
    expect(left[0]!.n).toBe(0);
  });

  it("erases tokens left in the retired oauth_connections table", async () => {
    await ensurePlatformSchema();
    const provider_id = `kan20-${unique()}`;
    await sharedDb().execute(sql`
      insert into oauth_connections (provider_id, status, scopes, access_token, refresh_token)
      values (${provider_id}, 'connected', '[]'::jsonb, 'old-access', 'old-refresh')`);
    (globalThis as { synapsePlatformSchema?: Promise<void> }).synapsePlatformSchema = undefined;
    await ensurePlatformSchema();
    const rows = (await sharedDb().execute(
      sql`select access_token, refresh_token from oauth_connections where provider_id = ${provider_id}`,
    )) as unknown as { access_token: string | null; refresh_token: string | null }[];
    expect(rows[0]).toEqual({ access_token: null, refresh_token: null });
    await sharedDb().execute(sql`delete from oauth_connections where provider_id = ${provider_id}`);
  });
});

describe("KAN-20: database TLS follows sslmode", () => {
  const verified = { rejectUnauthorized: true };
  it("uses plain TCP for local development and sslmode=disable", () => {
    expect(sslFor("postgres://u:p@127.0.0.1:5432/db", {})).toBe(false);
    expect(sslFor("postgres://u:p@localhost/db", {})).toBe(false);
    expect(sslFor("postgres://u:p@db.example.com/db?sslmode=disable", {})).toBe(false);
  });
  it("verifies the certificate for require, verify-full, and remote hosts with no sslmode", () => {
    expect(sslFor("postgres://u:p@db.example.com/db?sslmode=require", {})).toEqual(verified);
    expect(sslFor("postgres://u:p@db.example.com/db?sslmode=verify-full", {})).toEqual(verified);
    expect(sslFor("postgres://u:p@db.example.com/db", {})).toEqual(verified);
    expect(sslFor("postgresql://u:p@localhost/db?sslmode=require", {})).toEqual(verified);
  });
  it("verify-ca checks the chain but not the host name", () => {
    const option = sslFor("postgres://u:p@10.0.0.5/db?sslmode=verify-ca", {}) as { checkServerIdentity?: () => unknown };
    expect(option).toMatchObject(verified);
    expect(option.checkServerIdentity?.()).toBeUndefined();
  });
  it("takes a private CA, keeps libpq's opportunistic modes, and has an explicit opt-out", () => {
    expect(sslFor("postgres://u:p@db.example.com/db?sslmode=require", { DATABASE_CA_CERT: "PEM" })).toEqual({
      ...verified,
      ca: "PEM",
    });
    expect(sslFor("postgres://u:p@db.example.com/db?sslmode=prefer", {})).toBe("prefer");
    expect(sslFor("postgres://u:p@db.example.com/db?sslmode=require", { DATABASE_SSL_VERIFY: "false" })).toBe("require");
  });
});

function jsonRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/iegp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("KAN-20: request body size limits", () => {
  it("defaults to 5 MB and can be configured", () => {
    expect(jsonBodyMaxBytes({})).toBe(DEFAULT_JSON_BODY_MAX_BYTES);
    expect(jsonBodyMaxBytes({ SYNAPSE_JSON_BODY_MAX_BYTES: "1024" })).toBe(1024);
    expect(jsonBodyMaxBytes({ SYNAPSE_JSON_BODY_MAX_BYTES: "nonsense" })).toBe(DEFAULT_JSON_BODY_MAX_BYTES);
  });

  it("reads a body under the limit and stops reading one over it, Content-Length or not", async () => {
    expect(await readBodyText(jsonRequest('{"a":1}'), 100)).toBe('{"a":1}');
    await expect(readBodyText(jsonRequest("x".repeat(101)), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    const streamed = new Request("http://localhost/api/iegp", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i += 1) controller.enqueue(new TextEncoder().encode("y".repeat(40)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readBodyText(streamed, 100)).rejects.toThrow(/over/);
  });

  it("readJsonBody answers an oversized body with a plain-English 413", async () => {
    vi.stubEnv("SYNAPSE_JSON_BODY_MAX_BYTES", "64");
    const error = await readJsonBody(jsonRequest(JSON.stringify({ text: "z".repeat(200) }))).catch((e) => e);
    expect(error).toBeInstanceOf(BodyTooLargeError);
    const res = await apiErrorResponse(error);
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe("too_large");
    expect(json.error).toMatch(/Send a smaller file, or paste only the part you need/);
    // Malformed JSON under the limit is still the 400 it was.
    await expect(readJsonBody(jsonRequest("{nope"))).rejects.toBeInstanceOf(ApiGuardError);
  });

  it("the proxy refuses an API request whose declared size is over the limit", async () => {
    vi.stubEnv("SYNAPSE_JSON_BODY_MAX_BYTES", "1000");
    const big = new NextRequest("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5000" },
      body: "x".repeat(5000),
    });
    const res = proxy(big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too_large");
    const small = new NextRequest("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: '{"a":"bc"}',
    });
    expect(proxy(small).status).not.toBe(413);
  });

  it("a workspace request over the limit is a 413, not an empty body", async () => {
    vi.stubEnv("SYNAPSE_JSON_BODY_MAX_BYTES", "64");
    await signInFor(`kan20-big-${unique()}`);
    const res = await workspacesPost(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "n".repeat(500) }),
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("KAN-20: provider calls time out", () => {
  const target = { provider_id: "anthropic-claude", provider_name: "Anthropic", key_env: "ANTHROPIC_API_KEY" };

  it("defaults to two minutes and reads SYNAPSE_LLM_TIMEOUT_MS", () => {
    expect(providerTimeoutMs({})).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(providerTimeoutMs({ SYNAPSE_LLM_TIMEOUT_MS: "5000" })).toBe(5000);
  });

  it("a hung provider becomes ProviderError 'unavailable' with a plain message", async () => {
    vi.stubEnv("SYNAPSE_LLM_TIMEOUT_MS", "50");
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const error = await fetchProvider("https://api.example/v1", { method: "POST" }, target).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("unavailable");
    expect(error.info.no_response).toBe("timeout");
    expect(error.message).toMatch(/did not answer within \d+ ms,/);
    expect(error.message).not.toMatch(/within 0 seconds/);
  });

  it("a connection failure is 'unavailable' too, and never echoes the key", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed: sk-secretkey123456");
    });
    const error = await fetchProvider("https://api.example/v1", { method: "POST" }, target).catch((e) => e);
    expect(error.kind).toBe("unavailable");
    expect(error.info.no_response).toBe("network");
    expect(error.message).toMatch(/could not reach Anthropic/);
    expect(error.message).not.toContain("sk-secret");
  });

  it("a normal answer passes through with its body", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"ok":true}', { status: 200 }));
    const { res, text } = await fetchProvider("https://api.example/v1", { method: "POST" }, target);
    expect(res.ok).toBe(true);
    expect(text).toBe('{"ok":true}');
  });
});

describe("KAN-20: parse limits per document", () => {
  it("has defaults and env overrides", () => {
    expect(parseLimits({})).toEqual({ units: 2_000, calls: 50 });
    expect(parseLimits({ SYNAPSE_MAX_PARSE_UNITS: "10", SYNAPSE_MAX_PARSE_CALLS: "2" })).toEqual({ units: 10, calls: 2 });
    expect(parseLimitError("a.pdf", 10, 1, { units: 10, calls: 2 })).toBeNull();
    expect(parseLimitError("a.pdf", 11, 1, { units: 10, calls: 2 })).toMatch(/a\.pdf is too long to parse in one go/);
    expect(parseLimitError("a.pdf", 5, 3, { units: 10, calls: 2 })).toMatch(/3 model calls/);
  });

  it("refuses an oversized document before any model call", async () => {
    vi.stubEnv("SYNAPSE_MAX_PARSE_UNITS", "3");
    const ask = vi.fn();
    const units = Array.from({ length: 4 }, (_, i) => ({
      location: { kind: "page" as const, ref: `p.${i + 1}` },
      text: `Unit ${i + 1}`,
    }));
    await expect(structureWithLlm({ filename: "big.pdf", units, ask })).rejects.toThrow(
      /big\.pdf is too long to parse in one go: it has 4 sections of text/,
    );
    expect(ask).not.toHaveBeenCalled();
  });
});

async function signInFor(subject: string) {
  jar.clear();
  return createSession({
    provider_id: "demo",
    subject,
    email: `${subject}@kan20.test`,
    actor_name: subject,
    actor_function: "medical_affairs",
    role: "medical_affairs",
  });
}

describe("KAN-20: per-person workspace creation limit", () => {
  it("defaults to 20 and can be configured", () => {
    expect(workspaceCreationLimit({})).toBe(DEFAULT_MAX_WORKSPACES_PER_USER);
    expect(workspaceCreationLimit({ SYNAPSE_MAX_WORKSPACES_PER_USER: "3" })).toBe(3);
  });

  it("refuses the next workspace once a person has created the limit", async () => {
    const owner = `kan20-owner-${unique()}@kan20.test`;
    await assertCanCreateWorkspace(owner, 2);
    await createWorkspace({ name: "Limit one", owner });
    await createWorkspace({ name: "Limit two", owner });
    const error = await assertCanCreateWorkspace(owner, 2).catch((e) => e);
    expect(error).toBeInstanceOf(WorkspaceLimitError);
    expect(error.message).toMatch(/create up to 2 workspaces, and you have reached that limit/);
  });

  it("the create-workspace API answers 429 with the plain message", async () => {
    vi.stubEnv("SYNAPSE_MAX_WORKSPACES_PER_USER", "1");
    await signInFor(`kan20-api-${unique()}`);
    const create = () =>
      workspacesPost(
        new Request("http://localhost/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `Limit ${unique()}` }),
        }),
      );
    expect((await create()).status).toBe(201);
    const refused = await create();
    expect(refused.status).toBe(429);
    const json = (await refused.json()) as { error: string; code: string };
    expect(json.code).toBe("workspace_limit");
    expect(json.error).toMatch(/create up to 1 workspace, and you have reached that limit/);
  });
});

describe("KAN-20 QA: timeout wording", () => {
  it("never says 0 seconds", async () => {
    const { describeTimeout } = await import("@/modules/llm/provider-error");
    expect(describeTimeout(1)).toBe("1 ms");
    expect(describeTimeout(1000)).toBe("1 second");
    expect(describeTimeout(120000)).toBe("120 seconds");
  });
});
