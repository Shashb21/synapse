import { NextResponse } from "next/server";
import { CustomerError, getCustomer, listSeats, updateCustomer } from "@/modules/auth/customers";
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
