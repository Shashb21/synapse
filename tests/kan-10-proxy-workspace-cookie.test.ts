import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { workspaceCookieValue } from "@/modules/workspaces/context";

/**
 * Found in live QA: a tampered workspace cookie reached the page and failed as
 * a 500. The proxy now verifies signature and expiry before anything renders.
 */
function request(path: string, cookies: Record<string, string>) {
  const req = new NextRequest(`http://localhost${path}`);
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

describe("proxy verifies the workspace cookie", () => {
  const session = "session-abc";

  it("lets a valid selection through", () => {
    const res = proxy(request("/timeline", { synapse_session: session, synapse_workspace: workspaceCookieValue("wabc", session) }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("sends a tampered page request to /workspaces and clears the cookie", () => {
    const res = proxy(request("/timeline", { synapse_session: session, synapse_workspace: "default.9999999999999.forged" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/workspaces");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/synapse_workspace=;/);
  });

  it("answers a tampered API request with 409 no_workspace", async () => {
    const res = proxy(request("/api/plan", { synapse_session: session, synapse_workspace: "wabc.1.bad" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("no_workspace");
  });

  it("refuses a selection signed for another session", () => {
    const res = proxy(request("/timeline", { synapse_session: "other", synapse_workspace: workspaceCookieValue("wabc", session) }));
    expect(res.headers.get("location")).toContain("/workspaces");
  });
});
