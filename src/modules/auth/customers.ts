import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { ensurePlatformSchema, sharedDb } from "@/modules/kernel/db";
import { nowIso } from "@/modules/kernel/ids";
import { normalizeEmail, validEmail } from "./accounts";

/**
 * Customers and their seats (KAN-28). The owner sells a customer a number of
 * seats and assigns them, one email each; only a seat holder on an active
 * customer may sign in with SSO (see `seatAllowsSignIn` and the check in
 * modules/auth/session.ts). Shared, public-schema tables:
 *
 * - `customers`: `seats` is what was sold; assignments never exceed it.
 * - `seat_assignments`: one row per email (lower case), unique across every
 *   customer, so one person can't hold seats at two customers.
 *
 * Unassigning a seat, deactivating a customer or deleting one ends the
 * affected SSO sessions at once.
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY,
    name text NOT NULL,
    email_domains text[] NOT NULL DEFAULT '{}',
    seats integer NOT NULL DEFAULT 0 CHECK (seats >= 0),
    active boolean NOT NULL DEFAULT true,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS seat_assignments (
    customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email text PRIMARY KEY CHECK (email = lower(email)),
    assigned_by text NOT NULL,
    assigned_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS seat_assignments_customer ON seat_assignments (customer_id)`,
];

/** Most seats one customer can be sold, and most emails one bulk paste may assign. */
export const MAX_SEATS = 100_000;
export const MAX_BULK_EMAILS = 500;

export type Customer = {
  id: string;
  name: string;
  email_domains: string[];
  seats: number;
  seats_used: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type SeatAssignment = { customer_id: string; email: string; assigned_by: string; assigned_at: string };

export class CustomerError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not_found" | "seat_limit" | "taken" | "conflict" = "invalid",
  ) {
    super(message);
    this.name = "CustomerError";
  }
}

type Row = Record<string, unknown>;

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  ready ??= (async () => {
    const found = (await sharedDb().execute(
      sql`select to_regclass('customers') as c, to_regclass('seat_assignments') as s`,
    )) as unknown as Row[];
    if (found[0]?.c && found[0]?.s) return;
    for (const stmt of DDL) await sharedDb().execute(sql.raw(stmt));
  })().catch((error) => {
    ready = null; // a failed attempt is forgotten, so the next call retries
    throw error;
  });
  return ready;
}

async function rows(query: SQL): Promise<Row[]> {
  await ensureTables();
  return (await sharedDb().execute(query)) as unknown as Row[];
}

function list(values: string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** A text[] literal for domains (validated: no commas or braces). */
function textArray(values: string[]): SQL {
  return values.length ? sql`string_to_array(${values.join(",")}, ',')` : sql`'{}'::text[]`;
}

function toCustomer(row: Row): Customer {
  return {
    id: String(row.id),
    name: String(row.name),
    email_domains: Array.isArray(row.email_domains) ? (row.email_domains as unknown[]).map(String) : [],
    seats: Number(row.seats ?? 0),
    seats_used: Number(row.seats_used ?? 0),
    active: row.active === true,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toAssignment(row: Row): SeatAssignment {
  return {
    customer_id: String(row.customer_id),
    email: String(row.email),
    assigned_by: String(row.assigned_by),
    assigned_at: String(row.assigned_at),
  };
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                 */
/* ------------------------------------------------------------------------- */

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Parses domains from a list or a comma/space/newline-separated string. Throws on a bad one. */
export function parseDomains(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(/[\s,;]+/) : [];
  const domains = [...new Set(raw.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  const bad = domains.find((d) => !DOMAIN.test(d));
  if (bad) throw new CustomerError(`"${bad}" is not a valid email domain.`);
  if (domains.length > 50) throw new CustomerError("A customer can have at most 50 email domains.");
  return domains;
}

function parseSeats(input: unknown): number {
  const seats = typeof input === "string" && input.trim() ? Number(input) : input;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 0) {
    throw new CustomerError("Seats must be a whole number, 0 or more.");
  }
  if (seats > MAX_SEATS) throw new CustomerError(`Seats can be at most ${MAX_SEATS.toLocaleString("en")}.`);
  return seats;
}

function parseName(input: unknown): string {
  const name = typeof input === "string" ? input.trim().slice(0, 120) : "";
  if (name.length < 2) throw new CustomerError("Give the customer a name.");
  return name;
}

/** Only a real boolean: a string such as "true" is refused, not read as false. */
function parseActive(input: unknown): boolean {
  if (typeof input !== "boolean") throw new CustomerError("active must be true or false.");
  return input;
}

/**
 * Splits a pasted list (commas, semicolons, whitespace, newlines) into
 * lower-cased, de-duplicated emails. A `Name <a@b.co>` entry keeps the address.
 */
export function parseEmailList(input: unknown): string[] {
  const chunks = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(/[,;\n\r]+/) : [];
  const raw = chunks.flatMap((chunk) => {
    const bracketed = /<([^<>]+)>/.exec(chunk);
    return bracketed ? [bracketed[1]] : chunk.split(/\s+/);
  });
  return [...new Set(raw.map(normalizeEmail).filter(Boolean))];
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** Whether `email` may hold a seat at a customer with these domains (any, when none are set). */
export function emailMatchesDomains(email: string, domains: string[]): boolean {
  return domains.length === 0 || domains.includes(emailDomain(email));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ------------------------------------------------------------------------- */
/* Reads                                                                      */
/* ------------------------------------------------------------------------- */

const SELECT_CUSTOMER = sql`
  select c.*, (select count(*)::int from seat_assignments s where s.customer_id = c.id) as seats_used
  from customers c`;

export async function listCustomers(): Promise<Customer[]> {
  const found = await rows(sql`${SELECT_CUSTOMER} order by lower(c.name) asc, c.created_at asc`);
  return found.map(toCustomer);
}

export async function getCustomer(id: string): Promise<Customer | null> {
  const found = await rows(sql`${SELECT_CUSTOMER} where c.id = ${id} limit 1`);
  return found[0] ? toCustomer(found[0]) : null;
}

export async function listSeats(customerId: string): Promise<SeatAssignment[]> {
  const found = await rows(sql`
    select * from seat_assignments where customer_id = ${customerId} order by assigned_at asc, email asc`);
  return found.map(toAssignment);
}

/** The customer holding a seat for this email, if any. */
export async function seatFor(email: string): Promise<{ assignment: SeatAssignment; customer: Customer } | null> {
  const found = await rows(sql`select * from seat_assignments where email = ${normalizeEmail(email)} limit 1`);
  if (!found[0]) return null;
  const assignment = toAssignment(found[0]);
  const customer = await getCustomer(assignment.customer_id);
  return customer ? { assignment, customer } : null;
}

/**
 * The seat check behind SSO sign-in and every session lookup: this verified
 * email holds a seat on an active customer. One indexed query.
 */
export async function hasActiveSeat(email: string | null | undefined): Promise<boolean> {
  const address = email ? normalizeEmail(email) : "";
  if (!address) return false;
  const found = await rows(sql`
    select 1 as ok from seat_assignments s join customers c on c.id = s.customer_id
    where s.email = ${address} and c.active limit 1`);
  return Boolean(found[0]);
}

/* ------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* ------------------------------------------------------------------------- */

/** Providers that never need a seat: staff passwords and development-only demo sign-in. */
export const SEATLESS_PROVIDERS = ["password", "demo"];

/**
 * Ends the SSO sessions of these emails at once (after unassigning a seat or
 * deactivating the customer). Password and demo sessions are left alone.
 */
export async function revokeSeatSessions(emails: string[]): Promise<number> {
  const addresses = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (addresses.length === 0) return 0;
  await ensurePlatformSchema();
  const gone = (await sharedDb().execute(sql`
    delete from auth_sessions
    where lower(email) in (${list(addresses)}) and provider_id not in (${list(SEATLESS_PROVIDERS)})
    returning id`)) as unknown as Row[];
  return gone.length;
}

/* ------------------------------------------------------------------------- */
/* Writes                                                                     */
/* ------------------------------------------------------------------------- */

export type CustomerInput = { name?: unknown; email_domains?: unknown; seats?: unknown; active?: unknown };

type Tx = Parameters<Parameters<ReturnType<typeof sharedDb>["transaction"]>[0]>[0];

/**
 * Refuses a name another customer already has, ignoring case. The lock
 * serialises creates and renames, so two at once can't both pass the check.
 */
async function assertNameFree(tx: Tx, name: string, exceptId: string | null): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('customers.name'))`);
  const taken = (await tx.execute(sql`
    select name from customers where lower(name) = lower(${name})
    ${exceptId ? sql`and id <> ${exceptId}` : sql``} limit 1`)) as unknown as Row[];
  if (taken[0]) {
    throw new CustomerError(`A customer named "${String(taken[0].name)}" already exists. Pick another name.`, "conflict");
  }
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const name = parseName(input.name);
  const domains = parseDomains(input.email_domains);
  const seats = parseSeats(input.seats ?? 0);
  const active = input.active === undefined ? true : parseActive(input.active);
  const id = `cust_${randomBytes(9).toString("base64url")}`;
  const now = nowIso();
  await ensureTables();
  await sharedDb().transaction(async (tx) => {
    await assertNameFree(tx, name, null);
    await tx.execute(sql`
      insert into customers (id, name, email_domains, seats, active, created_at, updated_at)
      values (${id}, ${name}, ${textArray(domains)}, ${seats}, ${active}, ${now}, ${now})`);
  });
  return (await getCustomer(id))!;
}

/**
 * Edits a customer. Refuses to lower seats below those assigned, or to set
 * domains that some assigned email is outside. Deactivating ends every seat
 * holder's sessions at once; reactivating lets them sign in again.
 */
export async function updateCustomer(id: string, input: CustomerInput): Promise<Customer> {
  await ensureTables();
  const deactivated = await sharedDb().transaction(async (tx) => {
    const locked = (await tx.execute(sql`select * from customers where id = ${id} for update`)) as unknown as Row[];
    if (!locked[0]) throw new CustomerError("That customer does not exist.", "not_found");
    const current = toCustomer(locked[0]);
    const name = input.name === undefined ? current.name : parseName(input.name);
    const domains = input.email_domains === undefined ? current.email_domains : parseDomains(input.email_domains);
    const seats = input.seats === undefined ? current.seats : parseSeats(input.seats);
    const active = input.active === undefined ? current.active : parseActive(input.active);
    if (name.toLowerCase() !== current.name.toLowerCase()) await assertNameFree(tx, name, id);
    const assigned = ((await tx.execute(
      sql`select email from seat_assignments where customer_id = ${id} order by email`,
    )) as unknown as Row[]).map((row) => String(row.email));
    if (seats < assigned.length) {
      throw new CustomerError(
        `${current.name} has ${plural(assigned.length, "seat")} assigned, so seats can't go below ${assigned.length}. Unassign ${plural(assigned.length - seats, "seat")} first.`,
        "conflict",
      );
    }
    const outside = assigned.filter((email) => !emailMatchesDomains(email, domains));
    if (outside.length > 0) {
      throw new CustomerError(
        `${plural(outside.length, "assigned email")} would be outside these domains (${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ", …" : ""}). Unassign them first, or keep their domain.`,
        "conflict",
      );
    }
    await tx.execute(sql`
      update customers set name = ${name}, email_domains = ${textArray(domains)}, seats = ${seats}, active = ${active},
        updated_at = ${nowIso()}
      where id = ${id}`);
    return current.active && !active ? assigned : [];
  });
  if (deactivated.length > 0) await revokeSeatSessions(deactivated);
  return (await getCustomer(id))!;
}

export type AssignResult = { assigned: string[]; already: string[]; customer: Customer };

/**
 * Assigns seats to one or more emails, all or nothing. Every email must be
 * valid, on one of the customer's domains (when set) and not hold a seat at
 * another customer; emails already on this customer are skipped. Refused when
 * the new ones don't fit in the seats that remain.
 */
export async function assignSeats(args: { customer_id: string; emails: unknown; by: string }): Promise<AssignResult> {
  const emails = parseEmailList(args.emails);
  if (emails.length === 0) throw new CustomerError("Enter at least one email address.");
  if (emails.length > MAX_BULK_EMAILS) {
    throw new CustomerError(`Paste at most ${MAX_BULK_EMAILS} emails at a time.`);
  }
  const invalid = emails.filter((email) => !validEmail(email));
  if (invalid.length > 0) {
    throw new CustomerError(`Not a valid email address: ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? ", …" : ""}.`);
  }
  await ensureTables();
  const result = await sharedDb().transaction(async (tx) => {
    // Locking the customer row serialises concurrent assignments, so the limit holds.
    const locked = (await tx.execute(
      sql`select * from customers where id = ${args.customer_id} for update`,
    )) as unknown as Row[];
    if (!locked[0]) throw new CustomerError("That customer does not exist.", "not_found");
    const customer = toCustomer(locked[0]);
    const outside = emails.filter((email) => !emailMatchesDomains(email, customer.email_domains));
    if (outside.length > 0) {
      throw new CustomerError(
        `${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""} ${outside.length === 1 ? "is" : "are"} not on ${customer.name}'s email domains (${customer.email_domains.join(", ")}).`,
      );
    }
    const held = (await tx.execute(sql`
      select email, customer_id from seat_assignments where email in (${list(emails)})`)) as unknown as Row[];
    const elsewhere = held.filter((row) => String(row.customer_id) !== customer.id).map((row) => String(row.email));
    if (elsewhere.length > 0) {
      throw new CustomerError(
        `${elsewhere.slice(0, 5).join(", ")}${elsewhere.length > 5 ? ", …" : ""} already ${elsewhere.length === 1 ? "holds a seat" : "hold seats"} at another customer. One person can hold only one seat.`,
        "taken",
      );
    }
    const already = held.filter((row) => String(row.customer_id) === customer.id).map((row) => String(row.email));
    const fresh = emails.filter((email) => !already.includes(email));
    const used = Number(
      ((await tx.execute(sql`select count(*)::int as n from seat_assignments where customer_id = ${customer.id}`)) as unknown as Row[])[0]?.n ?? 0,
    );
    const remaining = Math.max(0, customer.seats - used);
    if (fresh.length > remaining) {
      throw new CustomerError(
        `${customer.name} has ${plural(remaining, "seat")} remaining (${used} of ${customer.seats} assigned), so ${plural(fresh.length, "new email")} can't be assigned. Nothing was assigned. Add seats, or assign fewer.`,
        "seat_limit",
      );
    }
    const at = nowIso();
    for (const email of fresh) {
      await tx.execute(sql`
        insert into seat_assignments (customer_id, email, assigned_by, assigned_at)
        values (${customer.id}, ${email}, ${args.by}, ${at})`);
    }
    return { assigned: fresh, already };
  }).catch((error: unknown) => {
    // A concurrent assignment of the same email to another customer loses the race on the primary key.
    if (!(error instanceof CustomerError) && /unique|duplicate/i.test(String((error as Error)?.message))) {
      throw new CustomerError("One of those emails was just assigned a seat elsewhere. Try again.", "taken");
    }
    throw error;
  });
  return { ...result, customer: (await getCustomer(args.customer_id))! };
}

/** Removes a seat; that person's SSO sessions end at once. */
export async function unassignSeat(args: { customer_id: string; email: string }): Promise<Customer> {
  const email = normalizeEmail(String(args.email ?? ""));
  const gone = await rows(sql`
    delete from seat_assignments where customer_id = ${args.customer_id} and email = ${email} returning email`);
  if (!gone[0]) throw new CustomerError("That email does not hold a seat at this customer.", "not_found");
  await revokeSeatSessions([email]);
  const customer = await getCustomer(args.customer_id);
  if (!customer) throw new CustomerError("That customer does not exist.", "not_found");
  return customer;
}

/**
 * Deletes a customer and its seats. Every seat holder's SSO sessions end at
 * once; a test customer's password session fails its per-request seat check
 * (sessionStillAllowed in modules/auth/session.ts) from the next request.
 */
export async function deleteCustomer(id: string): Promise<{ customer: Customer; seats_removed: string[] }> {
  const customer = await getCustomer(id);
  if (!customer) throw new CustomerError("That customer does not exist.", "not_found");
  const emails = await sharedDb().transaction(async (tx) => {
    const locked = (await tx.execute(sql`select id from customers where id = ${id} for update`)) as unknown as Row[];
    if (!locked[0]) throw new CustomerError("That customer does not exist.", "not_found");
    const held = ((await tx.execute(
      sql`delete from seat_assignments where customer_id = ${id} returning email`,
    )) as unknown as Row[]).map((row) => String(row.email));
    await tx.execute(sql`delete from customers where id = ${id}`);
    return held;
  });
  await revokeSeatSessions(emails);
  return { customer, seats_removed: emails };
}

/** Test helper: removes customers whose name matches the LIKE pattern (their seats go with them). */
export async function deleteCustomersLike(pattern: string): Promise<void> {
  await rows(sql`delete from customers where name like ${pattern}`);
}
