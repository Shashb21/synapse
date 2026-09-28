import {
  AccountError,
  asActorFunction,
  createAccount,
  getAccount,
  isLocked,
  listAccounts,
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

/**
 * What the owner console's Users page (/admin/users) may do to email + password
 * accounts. Callers must already have passed ownerGate. An admin can never
 * demote, un-admin or disable their own account, so the console can't lock
 * its last owner out.
 */

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
  | { action: "unlock"; id: string };

export type AdminUserResult = { user: AdminUserView; temporary_password?: string };

/** The admin's own account id when they signed in with a password, else null. */
function selfId(actor: Session | null): string | null {
  return actor?.provider_id === PASSWORD_PROVIDER ? actor.subject : null;
}

async function mustGet(id: unknown): Promise<Account> {
  const account = typeof id === "string" && id ? await getAccount(id) : null;
  if (!account) throw new AccountError("That account does not exist.", "not_found");
  return account;
}

export async function runAdminUserAction(
  input: Record<string, unknown>,
  by: { session: Session | null; label: string },
): Promise<AdminUserResult> {
  const self = selfId(by.session);
  const action = String(input.action ?? "");
  switch (action) {
    case "create": {
      const role = typeof input.role === "string" && input.role ? input.role : "contributor";
      if (!isRole(role)) throw new AccountError("Unknown role.");
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
      const updated = await updateAccount(account.id, { role: role as Role });
      if (updated.role !== account.role) await revokeAccountSessions(account.id);
      return { user: adminUserView(updated) };
    }
    case "set_admin": {
      const account = await mustGet(input.id);
      const isAdmin = input.is_admin === true;
      if (account.id === self && !isAdmin) throw new AccountError("You can't remove your own admin access.");
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
    default:
      throw new AccountError(`Unknown action ${action || "(none)"}.`);
  }
}
