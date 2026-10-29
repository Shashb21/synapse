/** Tests of KAN-191's intended reference policy, not deployed authorization. */
import { describe, expect, it } from "vitest";
import {
  evaluateWorkspaceSharingReferencePolicy,
  type CustomerAppReferenceRequest,
  type RecordedAccessException,
} from "../specs/policies/workspace-sharing";

const member: CustomerAppReferenceRequest = {
  context: "customer-app",
  action: "access",
  actor: {
    principalId: "person-a",
    verified: true,
    seat: { customerId: "customer-a", active: true, customerActive: true },
  },
  workspace: { id: "workspace-a", classification: "customer", customerId: "customer-a", customerActive: true },
  membership: "member",
};
const exception: RecordedAccessException = {
  recordId: "exception-1",
  principalId: "person-a",
  workspaceId: "workspace-a",
  approvedByPlatformAdminId: "platform-owner",
  reason: "Reviewed support access",
  state: "active",
};
const external: CustomerAppReferenceRequest = {
  ...member,
  actor: { ...member.actor!, seat: { customerId: "customer-b", active: true, customerActive: true } },
  exception,
};
const ownerInvite: CustomerAppReferenceRequest = {
  ...member,
  action: "invite",
  membership: "owner",
  inviteeSeat: { customerId: "customer-a", active: true, customerActive: true },
};

// Arrange facts, Act by evaluating them, Assert a hand-derived decision.
// These cases catch missing gates, overly broad exceptions, and admin bypasses.
describe("KAN-191 intended workspace-sharing reference policy (no deployed enforcement)", () => {
  it("allows a verified active same-customer workspace member", () => {
    const decision = evaluateWorkspaceSharingReferencePolicy(member);
    expect(decision).toEqual({ allowed: true, basis: "customer-membership" });
  });

  it.each<[string, Partial<CustomerAppReferenceRequest>]>([
    ["missing actor", { actor: undefined }],
    ["missing principal", { actor: { ...member.actor!, principalId: undefined } }],
    ["blank principal", { actor: { ...member.actor!, principalId: "  " } }],
    ["missing verification", { actor: { ...member.actor!, verified: undefined } }],
    ["unverified identity", { actor: { ...member.actor!, verified: false } }],
    ["missing seat", { actor: { ...member.actor!, seat: undefined } }],
    ["missing seat customer", { actor: { ...member.actor!, seat: { ...member.actor!.seat!, customerId: undefined } } }],
    ["missing seat status", { actor: { ...member.actor!, seat: { ...member.actor!.seat!, active: undefined } } }],
    ["inactive seat", { actor: { ...member.actor!, seat: { ...member.actor!.seat!, active: false } } }],
    ["inactive actor customer", { actor: { ...member.actor!, seat: { ...member.actor!.seat!, customerActive: false } } }],
    ["missing membership", { membership: undefined }],
    ["customer change", { actor: external.actor }],
    ["missing workspace", { workspace: undefined }],
    ["missing workspace identity", { workspace: { ...member.workspace!, id: undefined } }],
    ["missing owning customer status", { workspace: { ...member.workspace!, customerActive: undefined } }],
    ["inactive workspace customer", { workspace: { ...member.workspace!, customerActive: false } }],
    ["missing durable ownership", { workspace: { ...member.workspace!, customerId: undefined } }],
    ["unclassified workspace", { workspace: { ...member.workspace!, classification: "unclassified" } }],
    ["platform workspace", { workspace: { ...member.workspace!, classification: "platform" } }],
    ["development demo workspace", { workspace: { ...member.workspace!, classification: "development-demo" } }],
  ])("denies %s", (_name, overrides) => {
    const request = { ...member, ...overrides };
    const decision = evaluateWorkspaceSharingReferencePolicy(request);
    expect(decision.allowed).toBe(false);
  });

  it.each(["password", "demo", "sso"])("applies ordinary customer rules to a seated %s principal and customer-owned demo", (provider) => {
    const request = {
      ...member,
      actor: { ...member.actor!, provider },
      workspace: { ...member.workspace!, demo: true, demo_mode: true },
    };
    expect(evaluateWorkspaceSharingReferencePolicy(request)).toEqual({ allowed: true, basis: "customer-membership" });
  });

  it("allows only the accessible same-customer owner to invite an active same-customer seat", () => {
    const decision = evaluateWorkspaceSharingReferencePolicy(ownerInvite);
    expect(decision).toEqual({ allowed: true, basis: "owner-invitation" });
  });

  it.each<[string, Partial<CustomerAppReferenceRequest>]>([
    ["member", { membership: "member" }],
    ["owner without membership", { membership: undefined }],
    ["owner without verification", { actor: { ...member.actor!, verified: false } }],
    ["owner without seat", { actor: { ...member.actor!, seat: undefined } }],
    ["invitee without seat", { inviteeSeat: undefined }],
    ["inactive invitee seat", { inviteeSeat: { ...ownerInvite.inviteeSeat!, active: false } }],
    ["inactive invitee customer", { inviteeSeat: { ...ownerInvite.inviteeSeat!, customerActive: false } }],
    ["cross-customer invitee", { inviteeSeat: { ...ownerInvite.inviteeSeat!, customerId: "customer-b" } }],
    ["external owner with recorded exception", { actor: external.actor, exception }],
  ])("denies invitation by/for %s", (_name, overrides) => {
    const decision = evaluateWorkspaceSharingReferencePolicy({ ...ownerInvite, ...overrides });
    expect(decision.allowed).toBe(false);
  });

  it("allows access with an exact live recorded admin exception and ordinary seat/membership checks", () => {
    const decision = evaluateWorkspaceSharingReferencePolicy(external);
    expect(decision).toEqual({ allowed: true, basis: "recorded-exception" });
  });

  it.each<[string, Partial<RecordedAccessException> | undefined]>([
    ["absent", undefined],
    ["wrong principal", { principalId: "person-b" }],
    ["wrong workspace", { workspaceId: "workspace-b" }],
    ["revoked", { state: "revoked" }],
    ["missing state", { state: undefined }],
    ["unrecorded", { recordId: undefined }],
    ["missing admin approval", { approvedByPlatformAdminId: undefined }],
    ["missing reason", { reason: undefined }],
    ["blank reason", { reason: "  " }],
    ["missing principal", { principalId: undefined }],
    ["missing workspace", { workspaceId: undefined }],
  ])("denies an %s exception", (_name, overrides) => {
    const request = { ...external, exception: overrides === undefined ? undefined : { ...exception, ...overrides } };
    const decision = evaluateWorkspaceSharingReferencePolicy(request);
    expect(decision.allowed).toBe(false);
  });

  it.each<[string, Partial<CustomerAppReferenceRequest>]>([
    ["membership", { membership: undefined }],
    ["seat", { actor: { ...external.actor!, seat: undefined } }],
    ["active seat", { actor: { ...external.actor!, seat: { ...external.actor!.seat!, active: false } } }],
    ["active actor customer", { actor: { ...external.actor!, seat: { ...external.actor!.seat!, customerActive: false } } }],
    ["verification", { actor: { ...external.actor!, verified: false } }],
    ["active owning customer", { workspace: { ...external.workspace!, customerActive: false } }],
  ])("does not let an exception waive %s", (_name, overrides) => {
    const decision = evaluateWorkspaceSharingReferencePolicy({ ...external, ...overrides });
    expect(decision.allowed).toBe(false);
  });

  it.each([true, false, undefined])("keeps owner-checked platform administration separate: owner=%s", (platformOwner) => {
    const decision = evaluateWorkspaceSharingReferencePolicy({ context: "platform-admin", verified: true, platformOwner });
    expect(decision.allowed).toBe(platformOwner === true);
  });

  it("denies unverified platform administration", () => {
    expect(evaluateWorkspaceSharingReferencePolicy({ context: "platform-admin", platformOwner: true }).allowed).toBe(false);
  });

  it.each(["password", "demo", "sso"])("does not treat %s provider or demo/admin flags as customer-app permission", (provider) => {
    const request = { ...member, actor: { principalId: "platform-owner", verified: true, provider, platformOwner: true, demo: true } };
    expect(evaluateWorkspaceSharingReferencePolicy(request).allowed).toBe(false);
  });
});
