import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ROOM_ENABLED } from "@/lib/room/enabled";
import { AudienceView } from "@/components/room/audience-view";
import { getRoomState } from "@/lib/room/store";
import { requireRoomAccess, roomWorkspace } from "../room-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Synapse IEGP" };

/** The audience window: the presenter's current page, full-screen and chrome-free. */
export default async function AudiencePage() {
  if (!ROOM_ENABLED) redirect("/");
  await requireRoomAccess("/room/audience");
  const [room, workspace] = await Promise.all([getRoomState(), roomWorkspace()]);
  return <AudienceView workspaceKey={workspace.key} initialState={room} />;
}
