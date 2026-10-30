import { NextResponse } from "next/server";
import "@/modules";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { can } from "@/modules/auth/roles";
import { tacticRecord } from "@/lib/iegp/tactic-record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireCustomerContext();
    const { id } = await params;
    const record = await tacticRecord(id);
    if (!record) return NextResponse.json({ safe_error: true, error: "This tactic is no longer available in this workspace. Reload the page to see current records.", code: "not_found" }, { status: 404 });
    return NextResponse.json({ ...record, permissions: { edit: can(context.role, "ideate"), coverage: can(context.role, "validate") } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
