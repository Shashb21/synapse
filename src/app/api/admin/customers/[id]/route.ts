import { NextResponse } from "next/server";
import { CustomerError, deleteCustomer, getCustomer, listSeats, updateCustomer } from "@/modules/auth/customers";
import { ownerGate } from "@/modules/auth/owner";
import { customerErrorResponse, invalidJson, NO_STORE, readObject } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** One customer and its seat list. Owner only. */
export async function GET(_request: Request, { params }: Context) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const { id } = await params;
    const customer = await getCustomer(id);
    if (!customer) throw new CustomerError("That customer does not exist.", "not_found");
    return NextResponse.json({ customer, seats: await listSeats(id) }, { headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "read");
  }
}

/**
 * `{ name?, email_domains?, seats?, active? }` edits a customer. Lowering seats
 * below those assigned is refused (409); deactivating ends every seat holder's
 * sessions. Owner only.
 */
export async function PATCH(request: Request, { params }: Context) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = await readObject(request);
  if (!body) return invalidJson();
  try {
    const { id } = await params;
    const customer = await updateCustomer(id, body);
    return NextResponse.json({ customer, seats: await listSeats(id) }, { headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "update");
  }
}

/**
 * Deletes a customer and its seats; every seat holder's sessions end at once
 * (KAN-63). Owner only.
 */
export async function DELETE(_request: Request, { params }: Context) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const { id } = await params;
    const { customer, seats_removed } = await deleteCustomer(id);
    return NextResponse.json({ ok: true, customer, seats_removed: seats_removed.length }, { headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "delete");
  }
}
