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
import { assignSeats, createCustomer, listCustomers, seatFor, type Customer } from "./customers";
import { passwordPolicyError } from "./password";
import { testOnlyAddress } from "./session";

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

/** The customer `npm run create-test-customer` sets up, and the email it uses by default. */
export const TEST_CUSTOMER_NAME = "Synapse Test";
export const TEST_CUSTOMER_EMAIL = "tester@synapse.test";

/**
 * The core of `npm run create-test-customer` (KAN-59): a real customer account
 * for testing, signing in with a password like the admin but holding a seat
 * like a customer. Creates (or reuses) the "Synapse Test" customer with one
 * seat, a non-staff password account for a test-only email, and assigns it the
 * seat. Run again to reset the password; existing sessions for it end.
 *
 * Refused for an email a real person could hold, for a staff account (it would
 * not be a customer), and for an email holding a seat at another customer.
 */
export async function ensureTestCustomer(args: {
  email?: string | null;
  password: string;
  name?: string | null;
  /** Tests use their own customer; the CLI always uses TEST_CUSTOMER_NAME. */
  customer_name?: string;
}): Promise<{ created: boolean; account: Account; customer: Customer }> {
  const customerName = args.customer_name ?? TEST_CUSTOMER_NAME;
  const email = normalizeEmail(args.email || TEST_CUSTOMER_EMAIL);
  if (!validEmail(email)) throw new AccountError("Enter a valid email address.");
  if (!testOnlyAddress(email)) {
    throw new AccountError(
      "A test customer's email must be on a test-only domain (such as name@synapse.test or name@example.com), so no real person can hold it.",
    );
  }
  const policy = passwordPolicyError(args.password, email);
  if (policy) throw new AccountError(policy);
  const name = args.name?.trim();

  const held = await seatFor(email);
  if (held && held.customer.name !== customerName) {
    throw new AccountError(`${email} already holds a seat at ${held.customer.name}. Use another test email.`);
  }

  const existing = await findAccountByEmail(email);
  if (existing && (existing.is_admin || existing.role === "operator")) {
    throw new AccountError(`${email} is a staff account, so it can't be the test customer. Use another test email.`);
  }

  const customer =
    held?.customer ??
    (await listCustomers()).find((row) => row.name === customerName) ??
    (await createCustomer({ name: customerName, seats: 1 }));
  if (!customer.active) throw new AccountError(`${customerName} is deactivated. Reactivate it in Admin → Customers first.`);

  let account: Account;
  let created = false;
  if (!existing) {
    account = await createAccount({
      email,
      name: name || "Synapse Tester",
      password: args.password,
      actor_function: "medical_affairs",
      role: "medical_affairs",
      is_admin: false,
      email_verified: true,
      created_by: "create-test-customer",
    });
    created = true;
  } else {
    await setPassword(existing.id, args.password);
    account = await updateAccount(existing.id, { ...(name ? { name } : {}), email_verified: true, disabled: false });
    await revokeAccountSessions(existing.id);
  }

  const seated = held ? customer : (await assignSeats({ customer_id: customer.id, emails: [email], by: "create-test-customer" })).customer;
  return { created, account, customer: seated };
}
