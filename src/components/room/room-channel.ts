"use client";

import type { RoomState } from "@/lib/room/store";

/**
 * Presenter ↔ audience messages between windows of the same browser. A
 * projector on another machine follows the same state by polling /api/room.
 */
export type RoomMessage =
  | { type: "state"; state: RoomState; refresh?: boolean }
  | { type: "scroll"; href: string; ratio: number }
  | { type: "hello" }
  /** A key or click on the audience window moves the presenter (clicker on the projector). */
  | { type: "nav"; step: number }
  | { type: "end" };

export function roomChannelName(workspaceKey: string) {
  return `synapse-room:${workspaceKey}`;
}

export function openRoomChannel(workspaceKey: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(roomChannelName(workspaceKey));
}

export async function postRoom(body: Record<string, unknown>): Promise<{ state?: RoomState; error?: string }> {
  const res = await fetch("/api/room", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { state?: RoomState; error?: string };
  if (!res.ok) throw new Error(json.error ?? "Room request failed.");
  return json;
}
