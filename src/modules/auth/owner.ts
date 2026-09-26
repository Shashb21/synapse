import { NextResponse } from "next/server";
import { forbidden } from "next/navigation";
import { cookies } from "next/headers";
import type { Actor } from "@/modules/kernel/contracts";
import { isAdminAccount, PASSWORD_PROVIDER } from "./accounts";
import { sessionContext } from "./session";
import { OWNER_ONLY_MESSAGE, ownerDecision, testOwnerBypass, type Role } from "./roles";

/**
 * Test-only cookie: under the LLM test stub a spec sets `synapse_test_as=customer`
 * to be treated as a customer rather than the owner. Ignored everywhere else.
 */
export const TEST_AS_CUSTOMER_COOKIE = "synapse_test_as";

export type OwnerAccess = {
  owner: boolean;
  reason: string;
  actor: Actor;
  role: Role;
  email: string | null;
  signed_in: boolean;
};

async function testOptOut(): Promise<boolean> {
  if (!testOwnerBypass()) return false;
  try {
    return (await cookies()).get(TEST_AS_CUSTOMER_COOKIE)?.value === "customer";
  } catch {
    return false;
  }
}

/** Whether the current request is the platform owner's. */
export async function ownerAccess(): Promise<OwnerAccess> {
  let context: Awaited<ReturnType<typeof sessionContext>>;
  try {
    context = await sessionContext();
  } catch {
    // Outside a request (unit tests calling a handler directly, scripts): only the
    // test bypass admits; anything else is refused.
    const owner = testOwnerBypass() && !(await testOptOut());
    return {
      owner,
      reason: owner ? "test stub outside a request" : "no session",
      actor: { name: "Anonymous", function: "medical_affairs" },
      role: "viewer",
      email: null,
      signed_in: false,
    };
  }
  const session = context.session;
  const admin_account =
    session?.provider_id === PASSWORD_PROVIDER ? await isAdminAccount(session.subject).catch(() => false) : false;
  const decision = ownerDecision(
    {
      admin_account,
      role: context.role,
      email: context.session?.email ?? null,
      signed_in: context.signed_in,
      demo: context.demo,
      provider_id: context.session?.provider_id ?? null,
    },
    { optOut: await testOptOut() },
  );
  return {
    ...decision,
    actor: context.actor,
    role: context.role,
    email: context.session?.email ?? null,
    signed_in: context.signed_in,
  };
}

/** For admin pages: renders the Owner only (403) page unless the owner is signed in. */
export async function requireOwnerPage(): Promise<OwnerAccess> {
  const access = await ownerAccess();
  if (!access.owner) forbidden();
  return access;
}

export function ownerOnlyJson(): NextResponse {
  return NextResponse.json({ code: "owner_only", error: OWNER_ONLY_MESSAGE }, { status: 403 });
}

/** For admin APIs: a 403 response for anyone but the owner, else null. */
export async function ownerGate(): Promise<NextResponse | null> {
  return (await ownerAccess()).owner ? null : ownerOnlyJson();
}
