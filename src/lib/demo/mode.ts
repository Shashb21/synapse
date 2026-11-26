import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { getWorkspace, type Workspace } from "@/modules/workspaces/store";
import { isDemoRecordingId, VELMARA_DEMO_FIXTURE } from "./replay-provider";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";

/**
 * Client demo mode (KAN-138). A workspace an admin has put in demo mode
 * replays the recorded demo run for every AI step instead of calling a model.
 */

/** Whether this workspace (default: the one the current query is scoped to) is in client demo mode. */
export async function isDemoModeWorkspace(workspaceId?: string | null): Promise<boolean> {
  const id = workspaceId ?? await scopedWorkspaceId();
  if (!id) return false;
  return (await getWorkspace(id))?.demo_mode === true;
}

/**
 * Recording run: a demo-mode workspace calls the real model so its calls can be
 * exported as the recording (scripts/export-demo-recording.ts). Never in production.
 */
export function isRecordingDemo(): boolean {
  return process.env.SYNAPSE_DEMO_RECORD === "1" && process.env.NODE_ENV !== "production";
}

export type DemoExecution = {
  workspace_id: string;
  fixture: typeof VELMARA_DEMO_FIXTURE;
} & ({ mode: "replay" } | { mode: "record"; recording_id: string });

/** Only authenticated customer walkthrough entry points supply their verified workspace. */
export function demoExecutionFor(workspace: Pick<Workspace, "id" | "demo_mode"> | null): DemoExecution | undefined {
  if (!workspace?.demo_mode) return undefined;
  const demo = { workspace_id: workspace.id, fixture: VELMARA_DEMO_FIXTURE } as const;
  if (!isRecordingDemo()) return { ...demo, mode: "replay" };
  const recording_id = process.env.SYNAPSE_DEMO_RECORDING_ID ?? "";
  if (!isDemoRecordingId(recording_id)) {
    throw new TrustedApplicationError("Set a new recording ID for the Velmara demo before attempting a live recording.", "demo_recording_id_required", 409);
  }
  return { ...demo, mode: "record", recording_id };
}

/** Recheck workspace scope and the saved owner switch before answering or recording. */
export async function allowsDemoExecution(execution: DemoExecution, workspaceId: string | null): Promise<boolean> {
  return execution.fixture === VELMARA_DEMO_FIXTURE && execution.workspace_id === workspaceId &&
    execution.mode === (isRecordingDemo() ? "record" : "replay") &&
    (execution.mode === "replay" || (isDemoRecordingId(execution.recording_id) && execution.recording_id === process.env.SYNAPSE_DEMO_RECORDING_ID)) &&
    workspaceId === await scopedWorkspaceId() && (await getWorkspace(workspaceId))?.demo_mode === true;
}
