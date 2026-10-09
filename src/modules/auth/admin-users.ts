import {
  AccountError,
  asActorFunction,
  countPasswordSessions,
  createAccount,
  deleteAccount,
  getAccount,
  isLocked,
  listAccounts,
  normalizeEmail,
  PASSWORD_PROVIDER,
  revokeAccountSessions,
  setPassword,
  unlockAccount,
  updateAccount,
  type Account,
} from "./accounts";
import { temporaryPassword } from "./password";
import { isRole, type Role } from "./roles";
import type { Session } from "./session";
import { recordAudit, type AuditActor } from "@/modules/kernel/audit";
import { principalOf } from "@/modules/workspaces/session";

/**
 * What the owner console's Users page (/admin/users) may do to email + password
 * accounts. Callers must already have passed ownerGate. An admin can never
 * demote, un-admin, disable or delete their own account, and the last enabled
 * admin can't be deleted, so the console can't lock its last owner out.
 *
 * Password accounts are for the owner's own staff only (KAN-28): every account
 * stays an admin or a Platform operator. Customers sign in with SSO and a seat
 * (Admin → Customers), never with a password.
 */

export const STAFF_ONLY_MESSAGE =
  "Password accounts are only for your own staff: make it an admin or give it the Platform operator role. Customers sign in with single sign-on and a seat (Admin → Customers).";

export type AdminUserView = Omit<Account, "failed_attempts" | "locked_until"> & {
  locked: boolean;
  locked_until: string | null;
};

export function adminUserView(account: Account): AdminUserView {
  const { failed_attempts: _attempts, ...rest } = account;
  void _attempts;
  return { ...rest, locked: isLocked(account) };
}

export async function listAdminUsers(): Promise<AdminUserView[]> {
  return (await listAccounts()).map(adminUserView);
}

export type AdminUserAction =
  | { action: "create"; email: string; name: string; role?: string; actor_function?: string; is_admin?: boolean }
  | { action: "reset_password"; id: string }
  | { action: "set_role"; id: string; role: string }
  | { action: "set_admin"; id: string; is_admin: boolean }
  | { action: "verify"; id: string }
  | { action: "set_disabled"; id: string; disabled: boolean }
  | { action: "unlock"; id: string }
  | { action: "delete"; id: string };

export type AdminUserResult = { user: AdminUserView; temporary_password?: string; deleted?: boolean };

/** The admin's own account id when they signed in with a password, else null. */
function selfId(actor: Session | null): string | null {
  return actor?.provider_id === PASSWORD_PROVIDER ? actor.subject : null;
}

async function mustGet(id: unknown): Promise<Account> {
  const account = typeof id === "string" && id ? await getAccount(id) : null;
  if (!account) throw new AccountError("That account does not exist.", "not_found");
  return account;
}

/** What the audit log keeps of an account: never its password hash. */
function auditView(account: Account | null) {
  if (!account) return null;
  return {
    email: account.email,
    name: account.name,
    role: account.role,
    is_admin: account.is_admin,
    email_verified: account.email_verified,
    disabled: account.disabled,
    locked: isLocked(account),
  };
}

/** Who acted, for the audit log: the signed-in admin, or the label the caller gave. */
export function auditActorFor(by: { session: Session | null; label: string }): AuditActor {
  return by.session
    ? { principal: principalOf(by.session), name: by.session.actor.name, role: by.session.role }
    : { principal: by.label || "system", name: by.label || "Synapse", role: null };
}

/**
 * Runs one Users-page action and records it in the audit log (KAN-88) with the
 * account before and after, and how many of its sessions it ended. A password
 * is never logged, only that it was reset.
 */
export async function runAdminUserAction(
  input: Record<string, unknown>,
  by: { session: Session | null; label: string },
): Promise<AdminUserResult> {
  const action = String(input.action ?? "");
  const id = typeof input.id === "string" ? input.id : null;
  const before = id ? await getAccount(id) : null;
  const sessionsBefore = id ? await countPasswordSessions(id) : 0;
  const result = await applyAdminUserAction(input, by);
  const sessionsAfter = await countPasswordSessions(result.user.id);
  await recordAudit({
    category: "admin",
    action: `user.${action}`,
    entity_type: "user",
    entity_id: result.user.id,
    before: auditView(before),
    after: result.deleted ? null : auditView(await getAccount(result.user.id)),
    actor: auditActorFor(by),
    workspace_id: null,
    meta: {
      email: result.user.email,
      ...(action === "reset_password" ? { password_reset: true } : {}),
      ...(sessionsBefore > sessionsAfter ? { sessions_revoked: sessionsBefore - sessionsAfter } : {}),
    },
  });
  return result;
}

async function applyAdminUserAction(
  input: Record<string, unknown>,
  by: { session: Session | null; label: string },
): Promise<AdminUserResult> {
  const self = selfId(by.session);
  const action = String(input.action ?? "");
  switch (action) {
    case "create": {
      const role = typeof input.role === "string" && input.role ? input.role : "operator";
      if (!isRole(role)) throw new AccountError("Unknown role.");
      if (input.is_admin !== true && role !== "operator") throw new AccountError(STAFF_ONLY_MESSAGE);
      // createAccount's own message speaks to someone signing up; here an admin names someone else.
      if (typeof input.name !== "string" || !input.name.trim()) throw new AccountError("Enter the user's name.");
      const temporary_password = temporaryPassword();
      const account = await createAccount({
        email: String(input.email ?? ""),
        name: String(input.name ?? ""),
        password: temporary_password,
        actor_function: asActorFunction(input.actor_function),
        role,
        is_admin: input.is_admin === true,
        email_verified: true,
        created_by: by.label,
      });
      return { user: adminUserView(account), temporary_password };
    }
    case "reset_password": {
      const account = await mustGet(input.id);
      const temporary_password = temporaryPassword();
      await setPassword(account.id, temporary_password);
      await revokeAccountSessions(account.id, { except: by.session?.id });
      return { user: adminUserView((await getAccount(account.id))!), temporary_password };
    }
    case "set_role": {
      const account = await mustGet(input.id);
      const role = String(input.role ?? "");
      if (!isRole(role)) throw new AccountError("Unknown role.");
      if (account.id === self && role !== account.role) throw new AccountError("You can't change your own role.");
      if (!account.is_admin && role !== "operator") throw new AccountError(STAFF_ONLY_MESSAGE);
      const updated = await updateAccount(account.id, { role: role as Role });
      if (updated.role !== account.role) await revokeAccountSessions(account.id);
      return { user: adminUserView(updated) };
    }
    case "set_admin": {
      const account = await mustGet(input.id);
      const isAdmin = input.is_admin === true;
      if (account.id === self && !isAdmin) throw new AccountError("You can't remove your own admin access.");
      if (!isAdmin && account.role !== "operator") throw new AccountError(STAFF_ONLY_MESSAGE);
      const updated = await updateAccount(account.id, { is_admin: isAdmin, ...(isAdmin ? { email_verified: true } : {}) });
      return { user: adminUserView(updated) };
    }
    case "verify": {
      const account = await mustGet(input.id);
      const updated = await updateAccount(account.id, { email_verified: true });
      // Their next sign-in carries the verified email (and so matches invites).
      if (!account.email_verified) await revokeAccountSessions(account.id);
      return { user: adminUserView(updated) };
    }
    case "set_disabled": {
      const account = await mustGet(input.id);
      const disabled = input.disabled === true;
      if (account.id === self && disabled) throw new AccountError("You can't disable your own account.");
      const updated = await updateAccount(account.id, { disabled });
      if (disabled) await revokeAccountSessions(account.id);
      return { user: adminUserView(updated) };
    }
    case "unlock": {
      const account = await mustGet(input.id);
      await unlockAccount(account.id);
      return { user: adminUserView((await getAccount(account.id))!) };
    }
    case "delete": {
      const account = await mustGet(input.id);
      // Also by email: an admin signed in with SSO still owns their password account.
      const sameEmail = Boolean(by.session?.email) && normalizeEmail(by.session!.email!) === account.email;
      if (account.id === self || sameEmail) throw new AccountError("You can't delete your own account.");
      const deleted = await deleteAccount(account.id);
      return { user: adminUserView(deleted), deleted: true };
    }
    default:
      throw new AccountError(`Unknown action ${action || "(none)"}.`);
  }
}
