import { NextResponse } from "next/server";
import { ownerGate } from "@/modules/auth/owner";
import { AUDIT_EXPORT_LIMIT, AUDIT_PAGE_SIZE, auditCsv, auditFilterFrom, listAuditEvents } from "@/modules/kernel/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The platform audit log (KAN-87), owner only. `format=csv` or `format=json`
 * downloads every matching event (up to 10,000, newest first); without it the
 * response is one page of JSON for the console.
 */
export async function GET(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const url = new URL(request.url);
  const filter = auditFilterFrom(url.searchParams);
  const format = url.searchParams.get("format");
  if (format === "csv" || format === "json") {
    const { events, total } = await listAuditEvents(filter, { limit: AUDIT_EXPORT_LIMIT });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const headers = {
      "content-disposition": `attachment; filename="synapse-audit-${stamp}.${format}"`,
      "cache-control": "no-store",
      "x-audit-total": String(total),
      "x-audit-exported": String(events.length),
    };
    if (format === "csv") {
      return new NextResponse(auditCsv(events), { headers: { ...headers, "content-type": "text/csv; charset=utf-8" } });
    }
    return NextResponse.json({ filter, total, exported: events.length, events }, { headers });
  }
  const page = Number(url.searchParams.get("page") ?? "1") || 1;
  const { events, total } = await listAuditEvents(filter, { page, limit: AUDIT_PAGE_SIZE });
  return NextResponse.json(
    { filter, page, page_size: AUDIT_PAGE_SIZE, total, events },
    { headers: { "cache-control": "no-store" } },
  );
}
