/**
 * KAN-191 executable reference specification of the accepted sharing policy.
 * Design evidence only: never import into production authorization code.
 * Facts come from trusted, current adapters; this model authenticates nobody,
 * queries no storage, and does not verify an administrator's approval record.
 */

/** Current seat and customer facts for one named principal, supplied by an adapter. */
export type ReferenceSeat = {
  customerId?: string;
  active?: boolean;
  customerActive?: boolean;
};

/** A trusted recorded approval; state must reflect current revocation/expiry checks. */
export type RecordedAccessException = {
  recordId?: string;
  principalId?: string;
  workspaceId?: string;
  approvedByPlatformAdminId?: string;
  reason?: string;
  state?: "active" | "revoked";
};

/** Customer-app facts scoped to this exact principal, workspace and action. */
export type CustomerAppReferenceRequest = {
  context: "customer-app";
  action: "access" | "invite";
  actor?: {
    principalId?: string;
    verified?: boolean;
    seat?: ReferenceSeat;
  };
  workspace?: {
    id?: string;
    classification: "customer" | "platform" | "development-demo" | "unclassified";
    customerId?: string;
    customerActive?: boolean;
  };
  /** Adapter must resolve membership for the exact actor/workspace pair. */
  membership?: "owner" | "member";
  inviteeSeat?: ReferenceSeat;
  exception?: RecordedAccessException;
};

/** A separate owner-checked platform console; never a customer-app bypass. */
export type PlatformAdminReferenceRequest = {
  context: "platform-admin";
  verified?: boolean;
  platformOwner?: boolean;
};

/** Explicit outcomes make the intended permission basis inspectable in tests. */
export type WorkspaceSharingReferenceDecision =
  | { allowed: true; basis: "customer-membership" | "recorded-exception" | "owner-invitation" | "platform-admin" }
  | { allowed: false };

/**
 * Evaluate the intended policy from trusted facts, denying absent requirements.
 *
 * Parameters
 * ----------
 * request : CustomerAppReferenceRequest | PlatformAdminReferenceRequest
 *     Current verified identity and scoped authorization facts, not raw input.
 *
 * Returns
 * -------
 * WorkspaceSharingReferenceDecision
 *     Reference allow/deny result; this does not enforce deployed access or
 *     confer any capabilities beyond the requested access/invitation decision.
 */
export function evaluateWorkspaceSharingReferencePolicy(
  request: CustomerAppReferenceRequest | PlatformAdminReferenceRequest,
): WorkspaceSharingReferenceDecision {
  if (request.context === "platform-admin") {
    return request.verified === true && request.platformOwner === true
      ? { allowed: true, basis: "platform-admin" }
      : { allowed: false };
  }

  const { actor, workspace, membership } = request;
  const seat = actor?.seat;
  if (
    !actor?.principalId?.trim() || actor.verified !== true ||
    !seat?.customerId?.trim() || seat.active !== true || seat.customerActive !== true ||
    !workspace?.id?.trim() || workspace.classification !== "customer" ||
    !workspace.customerId?.trim() || workspace.customerActive !== true ||
    (membership !== "owner" && membership !== "member")
  ) return { allowed: false };

  const sameCustomer = seat.customerId === workspace.customerId;
  if (request.action === "invite") {
    const invitee = request.inviteeSeat;
    return sameCustomer && membership === "owner" &&
      invitee?.active === true && invitee.customerActive === true &&
      invitee.customerId === workspace.customerId
      ? { allowed: true, basis: "owner-invitation" }
      : { allowed: false };
  }

  if (sameCustomer) return { allowed: true, basis: "customer-membership" };
  const exception = request.exception;
  return exception?.state === "active" &&
    Boolean(exception.recordId?.trim()) &&
    Boolean(exception.approvedByPlatformAdminId?.trim()) &&
    Boolean(exception.reason?.trim()) &&
    exception.principalId === actor.principalId && exception.workspaceId === workspace.id
    ? { allowed: true, basis: "recorded-exception" }
    : { allowed: false };
}
