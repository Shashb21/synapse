import { NextResponse } from "next/server";
import { assignSeats, listSeats, unassignSeat } from "@/modules/auth/customers";
import { ownerGate } from "@/modules/auth/owner";
import { actingLabel, customerErrorResponse, invalidJson, NO_STORE, readObject } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * `{ emails }` (an array, or pasted text separated by commas, spaces or new
 * lines) assigns seats, all or nothing: refused (409) past the seat limit with
 * how many remain, or when an email holds a seat at another customer; refused
 * (400) for an email off the customer's domains. Owner only.
 */
export async function POST(request: Request, { params }: Context) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = await readObject(request);
  if (!body) return invalidJson();
  try {
    const { id } = await params;
    const result = await assignSeats({ customer_id: id, emails: body.emails ?? body.email, by: await actingLabel() });
    return NextResponse.json({ ...result, seats: await listSeats(id) }, { headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "assign");
  }
}

/** `{ email }` unassigns a seat; that person's SSO sessions end at once. Owner only. */
export async function DELETE(request: Request, { params }: Context) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = await readObject(request);
  if (!body) return invalidJson();
  try {
    const { id } = await params;
    const customer = await unassignSeat({ customer_id: id, email: String(body.email ?? "") });
    return NextResponse.json({ customer, seats: await listSeats(id) }, { headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "unassign");
  }
}
