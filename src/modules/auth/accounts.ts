import { randomBytes } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import * as t from "@/modules/kernel/schema";
import { nowIso } from "@/modules/kernel/ids";
import { ACTOR_FUNCTIONS, type ActorFunction } from "@/lib/iegp/enums";
import { isRole, type Role } from "./roles";
import { hashPassword, passwordPolicyError } from "./password";

/**
 * Email + password accounts (shared, public schema). One row per person who
 * signs in with a password; SSO users never get a row. The password is stored
 * only as an scrypt hash (modules/auth/password.ts).
 */

export const PASSWORD_PROVIDER = "password";
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS user_accounts (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    actor_function text NOT NULL,
    role text NOT NULL,
    password_hash text NOT NULL,
    is_admin boolean NOT NULL DEFAULT false,
    email_verified boolean NOT NULL DEFAULT false,
    disabled boolean NOT NULL DEFAULT false,
    failed_attempts integer NOT NULL DEFAULT 0,
    locked_until text,
    last_sign_in_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    created_by text NOT NULL
  )`,
];

export type Account = {
  id: string;
  email: string;
  name: string;
  actor_function: ActorFunction;
  role: Role;
  is_admin: boolean;
  email_verified: boolean;
  disabled: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
};

/** An account with its hash: only the sign-in and password-change paths read this. */
export type AccountWithHash = Account & { password_hash: string };

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  ready ??= (async () => {
    // Skip the DDL when the table exists, so Postgres does not log "already exists" notices.
    const found = (await sharedDb().execute(sql`select to_regclass('user_accounts') as t`)) as unknown as Row[];
    if (found[0]?.t) return;
    for (const stmt of DDL) await sharedDb().execute(sql.raw(stmt));
  })().catch((error) => {
    ready = null; // a failed attempt is forgotten, so the next call retries
    throw error;
  });
  return ready;
}

type Row = Record<string, unknown>;
async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  await ensureTables();
  return (await sharedDb().execute(query)) as unknown as Row[];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254;
}

export function asActorFunction(value: unknown): ActorFunction {
  return ACTOR_FUNCTIONS.includes(value as ActorFunction) ? (value as ActorFunction) : "medical_affairs";
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toAccount(row: Row): Account {
  const role = String(row.role);
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    actor_function: asActorFunction(row.actor_function),
    role: isRole(role) ? role : "contributor",
    is_admin: row.is_admin === true,
    email_verified: row.email_verified === true,
    disabled: row.disabled === true,
    failed_attempts: Number(row.failed_attempts ?? 0),
    locked_until: nullable(row.locked_until),
    last_sign_in_at: nullable(row.last_sign_in_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    created_by: String(row.created_by),
  };
}

function withHash(row: Row): AccountWithHash {
  return { ...toAccount(row), password_hash: String(row.password_hash) };
}

export function isLocked(account: Pick<Account, "locked_until">, now = Date.now()): boolean {
  return Boolean(account.locked_until && Date.parse(account.locked_until) > now);
}

export async function findAccountByEmail(email: string): Promise<AccountWithHash | null> {
  const found = await rows(sql`select * from user_accounts where email = ${normalizeEmail(email)} limit 1`);
  return found[0] ? withHash(found[0]) : null;
}

export async function getAccountWithHash(id: string): Promise<AccountWithHash | null> {
  const found = await rows(sql`select * from user_accounts where id = ${id} limit 1`);
  return found[0] ? withHash(found[0]) : null;
}

export async function getAccount(id: string): Promise<Account | null> {
  const found = await getAccountWithHash(id);
  if (!found) return null;
  const { password_hash: _hash, ...account } = found;
  void _hash;
  return account;
}

export async function listAccounts(): Promise<Account[]> {
  const found = await rows(sql`select * from user_accounts order by created_at asc`);
  return found.map(toAccount);
}

/** Whether this password session's account is an enabled admin (the owner check). */
export async function isAdminAccount(accountId: string): Promise<boolean> {
  const found = await rows(sql`select is_admin, disabled from user_accounts where id = ${accountId} limit 1`);
  return found[0]?.is_admin === true && found[0]?.disabled !== true;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "exists" | "not_found" = "invalid",
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/** Creates an account. Throws AccountError on invalid input or a taken email. */
export async function createAccount(args: {
  email: string;
  name: string;
  password: string;
  actor_function?: ActorFunction;
  role?: Role;
  is_admin?: boolean;
  email_verified?: boolean;
  created_by: string;
}): Promise<Account> {
  const email = normalizeEmail(args.email);
  if (!validEmail(email)) throw new AccountError("Enter a valid email address.");
  const name = args.name.trim().slice(0, 120);
  if (!name) throw new AccountError("Enter your name.");
  const policy = passwordPolicyError(args.password, email);
  if (policy) throw new AccountError(policy);
  if (await findAccountByEmail(email)) throw new AccountError("An account with this email already exists.", "exists");
  const id = `acct_${randomBytes(12).toString("base64url")}`;
  const now = nowIso();
  const hash = await hashPassword(args.password);
  try {
    await rows(sql`
      insert into user_accounts (id, email, name, actor_function, role, password_hash, is_admin, email_verified,
        disabled, failed_attempts, locked_until, last_sign_in_at, created_at, updated_at, created_by)
      values (${id}, ${email}, ${name}, ${asActorFunction(args.actor_function)}, ${args.role ?? "contributor"},
        ${hash}, ${args.is_admin === true}, ${args.email_verified === true}, false, 0, null, null,
        ${now}, ${now}, ${args.created_by})`);
  } catch (error) {
    if (/unique|duplicate/i.test(String((error as Error)?.message))) {
      throw new AccountError("An account with this email already exists.", "exists");
    }
    throw error;
  }
  return (await getAccount(id))!;
}

/** Sets a new password (policy-checked) and clears any lockout. */
export async function setPassword(accountId: string, password: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) throw new AccountError("That account does not exist.", "not_found");
  const policy = passwordPolicyError(password, account.email);
  if (policy) throw new AccountError(policy);
  const hash = await hashPassword(password);
  await rows(sql`
    update user_accounts set password_hash = ${hash}, failed_attempts = 0, locked_until = null, updated_at = ${nowIso()}
    where id = ${accountId}`);
}

export type AccountPatch = Partial<Pick<Account, "name" | "role" | "is_admin" | "email_verified" | "disabled" | "actor_function">>;

export async function updateAccount(accountId: string, patch: AccountPatch): Promise<Account> {
  const account = await getAccount(accountId);
  if (!account) throw new AccountError("That account does not exist.", "not_found");
  const next = { ...account, ...patch };
  if (!next.name.trim()) throw new AccountError("Enter a name.");
  if (!isRole(next.role)) throw new AccountError("Unknown role.");
  await rows(sql`
    update user_accounts set name = ${next.name.trim().slice(0, 120)}, role = ${next.role}, is_admin = ${next.is_admin},
      email_verified = ${next.email_verified}, disabled = ${next.disabled},
      actor_function = ${asActorFunction(next.actor_function)}, updated_at = ${nowIso()}
    where id = ${accountId}`);
  return (await getAccount(accountId))!;
}

/** Clears failed attempts and any lock. */
export async function unlockAccount(accountId: string): Promise<void> {
  await rows(sql`
    update user_accounts set failed_attempts = 0, locked_until = null, updated_at = ${nowIso()} where id = ${accountId}`);
}

/** Counts a failed sign-in; the MAX_FAILED_ATTEMPTS-th locks the account for LOCKOUT_MS. */
export async function recordFailedSignIn(accountId: string, now = Date.now()): Promise<{ locked: boolean }> {
  const found = await rows(sql`
    update user_accounts set failed_attempts = failed_attempts + 1 where id = ${accountId}
    returning failed_attempts`);
  const attempts = Number(found[0]?.failed_attempts ?? 0);
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const until = new Date(now + LOCKOUT_MS).toISOString();
    await rows(sql`update user_accounts set locked_until = ${until}, failed_attempts = 0 where id = ${accountId}`);
    return { locked: true };
  }
  return { locked: false };
}

export async function recordSuccessfulSignIn(accountId: string): Promise<void> {
  await rows(sql`
    update user_accounts set failed_attempts = 0, locked_until = null, last_sign_in_at = ${nowIso()}
    where id = ${accountId}`);
}

/**
 * Ends an account's password sessions (after a reset, a role change or
 * disabling it), so the change applies at once rather than at next sign-in.
 */
export async function revokeAccountSessions(accountId: string, options: { except?: string } = {}): Promise<void> {
  await ensurePlatformSchema();
  const match = and(eq(t.authSessions.provider_id, PASSWORD_PROVIDER), eq(t.authSessions.subject, accountId));
  await sharedDb()
    .delete(t.authSessions)
    .where(options.except ? and(match, ne(t.authSessions.id, options.except)) : match);
}

/** Test helper: removes accounts whose email matches the LIKE pattern. */
export async function deleteAccountsLike(pattern: string): Promise<void> {
  await rows(sql`delete from user_accounts where email like ${pattern}`);
}
