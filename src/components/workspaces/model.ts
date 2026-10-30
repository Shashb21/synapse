import type { WorkspaceRole } from "@/modules/workspaces/store";
import { postJson, RequestOutcomeError } from "@/lib/post-json";

/** What the workspace tag needs: the open workspace, the others, and who is signed in. */
export type WorkspaceTagModel = {
  /** `demo`: the workspace holds the Velmara demo data (badged "Demo"). */
  /** `demo_mode`: client demo mode (KAN-138), AI steps replay the recorded run. */
  current: { id: string; name: string; role: WorkspaceRole; demo: boolean; demo_mode?: boolean };
  /** AI assistance: the open workspace's own setting and the platform master switch. */
  ai?: { workspace: boolean; platform: boolean };
  workspaces: { id: string; name: string; role: WorkspaceRole; demo: boolean }[];
  /** `owner`: the platform owner (sees the Admin link). */
  person: { name: string; email: string | null; owner?: boolean };
};

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  member: "Member",
};

/** Send JSON, throwing a safe RequestOutcomeError if the response cannot confirm success. */
export async function sendJson<T = Record<string, unknown>>(
  url: string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<T> {
  const result = await postJson<T>(url, body, { method });
  if (!result.ok) throw new RequestOutcomeError(result.json.error!, result.outcome, result.status);
  return result.json as T;
}

export function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
