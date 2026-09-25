import type { WorkspaceRole } from "@/modules/workspaces/store";

/** What the workspace tag needs: the open workspace, the others, and who is signed in. */
export type WorkspaceTagModel = {
  current: { id: string; name: string; role: WorkspaceRole };
  workspaces: { id: string; name: string; role: WorkspaceRole }[];
  person: { name: string; email: string | null };
};

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  member: "Member",
};

/** POSTs JSON and returns the parsed body, throwing the server's error message on failure. */
export async function sendJson<T = Record<string, unknown>>(
  url: string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (HTTP ${res.status}).`);
  return json;
}

export function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
