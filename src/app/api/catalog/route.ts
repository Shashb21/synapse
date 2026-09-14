import { dashboardView, decideCatalogProposal, getState } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const state = await getState();
  return NextResponse.json({
    catalog: state.catalog,
    catalog_proposals: state.catalog_proposals,
    dashboard: dashboardView(state),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    proposal_id?: string;
    decision?: "accepted" | "rejected";
  };
  if (!body.proposal_id || !body.decision) {
    return NextResponse.json(
      { error: "proposal_id and decision are required." },
      { status: 400 },
    );
  }
  const state = await decideCatalogProposal(body.proposal_id, body.decision);
  return NextResponse.json({
    catalog: state.catalog,
    catalog_proposals: state.catalog_proposals,
    dashboard: dashboardView(state),
  });
}
