import {
  AccountError,
  createAccount,
  findAccountByEmail,
  normalizeEmail,
  revokeAccountSessions,
  setPassword,
  updateAccount,
  validEmail,
  type Account,
} from "./accounts";
import { passwordPolicyError } from "./password";

/**
 * The core of `npm run create-admin` (scripts/create-admin.ts), kept here so it
 * is testable: creates the admin account, or — when the email already has an
 * account — makes it an admin and resets its password. Either way the account
 * ends up admin, email-verified, role "operator", enabled and unlocked, and any
 * existing sessions for it end.
 */
export async function ensureAdminAccount(args: {
  email: string;
  password: string;
  name?: string | null;
}): Promise<{ created: boolean; account: Account }> {
  const email = normalizeEmail(args.email ?? "");
  if (!validEmail(email)) throw new AccountError("Enter a valid email address.");
  const policy = passwordPolicyError(args.password, email);
  if (policy) throw new AccountError(policy);
  const name = args.name?.trim();

  const existing = await findAccountByEmail(email);
  if (!existing) {
    const account = await createAccount({
      email,
      name: name || "Administrator",
      password: args.password,
      actor_function: "medical_affairs",
      role: "operator",
      is_admin: true,
      email_verified: true,
      created_by: "create-admin",
    });
    return { created: true, account };
  }

  await setPassword(existing.id, args.password);
  const account = await updateAccount(existing.id, {
    ...(name ? { name } : {}),
    role: "operator",
    is_admin: true,
    email_verified: true,
    disabled: false,
  });
  await revokeAccountSessions(existing.id);
  return { created: false, account };
}
