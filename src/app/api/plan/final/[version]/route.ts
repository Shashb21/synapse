import { NextResponse } from "next/server";
import "@/modules";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { planVersion } from "@/modules/stages/s10-timeline/module";
import { finalPlanView } from "@/modules/stages/s10-timeline/final-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One saved plan version as JSON (KAN-86): the complete frozen IEGP for a final
 * saved since KAN-86, or the timeline-only legacy package for an older one.
 * Read only from what was frozen. Members of the workspace only; a version from
 * another workspace is simply not found (each workspace has its own plans).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ version: string }> }) {
  try {
    await requireCustomerContext();
    const { version } = await params;
    const number = Number(version);
    if (!Number.isInteger(number) || number < 1) {
      return NextResponse.json({ error: "A plan version is a whole number from 1.", code: "invalid_request" }, { status: 400 });
    }
    const record = await planVersion(number);
    if (!record) {
      return NextResponse.json({ error: `No saved plan v${number} in this workspace.`, code: "not_found" }, { status: 404 });
    }
    return NextResponse.json(finalPlanView(record), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `inline; filename="synapse-iegp-v${number}.json"`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
