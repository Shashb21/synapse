import { NextResponse } from "next/server";
import { CustomerError } from "@/modules/auth/customers";
import { ownerAccess } from "@/modules/auth/owner";

const STATUS: Record<CustomerError["code"], number> = {
  invalid: 400,
  not_found: 404,
  seat_limit: 409,
  taken: 409,
  conflict: 409,
};

export const NO_STORE = { "cache-control": "no-store" };

/** The request body as a JSON object, or null. */
export async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function invalidJson(): NextResponse {
  return NextResponse.json({ error: "The request body must be a JSON object.", code: "invalid_json" }, { status: 400 });
}

export function customerErrorResponse(error: unknown, what: string): NextResponse {
  if (error instanceof CustomerError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
  }
  console.error(`admin customers: ${what} failed`, error instanceof Error ? error.message : error);
  return NextResponse.json({ error: "That did not work. Try again." }, { status: 500 });
}

/** Who is acting, for `assigned_by`: the owner's email, else their name. */
export async function actingLabel(): Promise<string> {
  const access = await ownerAccess();
  return access.email ?? access.actor.name;
}
