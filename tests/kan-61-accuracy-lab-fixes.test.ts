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
import { POST as harnessPost } from "@/app/api/admin/harness/route";
import AiHarnessPage from "@/app/admin/harness/page";
import { AiHarness } from "@/components/admin/ai-harness";
import { HarnessAiOffError, harnessNoModelMessage, runHarness } from "@/modules/harness/harness";
import { setAiEnabled } from "@/modules/kernel/ai-switch";

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

beforeEach(() => {
  jar.values.clear();
});

afterAll(async () => {
  await setAiEnabled({ enabled: true, actor_name: ADMIN, rationale: "restore after KAN-61 tests" });
});

describe("malformed JSON is a 400, never a 500 (KAN-61 item 5)", () => {
  it("answers 400 Invalid JSON on the admin route", async () => {
    const handlers: [string, (req: Request) => Promise<Response>][] = [
      ["/api/admin/harness", harnessPost],
    ];
    for (const [url, handler] of handlers) {
      const res = await call(await handler(request(url, "POST", "{not json")));
      expect({ url, status: res.status, error: res.json.error }).toEqual({ url, status: 400, error: "Invalid JSON" });
    }
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
