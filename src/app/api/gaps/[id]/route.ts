import { NextResponse } from "next/server";
import "@/modules";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { gapRecord } from "@/lib/iegp/gap-record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything about one gap, as JSON (KAN-97): its wording and details, the
 * objective, who confirmed it, its needs with sources and provenance, mappings,
 * priority, ideas, timeline, groups, suggestions, leftovers, versions and
 * history. Members of the workspace only.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCustomerContext();
    const { id } = await params;
    const record = await gapRecord(id);
    if (!record) return NextResponse.json({ error: `No gap ${id} in this workspace.`, code: "not_found" }, { status: 404 });
    return NextResponse.json(record, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
