"use client";

import { postJson, RequestOutcomeError } from "@/lib/post-json";

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

/**
 * Room writes go out one at a time, in the order they were made: moving quickly
 * (Home then →) must never let an earlier slide land last and win.
 */
let queue: Promise<unknown> = Promise.resolve();
/** The newest move not sent yet: quick moves collapse into the last one. */
let pendingMove: Record<string, unknown> | null = null;

function isMove(body: Record<string, unknown>): boolean {
  return body.op === "slide" || body.op === "location";
}

export function postRoom(body: Record<string, unknown>): Promise<{ state?: RoomState; error?: string }> {
  let next: Promise<{ state?: RoomState; error?: string }>;
  if (isMove(body)) {
    const alreadyQueued = pendingMove !== null;
    pendingMove = body;
    if (alreadyQueued) {
      // The move already waiting in line will send this newer one instead.
      next = queue.then(() => ({}));
    } else {
      next = queue.then(() => {
        const latest = pendingMove!;
        pendingMove = null;
        return sendRoom(latest);
      });
    }
  } else {
    next = queue.then(() => sendRoom(body));
  }
  queue = next.catch(() => undefined);
  return next;
}

async function sendRoom(body: Record<string, unknown>): Promise<{ state?: RoomState; error?: string }> {
  const res = await postJson<{ state?: RoomState }>("/api/room", body, { keepalive: true });
  if (!res.ok || !res.json.state) throw new RequestOutcomeError(res.json.error ?? "We couldn’t confirm the room update. Reload the room to check the current slide and notes.", res.outcome === "confirmed" ? "unknown" : res.outcome, res.status);
  return res.json;
}
