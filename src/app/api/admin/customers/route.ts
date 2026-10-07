import { NextResponse } from "next/server";
import { createCustomer, listCustomers } from "@/modules/auth/customers";
import { ownerGate } from "@/modules/auth/owner";
import { customerErrorResponse, invalidJson, NO_STORE, readObject } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every customer with seats used / sold. Owner only. */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    return NextResponse.json({ customers: await listCustomers() }, { headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "list");
  }
}

/** `{ name, email_domains?, seats?, active? }` creates a customer. Owner only. */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const body = await readObject(request);
  if (!body) return invalidJson();
  try {
    const customer = await createCustomer(body);
    return NextResponse.json({ customer }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return customerErrorResponse(error, "create");
  }
}
