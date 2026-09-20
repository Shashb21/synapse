import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AgenticGateway,
  CLAUDE_CODE_IDENTITY_PROMPT,
  agenticCallLog,
  attributionBlockText,
  clearAgenticCallLog,
  clearReauthHistory,
  clearReauthHooks,
  computeFingerprint,
  loadClaudeCodeCredential,
  oauthSystemBlocks,
  persistClaudeCodeCredential,
  registerReauthHook,
  reauthHistory,
} from "@/lib/llm/agentic";
import { extractJsonObject } from "@/lib/llm/json";
import { FINGERPRINT_SALT } from "@/lib/llm/agentic/types";
import { ANTHROPIC_MESSAGES_URL } from "@/lib/llm/agentic/types";

process.env.AGENTIC_TRACKING = "memory";

function tempCredPath() {
  const dir = mkdtempSync(join(tmpdir(), "synapse-oauth-"));
  return join(dir, ".credentials.json");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  clearAgenticCallLog();
  clearReauthHistory();
  clearReauthHooks();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_ACCESS_TOKEN;
  delete process.env.CLAUDE_CODE_REFRESH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_EXPIRES_AT;
  delete process.env.CLAUDE_CODE_CREDENTIALS_PATH;
  delete process.env.AGENTIC_AUTH;
  process.env.AGENTIC_TRACKING = "memory";
});

describe("claude code oauth subsystem (standalone)", () => {
  it("computes the Claude Code attribution fingerprint", () => {
    const user = "hello world this is a test";
    const version = "2.1.85";
    const chars = [4, 7, 20].map((i) => user[i] ?? "0").join("");
    const expected = createHash("sha256")
      .update(FINGERPRINT_SALT + chars + version, "utf8")
      .digest("hex")
      .slice(0, 3);
    expect(computeFingerprint(user, version)).toBe(expected);
    expect(attributionBlockText(user, version)).toContain(`cc_version=${version}.${expected}`);
  });

  it("loads Claude Code credentials from the credentials file", () => {
    const path = tempCredPath();
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-file",
          refreshToken: "refresh-file",
          expiresAt: Date.now() + 60_000,
          subscriptionType: "max",
        },
      }),
    );
    process.env.CLAUDE_CODE_CREDENTIALS_PATH = path;
    const cred = loadClaudeCodeCredential();
    expect(cred?.accessToken).toBe("sk-ant-oat01-file");
    expect(cred?.refreshToken).toBe("refresh-file");
    expect(cred?.source).toBe("file");
  });

  it("prefers env access token and keeps the file refresh token", () => {
    const path = tempCredPath();
    persistClaudeCodeCredential({
      accessToken: "sk-ant-oat01-old",
      refreshToken: "refresh-keep",
      source: "file",
      path,
    });
    process.env.CLAUDE_CODE_CREDENTIALS_PATH = path;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-env";
    const cred = loadClaudeCodeCredential();
    expect(cred?.accessToken).toBe("sk-ant-oat01-env");
    expect(cred?.refreshToken).toBe("refresh-keep");
    expect(cred?.source).toBe("merged");
  });

  it("prepends attribution + Claude Code identity to OAuth system blocks", () => {
    const blocks = oauthSystemBlocks({ system: "Extract gaps.", user: "Need CE in elderly." });
    expect(blocks[0]?.text.startsWith("x-anthropic-billing-header:")).toBe(true);
    expect(blocks[1]?.text).toBe(CLAUDE_CODE_IDENTITY_PROMPT);
    expect(blocks[2]?.text).toBe("Extract gaps.");
  });

  it("sends OAuth bearer headers and tracks the call", async () => {
    const events: string[] = [];
    registerReauthHook((event) => {
      events.push(event.type);
    });
    const gateway = new AgenticGateway({
      apiKey: () => undefined,
      model: () => "claude-sonnet-4-5",
      loadCredential: () => ({
        accessToken: "sk-ant-oat01-live",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        source: "env",
      }),
      fetch: async (input, init) => {
        expect(String(input)).toBe(ANTHROPIC_MESSAGES_URL);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-live");
        expect(headers.get("x-api-key")).toBeNull();
        expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
        expect(headers.get("x-app")).toBe("cli");
        const body = JSON.parse(String(init?.body)) as {
          system: { type: string; text: string }[];
        };
        expect(body.system[1]?.text).toBe(CLAUDE_CODE_IDENTITY_PROMPT);
        return jsonResponse(200, {
          content: [{ type: "text", text: '{"ok":true,"via":"oauth"}' }],
          usage: { input_tokens: 11, output_tokens: 7 },
        });
      },
    });
    const json = await gateway.completeJson({
      system: "You are the judge.",
      user: "Return JSON.",
      purpose: "judge",
    });
    expect(json).toEqual({ ok: true, via: "oauth" });
    const log = agenticCallLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      auth_mode: "oauth",
      purpose: "judge",
      ok: true,
      http_status: 200,
      input_tokens: 11,
      output_tokens: 7,
    });
    expect(events).toEqual([]);
  });

  it("refreshes on 401, retries, and fires reauth hooks", async () => {
    const types: string[] = [];
    registerReauthHook((event) => {
      types.push(event.type);
    });
    let messagesCalls = 0;
    const gateway = new AgenticGateway({
      apiKey: () => undefined,
      model: () => "claude-sonnet-4-5",
      loadCredential: () => ({
        accessToken: "sk-ant-oat01-stale",
        refreshToken: "refresh-stale",
        expiresAt: Date.now() + 3_600_000,
        source: "env",
      }),
      refresh: async (cred) => ({
        ...cred,
        accessToken: "sk-ant-oat01-fresh",
        expiresAt: Date.now() + 3_600_000,
      }),
      fetch: async (_input, init) => {
        messagesCalls += 1;
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") === "Bearer sk-ant-oat01-stale") {
          return jsonResponse(401, { error: { message: "invalid bearer token" } });
        }
        expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-fresh");
        return jsonResponse(200, {
          content: [{ type: "text", text: '{"gaps":[],"needs":[]}' }],
        });
      },
    });
    const json = await gateway.completeJson({
      system: "You are the proposer.",
      user: "{}",
      purpose: "proposer",
    });
    expect(json).toEqual({ gaps: [], needs: [] });
    expect(messagesCalls).toBe(2);
    expect(types).toContain("unauthorized");
    expect(types).toContain("refreshed");
    expect(agenticCallLog()[0]?.reauth).toBe("refreshed");
    expect(reauthHistory().map((e) => e.type)).toEqual(types);
  });

  it("refreshes before expiry and persists the new token", async () => {
    const path = tempCredPath();
    process.env.CLAUDE_CODE_CREDENTIALS_PATH = path;
    const gateway = new AgenticGateway({
      apiKey: () => undefined,
      now: () => 1_000_000,
      loadCredential: () => ({
        accessToken: "sk-ant-oat01-old",
        refreshToken: "refresh-old",
        expiresAt: 1_000_000 + 30_000,
        source: "file",
        path,
      }),
      refresh: async (cred) => {
        const next = {
          ...cred,
          accessToken: "sk-ant-oat01-renewed",
          refreshToken: "refresh-new",
          expiresAt: 1_000_000 + 3_600_000,
        };
        persistClaudeCodeCredential(next);
        return next;
      },
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-renewed");
        return jsonResponse(200, {
          content: [{ type: "text", text: '{"ok":1}' }],
        });
      },
    });
    await gateway.completeJson({ system: "sys", user: "user", purpose: "validate" });
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      claudeAiOauth: { accessToken: string; refreshToken: string };
    };
    expect(saved.claudeAiOauth.accessToken).toBe("sk-ant-oat01-renewed");
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-new");
    expect(agenticCallLog()[0]?.reauth).toBe("refreshed");
  });

  it("falls back to the API key when no OAuth session exists", async () => {
    const gateway = new AgenticGateway({
      apiKey: () => "sk-ant-api03-test",
      workspaceId: () => "wrkspc_test",
      loadCredential: () => null,
      model: () => "claude-sonnet-4-5",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("sk-ant-api03-test");
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("anthropic-workspace-id")).toBe("wrkspc_test");
        const body = JSON.parse(String(init?.body)) as { system: string };
        expect(typeof body.system).toBe("string");
        return jsonResponse(200, {
          content: [{ type: "text", text: "```json\n{\"via\":\"api_key\"}\n```" }],
        });
      },
    });
    expect(await gateway.completeJson({ system: "sys", user: "user" })).toEqual({ via: "api_key" });
    expect(agenticCallLog()[0]?.auth_mode).toBe("api_key");
  });

  it("throws when AGENTIC_AUTH=oauth and no Claude Code session is present", async () => {
    process.env.AGENTIC_AUTH = "oauth";
    const gateway = new AgenticGateway({
      apiKey: () => "sk-ant-api03-unused",
      loadCredential: () => null,
    });
    await expect(gateway.completeJson({ system: "sys", user: "user" })).rejects.toThrow(/OAuth/);
  });

  it("extracts JSON objects from fenced Claude replies", () => {
    expect(extractJsonObject('noise\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });
});

const live = process.env.AGENTIC_LIVE === "1";

describe.skipIf(!live)("live agentic gateway", () => {
  it("completes a tiny JSON call through the default gateway", async () => {
    const { completeJson, agenticAuthStatus } = await import("@/lib/llm/agentic");
    const status = agenticAuthStatus();
    expect(status.ready).toBe(true);
    const json = await completeJson({
      system: 'Reply with JSON only: {"pong":true,"auth":"<oauth|api_key>"} matching how you were authenticated.',
      user: "Ping. JSON object only.",
      maxTokens: 64,
      purpose: "validate",
    });
    expect(json).toEqual(expect.objectContaining({ pong: true }));
    const last = agenticCallLog().at(-1);
    expect(last?.ok).toBe(true);
    expect(last?.auth_mode).toBe(status.auth_mode);
  });
});
