import type { ActorFunction } from "@/lib/iegp/enums";
import {
  AccountError,
  createAccount,
  findAccountByEmail,
  getAccountWithHash,
  isLocked,
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
import { createSession, type Session } from "./session";
import { signupAllowed } from "./signup-policy";

/**
 * Email + password sign-in, sign-up and password changes. A password session
 * is `provider_id = "password"`, `subject = <account id>`; it carries the email
 * only when the account's email is verified (an admin created or verified it),
 * so an unverified self-signup never matches an email invite or OWNER_EMAILS
 * (see principalOf in modules/workspaces/session.ts).
 */

export const INCORRECT_CREDENTIALS = "Email or password is incorrect.";
export const LOCKED_MESSAGE = "Too many failed attempts. This account is locked for 15 minutes; try again later.";
export const DISABLED_MESSAGE = "This account has been disabled. Contact your Synapse administrator.";
export const SIGNUP_CLOSED_MESSAGE =
  "Self sign-up is closed on this deployment. Ask your Synapse administrator for an account.";

export type PasswordLoginCode = "incorrect" | "locked" | "disabled" | "domain";

export class PasswordLoginError extends Error {
  constructor(
    readonly code: PasswordLoginCode,
    message: string,
  ) {
    super(message);
    this.name = "PasswordLoginError";
  }
}

export { signupAllowed };

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
  if (!account.is_admin && !emailDomainAllowed(account.email)) {
    throw new PasswordLoginError("domain", "Your email domain is not allowed to sign in to this deployment.");
  }
  await recordSuccessfulSignIn(account.id);
  return createSession(passwordSessionArgs(account));
}

/**
 * Self sign-up: a contributor with an unverified email, signed in at once.
 * Refused when ALLOW_SIGNUP=0 or the email is outside ALLOWED_EMAIL_DOMAINS.
 */
export async function signUpWithPassword(args: {
  name: string;
  email: string;
  actor_function: ActorFunction;
  password: string;
  confirm?: string;
}): Promise<{ account: Account; session: Session }> {
  if (!signupAllowed()) throw new AccountError(SIGNUP_CLOSED_MESSAGE);
  const email = String(args.email ?? "").trim().toLowerCase();
  if (email && !emailDomainAllowed(email)) {
    throw new AccountError("That email domain is not allowed to sign up on this deployment.");
  }
  if (args.confirm !== undefined && args.confirm !== args.password) {
    throw new AccountError("The passwords do not match.");
  }
  const account = await createAccount({
    email,
    name: String(args.name ?? ""),
    password: String(args.password ?? ""),
    actor_function: args.actor_function,
    role: "contributor",
    is_admin: false,
    email_verified: false,
    created_by: "self-signup",
  });
  await recordSuccessfulSignIn(account.id);
  return { account, session: await createSession(passwordSessionArgs(account)) };
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
