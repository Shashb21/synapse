import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ROOM_ENABLED } from "@/lib/room/enabled";
import { PresenterConsole, type BreakoutSummary } from "@/components/room/presenter-console";
import { loadState } from "@/lib/iegp/store";
import { getRoomState, listRoomNotes } from "@/lib/room/store";
import { roomWorkspace } from "./room-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Room · Presenter view · Synapse IEGP" };

/**
 * Room: a PowerPoint-style presenter view. The slides are the real app pages
 * in plan order (src/lib/room/slides.ts); the consultant edits them live here.
 */
export default async function RoomPage() {
  if (!ROOM_ENABLED) redirect("/");
  const [state, room, notes, workspace] = await Promise.all([
    loadState(),
    getRoomState(),
    listRoomNotes(),
    roomWorkspace(),
  ]);
  const breakouts: BreakoutSummary[] = state.breakout_groups.map((group) => ({
    id: group.id,
    name: group.name,
    note: group.note ?? null,
    gapCount: state.breakout_group_gaps.filter((row) => row.group_id === group.id).length,
  }));

  return (
    <PresenterConsole
      workspaceKey={workspace.key}
      workspaceName={workspace.name}
      initialState={room}
      initialNotes={notes}
      breakouts={breakouts}
    />
  );
}
