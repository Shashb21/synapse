import { describe, expect, it } from "vitest";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  passwordPolicyError,
  temporaryPassword,
  verifyPassword,
} from "@/modules/auth/password";
import { signupAllowed } from "@/modules/auth/signup-policy";
import { ownerDecision } from "@/modules/auth/roles";
import { gateFor } from "@/modules/auth/gate";
import { principalOf } from "@/modules/workspaces/session";

describe("KAN-22 password hashing", () => {
  it("stores scrypt$N$r$p$salt$hash and verifies only the right password", async () => {
    const hash = await hashPassword("a long enough passphrase");
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    expect(Buffer.from(parts[4], "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5], "base64")).toHaveLength(64);
    expect(await verifyPassword("a long enough passphrase", hash)).toBe(true);
    expect(await verifyPassword("a long enough passphrasE", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash and never verifies a malformed one", async () => {
    const a = await hashPassword("same password here");
    const b = await hashPassword("same password here");
    expect(a).not.toBe(b);
    for (const bad of ["", "plain", "scrypt$16384$8$1$$", "bcrypt$1$2$3$c2FsdA==$aGFzaA==", null, undefined]) {
      expect(await verifyPassword("same password here", bad)).toBe(false);
    }
  });
});

describe("KAN-22 password policy", () => {
  it("needs at least 12 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordPolicyError("elevenchars")).toMatch(/12 characters/);
    expect(passwordPolicyError("twelve chars")).toBeNull();
  });

  it("refuses the email (or its local part) and common passwords", () => {
    expect(passwordPolicyError("alexander.morgan@example.com", "Alexander.Morgan@example.com")).toMatch(/email/);
    expect(passwordPolicyError("alexandermorgan", "alexandermorgan@example.com")).toMatch(/email/);
    expect(passwordPolicyError("Password1234")).toMatch(/common/);
    expect(passwordPolicyError("aaaaaaaaaaaaaaa")).toMatch(/common/);
    expect(passwordPolicyError("x".repeat(300))).toMatch(/at most/);
    expect(passwordPolicyError("mauve-kettle-orbit-42", "alex@example.com")).toBeNull();
  });

  it("temporary passwords pass the policy", () => {
    for (let i = 0; i < 20; i++) expect(passwordPolicyError(temporaryPassword(), "x@example.com")).toBeNull();
  });
});

describe("KAN-22 identity rules", () => {
  it("an unverified password session is password:<id>; a verified one is its email", () => {
    expect(principalOf({ provider_id: "password", subject: "acct_1", email: null })).toBe("password:acct_1");
    expect(principalOf({ provider_id: "password", subject: "acct_1", email: "a@example.com" })).toBe("a@example.com");
    // SSO and demo behaviour is unchanged.
    expect(principalOf({ provider_id: "google", subject: "google:123", email: null })).toBe("google:123");
    expect(principalOf({ provider_id: "demo", subject: "demo:Alex", email: "alex@demo.synapse.local" })).toBe(
      "alex@demo.synapse.local",
    );
  });

  it("ownerDecision: an admin password account is the owner; a plain one is not", () => {
    const base = { role: "contributor" as const, email: null, signed_in: true, demo: true, provider_id: "password" };
    expect(ownerDecision({ ...base, admin_account: true }, { emails: [], bypass: true }).owner).toBe(true);
    expect(ownerDecision({ ...base, admin_account: false }, { emails: [], bypass: true }).owner).toBe(false);
    // admin_account only counts for a password session.
    expect(ownerDecision({ ...base, provider_id: "google", admin_account: true }, { emails: [], bypass: false }).owner).toBe(false);
    // Existing rules stay: operator role, OWNER_EMAILS on a verified session.
    expect(ownerDecision({ ...base, role: "operator" }, { emails: [] }).owner).toBe(true);
    expect(ownerDecision({ ...base, email: "boss@example.com" }, { emails: ["boss@example.com"] }).owner).toBe(true);
  });

  it("ALLOW_SIGNUP defaults to open; 0 closes it", () => {
    expect(signupAllowed({})).toBe(true);
    expect(signupAllowed({ ALLOW_SIGNUP: "1" })).toBe(true);
    expect(signupAllowed({ ALLOW_SIGNUP: "0" })).toBe(false);
    expect(signupAllowed({ ALLOW_SIGNUP: "false" })).toBe(false);
  });

  it("gate: sign-up and password APIs are public, /account needs a session, /api/admin gates itself", () => {
    expect(gateFor("/signup")).toBe("open");
    expect(gateFor("/api/auth/password/login")).toBe("open");
    expect(gateFor("/api/auth/password/signup")).toBe("open");
    expect(gateFor("/account")).toBe("session");
    expect(gateFor("/api/account/password")).toBe("session");
    expect(gateFor("/api/admin/users")).toBe("open");
    expect(gateFor("/admin/users")).toBe("open");
    expect(gateFor("/gaps")).toBe("workspace");
  });
});
