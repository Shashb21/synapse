import { NextResponse } from "next/server";
import { SplitError } from "@/accuracy/store/partial-split-store";
import { labRequestErrorResponse } from "@/app/api/accuracy/_lib/request";
/** Unexpected persistence failures stay server errors and never expose SQL/claim contents. */
export function splitErrorResponse(error: unknown) {
  const known = labRequestErrorResponse(error);
  if (known) return known;
  if (error instanceof SplitError) {
    const status = ["unknown_gap", "unknown_operation"].includes(error.code) ? 404
      : ["stale_revision", "operation_conflict", "rollback_blocked", "ineligible_parent"].includes(error.code) ? 409 : 400;
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
  }
  return NextResponse.json({ ok: false, error: "Split action failed" }, { status: 500 });
}
