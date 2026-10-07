/** Trusted assembly execution scopes and review/publication serialization helpers. */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { accuracyDb, withAccuracyTransaction } from "@/accuracy/store/db";

export type AssemblyExecutionScope = { kind: "production" | "preparation" | "experiment" };

const scope = new AsyncLocalStorage<AssemblyExecutionScope>();

/** Return the trusted assembly execution scope for the current async request. */
export function assemblyExecutionScope(): AssemblyExecutionScope {
  return scope.getStore() ?? { kind: "production" };
}

/** Execute automatic assembly preparation without allowing HTTP-controlled bypass flags. */
export async function withAssemblyPreparation<T>(operation: () => Promise<T>): Promise<T> {
  return scope.run({ kind: "preparation" }, operation);
}

/** Execute isolated experiment assembly work without touching production approval state. */
export async function withAssemblyExperiment<T>(operation: () => Promise<T>): Promise<T> {
  return scope.run({ kind: "experiment" }, operation);
}

/** Acquire the shared workspace advisory transaction lock used by omission and publication writes. */
export async function lockAssemblyWorkspace(workspace_id: string): Promise<void> {
  await accuracyDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omission:${workspace_id}`}, 0))`);
}

/** Run an operation under the shared accuracy transaction and workspace lock. */
export async function withAssemblyWorkspaceLock<T>(workspace_id: string, operation: () => Promise<T>): Promise<T> {
  return withAccuracyTransaction(async () => {
    await lockAssemblyWorkspace(workspace_id);
    return operation();
  });
}
