import { afterEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));

import { apiErrorResponse } from "@/modules/auth/api-guard";
import { TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import { stageErrorResponse } from "@/app/api/modules/ai-off";
import { NoRouteError } from "@/modules/llm/provider";
import {
  NO_LLM_CODE,
  NO_LLM_CUSTOMER_MESSAGE,
  OWNER_CONTROL_HREF,
  noLlmBody,
} from "@/modules/kernel/no-llm";

const DETAIL =
  "xAI · Grok: disconnected; Anthropic · Claude: disconnected; OpenAI · ChatGPT: disconnected. Connect an LLM provider in the owner control panel (/admin/control) — log in with Grok, Claude, or another provider — then retry.";

afterEach(() => jar.values.clear());

describe("the no-LLM message is chosen by audience", () => {
  it("tells a customer to ask their administrator or carry on by hand, with no admin link", () => {
    const body = noLlmBody(DETAIL, false);
    expect(body).toEqual({ code: NO_LLM_CODE, error: NO_LLM_CUSTOMER_MESSAGE });
    expect(body.error).toBe(
      "No AI model is connected. Ask your Synapse administrator to connect one, or carry on by hand.",
    );
    expect(body.error).not.toMatch(/control|grok|claude|openai/i);
  });

  it("gives the owner the provider-by-provider detail and the /admin/control link", () => {
    const body = noLlmBody(DETAIL, true);
    expect(body.error).toContain("xAI · Grok: disconnected");
    expect(body.admin_href).toBe(OWNER_CONTROL_HREF);
    expect(OWNER_CONTROL_HREF).toBe("/admin/control");
  });

  it("never points anyone at the old /control path", () => {
    for (const owner of [true, false]) {
      expect(noLlmBody(DETAIL, owner).error).not.toMatch(/\(\/control\)/);
    }
  });
});

describe("API responses for a run with no connected model", () => {
  it("a customer gets 409 no_llm with the plain text", async () => {
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    const response = await apiErrorResponse(new NoRouteError(DETAIL));
    expect(response.status).toBe(409);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json).toEqual({ code: "no_llm", error: NO_LLM_CUSTOMER_MESSAGE });
  });

  it("the stage-run route maps it the same way", async () => {
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    const response = await stageErrorResponse(new NoRouteError(DETAIL), "Stage run failed");
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.code).toBe("no_llm");
    expect(json.error).toBe(NO_LLM_CUSTOMER_MESSAGE);
    expect(json.admin_href).toBeUndefined();
  });

  it("the owner (test-stub demo session) gets the detail and the link", async () => {
    const response = await apiErrorResponse(new NoRouteError(DETAIL));
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.code).toBe("no_llm");
    expect(json.error).toContain("Anthropic · Claude: disconnected");
    expect(json.admin_href).toBe("/admin/control");
  });

  it("other errors keep their 400 and message", async () => {
    const response = await apiErrorResponse(new Error("Bad input"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Bad input" });
  });
});
