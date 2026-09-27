import { describe, expect, it } from "vitest";
import { walkthroughApplies } from "@/components/walkthrough/walkthrough-client";

describe("where the walkthrough loads its progress", () => {
  it("never on public pages, the workspace picker, your account or the owner's pages", () => {
    for (const path of [
      "/login",
      "/login/",
      "/api/auth/login",
      "/api/oauth/llm/callback",
      "/workspaces",
      "/workspaces/new",
      "/account",
      "/admin",
      "/admin/control",
      "/favicon.ico",
    ]) {
      expect(walkthroughApplies(path), path).toBe(false);
    }
  });

  it("on the pages of an open workspace", () => {
    for (const path of ["/", "/gaps", "/setup", "/tactics", "/ideation", "/timeline", "/room", "/sources"]) {
      expect(walkthroughApplies(path), path).toBe(true);
    }
  });
});
