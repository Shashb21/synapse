/** Workspace-scoped revision ancestry, immutable attempts, and current head resolution. */
import { and, desc, eq } from "drizzle-orm";
import { AssemblyError } from "@/accuracy/domain/assembly";
import type { AssemblyRevision, AssemblyRevisionState } from "@/accuracy/domain/assembly-revision";
import { accuracyDb, ensureAccuracySchema } from "./db";
import { readAssembly } from "./assembly-store";
import * as t from "./schema";

/** Find the change that owns a revision assembly (including immutable retry completions). */
export async function revisionForAssembly(workspace_id: string, assembly_id: string): Promise<AssemblyRevision | null> {
  await ensureAccuracySchema();
  const [attempt] = await accuracyDb().select().from(t.accuracyAssemblyRevisionAttempts).where(and(
    eq(t.accuracyAssemblyRevisionAttempts.workspace_id, workspace_id), eq(t.accuracyAssemblyRevisionAttempts.assembly_id, assembly_id),
  )).limit(1);
  const rows = await accuracyDb().select().from(t.accuracyAssemblyRevisions).where(and(
    eq(t.accuracyAssemblyRevisions.workspace_id, workspace_id),
    attempt ? eq(t.accuracyAssemblyRevisions.id, attempt.revision_id) : eq(t.accuracyAssemblyRevisions.initial_assembly_id, assembly_id),
  )).limit(1);
  return rows[0]?.change ?? null;
}

/** Read baseline ancestry and the current revision pointer; no old-approval fallback is allowed. */
export async function assemblyRevisionState(workspace_id: string, assembly_id: string): Promise<AssemblyRevisionState> {
  const assembly = await readAssembly(workspace_id, assembly_id);
  if (!assembly) throw new AssemblyError("not_found", "Assembly not found.");
  const revision = await revisionForAssembly(workspace_id, assembly_id);
  const baseline_assembly_id = revision?.baseline_assembly_id ?? assembly_id;
  const [head] = await accuracyDb().select().from(t.accuracyAssemblyRevisionHeads).where(and(
    eq(t.accuracyAssemblyRevisionHeads.workspace_id, workspace_id), eq(t.accuracyAssemblyRevisionHeads.baseline_assembly_id, baseline_assembly_id),
  )).limit(1);
  const current_head_id = head?.assembly_id ?? baseline_assembly_id;
  const [attempt] = revision ? await accuracyDb().select().from(t.accuracyAssemblyRevisionAttempts).where(and(
    eq(t.accuracyAssemblyRevisionAttempts.workspace_id, workspace_id), eq(t.accuracyAssemblyRevisionAttempts.assembly_id, assembly_id),
  )).orderBy(desc(t.accuracyAssemblyRevisionAttempts.created_at), desc(t.accuracyAssemblyRevisionAttempts.id)).limit(1) : [];
  return { revision, baseline_assembly_id, current_head_id, is_current: current_head_id === assembly_id,
    linking_error: attempt?.error ?? null, can_retry: Boolean(revision && current_head_id === assembly_id && !assembly.linking_complete) };
}

/** Resolve the current successor for a production baseline under the caller's workspace lock. */
export async function currentRevisionAssemblyId(workspace_id: string, baseline_assembly_id: string): Promise<string> {
  const [head] = await accuracyDb().select().from(t.accuracyAssemblyRevisionHeads).where(and(
    eq(t.accuracyAssemblyRevisionHeads.workspace_id, workspace_id), eq(t.accuracyAssemblyRevisionHeads.baseline_assembly_id, baseline_assembly_id),
  )).limit(1);
  return head?.assembly_id ?? baseline_assembly_id;
}
