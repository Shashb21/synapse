import type { Metadata } from "next";
import { PresenterConsole, type BreakoutSummary } from "@/components/room/presenter-console";
import type { ExportPackData } from "@/components/room/export-pack";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { getRoomState, listRoomNotes } from "@/lib/room/store";
import { timelineModel } from "@/modules/stages/s10-timeline/module";
import { roomWorkspace } from "./room-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Room · Presenter view · Synapse IEGP" };

/**
 * Room: a PowerPoint-style presenter view. The slides are the real app pages
 * in plan order (src/lib/room/slides.ts); the consultant edits them live here.
 */
export default async function RoomPage() {
  const [state, room, notes, model, workspace] = await Promise.all([
    loadState(),
    getRoomState(),
    listRoomNotes(),
    timelineModel(),
    roomWorkspace(),
  ]);
  const plan = buildPlanWorkspace(state);

  const breakouts: BreakoutSummary[] = state.breakout_groups.map((group) => ({
    id: group.id,
    name: group.name,
    note: group.note ?? null,
    gapCount: state.breakout_group_gaps.filter((row) => row.group_id === group.id).length,
  }));

  const exportPack: ExportPackData = {
    assetName: state.asset.name,
    inn: state.asset.inn,
    indication: state.asset.indication,
    geography: state.asset.geography,
    gaps: plan.review,
    board: plan.board,
    timelineModel: model,
    today: new Date().toISOString().slice(0, 10),
  };

  return (
    <PresenterConsole
      workspaceKey={workspace.key}
      workspaceName={workspace.name}
      initialState={room}
      initialNotes={notes}
      breakouts={breakouts}
      exportPack={exportPack}
    />
  );
}
