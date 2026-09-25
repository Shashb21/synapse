import { NextResponse } from "next/server";
import { NoWorkspaceError } from "@/modules/workspaces/context";
import { getRoomState, listRoomNotes, saveRoomNote, setRoomState } from "@/lib/room/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const status = error instanceof NoWorkspaceError ? 409 : 400;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Room request failed." }, { status });
}

/** The presenter's current slide (audiences poll this), and optionally the notes. */
export async function GET(request: Request) {
  try {
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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RoomOp;
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
