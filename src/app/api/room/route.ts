import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody, requireCustomerContext } from "@/modules/auth/api-guard";
import { getRoomState, listRoomNotes, saveRoomNote, setRoomState } from "@/lib/room/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  return apiErrorResponse(error, "Room request failed.");
}

/** The presenter's current slide (audiences poll this), and optionally the notes. Any member may read. */
export async function GET(request: Request) {
  try {
    await requireCustomerContext();
    const url = new URL(request.url);
    const state = await getRoomState();
    if (url.searchParams.get("notes") === "1") {
      return NextResponse.json({ state, notes: await listRoomNotes() }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ state }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

type RoomOp =
  | { op: "slide"; slide_id: string; href?: string }
  | { op: "location"; href: string }
  | { op: "bump" }
  | { op: "note"; slide_id: string; notes: string };

/** Presenting (moving the slide) and writing notes are edits: viewers only follow along. */
export async function POST(request: Request) {
  try {
    const body = (await readJsonBody(request)) as RoomOp;
    await requireCustomerContext({ capability: "validate" });
    switch (body.op) {
      case "slide":
        return NextResponse.json({ state: await setRoomState({ slide_id: body.slide_id, href: body.href }) });
      case "location":
        return NextResponse.json({ state: await setRoomState({ href: body.href }) });
      case "bump":
        return NextResponse.json({ state: await setRoomState({}) });
      case "note":
        await saveRoomNote(body.slide_id, body.notes);
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "Unknown room op." }, { status: 400 });
    }
  } catch (error) {
    return failure(error);
  }
}
