import {
  AccountError,
  findAccountByEmail,
  getAccountWithHash,
  isLocked,
  isStaffAccount,
  PASSWORD_PROVIDER,
  recordFailedSignIn,
  recordSuccessfulSignIn,
  revokeAccountSessions,
  setPassword,
  type Account,
  type AccountWithHash,
} from "./accounts";
import { emailDomainAllowed } from "./idp";
import { dummyPasswordHash, MAX_PASSWORD_LENGTH, verifyPassword } from "./password";
import { createSession, testOnlyAddress, testSeatPasswordAllowed, type Session } from "./session";

/**
 * Email + password sign-in and password changes, for Synapse staff (KAN-28):
 * an account signs in only while it is an admin or has the operator role.
 * Customers sign in with SSO and a seat (modules/auth/customers.ts); the one
 * exception is a test customer account (KAN-59), whose email is on a test-only
 * domain and holds a seat. There is no self sign-up.
 *
 * A password session is `provider_id = "password"`, `subject = <account id>`;
 * it carries the email only when the account's email is verified, so an
 * unverified account never matches an email invite or OWNER_EMAILS (see
 * principalOf in modules/workspaces/session.ts).
 */

export const INCORRECT_CREDENTIALS = "Email or password is incorrect.";
export const LOCKED_MESSAGE = "Too many failed attempts. This account is locked for 15 minutes; try again later.";
export const DISABLED_MESSAGE = "This account has been disabled. Contact your Synapse administrator.";
/** A password account that is not Synapse staff (e.g. a pre-KAN-28 self sign-up). */
export const NOT_STAFF_MESSAGE =
  "Email and password sign-in is only for Synapse staff. Sign in with your organisation's single sign-on.";

/**
 * A test customer account (KAN-59) whose seat was removed or whose customer is
 * deactivated: it may be a customer, just not right now (KAN-68).
 */
export const NO_ACTIVE_SEAT_MESSAGE =
  "Your organisation's access to Synapse isn't active, or your seat was removed. Contact your Synapse administrator.";

export type PasswordLoginCode = "incorrect" | "locked" | "disabled" | "domain" | "not_staff";

export class PasswordLoginError extends Error {
  constructor(
    readonly code: PasswordLoginCode,
    message: string,
  ) {
    super(message);
    this.name = "PasswordLoginError";
  }
}

/** The session fields a password account signs in with. */
export function passwordSessionArgs(account: Account): Parameters<typeof createSession>[0] {
  return {
    provider_id: PASSWORD_PROVIDER,
    subject: account.id,
    email: account.email_verified ? account.email : null,
    actor_name: account.name,
    actor_function: account.actor_function,
    role: account.role,
  };
}

/**
 * Checks an email and password and opens a session. Unknown emails and wrong
 * passwords get the same message and cost the same (a dummy hash is checked).
 * A locked account is refused before its password is looked at; a disabled
 * one only after the correct password, so neither leaks to a guesser.
 */
export async function signInWithPassword(args: { email: string; password: string }): Promise<Session> {
  const email = typeof args.email === "string" ? args.email : "";
  const password = typeof args.password === "string" ? args.password.slice(0, MAX_PASSWORD_LENGTH + 1) : "";
  const account = email.trim() ? await findAccountByEmail(email) : null;
  if (!account) {
    await verifyPassword(password, await dummyPasswordHash());
    throw new PasswordLoginError("incorrect", INCORRECT_CREDENTIALS);
  }
  if (isLocked(account)) throw new PasswordLoginError("locked", LOCKED_MESSAGE);
  const ok = password.length > 0 && (await verifyPassword(password, account.password_hash));
  if (!ok) {
    const { locked } = await recordFailedSignIn(account.id);
    throw new PasswordLoginError(locked ? "locked" : "incorrect", locked ? LOCKED_MESSAGE : INCORRECT_CREDENTIALS);
  }
  if (account.disabled) throw new PasswordLoginError("disabled", DISABLED_MESSAGE);
  if (!isStaffAccount(account) && !(await testSeatPasswordAllowed(account))) {
    // A verified test-domain account is a test customer without an active seat right now.
    const testCustomer = account.email_verified && testOnlyAddress(account.email);
    throw new PasswordLoginError("not_staff", testCustomer ? NO_ACTIVE_SEAT_MESSAGE : NOT_STAFF_MESSAGE);
  }
  if (!account.is_admin && !emailDomainAllowed(account.email)) {
    throw new PasswordLoginError("domain", "Your email domain is not allowed to sign in to this deployment.");
  }
  await recordSuccessfulSignIn(account.id);
  return createSession(passwordSessionArgs(account));
}

/** The account behind a password session, or null for any other session. */
export async function accountForSession(
  session: Pick<Session, "provider_id" | "subject"> | null,
): Promise<AccountWithHash | null> {
  if (!session || session.provider_id !== PASSWORD_PROVIDER) return null;
  return getAccountWithHash(session.subject);
}

/** Changes a password; the current one must be right. Other sessions of the account end. */
export async function changeOwnPassword(args: {
  session: Session;
  current: string;
  next: string;
  confirm?: string;
}): Promise<void> {
  const account = await accountForSession(args.session);
  if (!account) throw new AccountError("Only an email and password account has a password to change.");
  if (!(await verifyPassword(String(args.current ?? ""), account.password_hash))) {
    throw new AccountError("Your current password is incorrect.");
  }
  if (args.confirm !== undefined && args.confirm !== args.next) throw new AccountError("The new passwords do not match.");
  if (args.current === args.next) throw new AccountError("Choose a password different from your current one.");
  await setPassword(account.id, String(args.next ?? ""));
  await revokeAccountSessions(account.id, { except: args.session.id });
}
