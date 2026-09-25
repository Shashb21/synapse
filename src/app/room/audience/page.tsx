import type { Metadata } from "next";
import { AudienceView } from "@/components/room/audience-view";
import { getRoomState } from "@/lib/room/store";
import { roomWorkspace } from "../room-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Synapse IEGP" };

/** The audience window: the presenter's current page, full-screen and chrome-free. */
export default async function AudiencePage() {
  const [room, workspace] = await Promise.all([getRoomState(), roomWorkspace()]);
  return <AudienceView workspaceKey={workspace.key} initialState={room} />;
}
