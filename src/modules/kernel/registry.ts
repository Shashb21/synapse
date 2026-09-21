import { db, ensurePlatformSchema } from "./db";
import * as t from "./schema";
import { nowIso } from "./ids";
import {
  KERNEL_CONTRACT,
  STAGE_IDS,
  type ModuleManifest,
  type StageId,
  type SynapseModule,
} from "./contracts";

type Registered = SynapseModule<unknown, unknown>;

const registry = new Map<string, Registered>();

export function registerModule<I, O>(implementation: SynapseModule<I, O>): SynapseModule<I, O> {
  const { manifest } = implementation;
  if (manifest.contract !== KERNEL_CONTRACT) {
    throw new Error(
      `${manifest.id} speaks contract ${manifest.contract}; kernel speaks ${KERNEL_CONTRACT}`,
    );
  }
  const existing = registry.get(manifest.id);
  if (existing) {
    if (existing.manifest.version !== manifest.version) {
      throw new Error(`${manifest.id} is already registered at ${existing.manifest.version}`);
    }
    return implementation;
  }
  registry.set(manifest.id, implementation as unknown as Registered);
  return implementation;
}

export function allModules(): Registered[] {
  return [...registry.values()];
}

export function modulesForStage(stage: StageId): Registered[] {
  return allModules().filter((candidate) => candidate.manifest.stage === stage);
}

export function moduleById(id: string): Registered | undefined {
  return registry.get(id);
}

export function manifests(): ModuleManifest[] {
  return allModules().map((candidate) => candidate.manifest);
}

async function activationRows() {
  await ensurePlatformSchema();
  return db().select().from(t.stageModules);
}

/**
 * The implementation currently wired into a stage. Defaults to the only
 * registered module; an explicit activation row overrides it, which is how a
 * stage is upgraded without redeploying its neighbours.
 */
export async function activeModule(stage: StageId): Promise<Registered> {
  const candidates = modulesForStage(stage);
  if (candidates.length === 0) throw new Error(`No module registered for stage ${stage}`);
  const rows = await activationRows();
  const chosen = rows.find((row) => row.stage === stage);
  if (chosen) {
    const wired = candidates.find((candidate) => candidate.manifest.id === chosen.module_id);
    if (wired) return wired;
  }
  return [...candidates].sort((a, b) =>
    b.manifest.version.localeCompare(a.manifest.version, undefined, { numeric: true }),
  )[0]!;
}

export async function activateModule(args: {
  stage: StageId;
  module_id: string;
  actor_name: string;
}) {
  const implementation = moduleById(args.module_id);
  if (!implementation) throw new Error(`Unknown module ${args.module_id}`);
  if (implementation.manifest.stage !== args.stage) {
    throw new Error(
      `${args.module_id} implements ${implementation.manifest.stage}, not ${args.stage}`,
    );
  }
  const values = {
    stage: args.stage,
    module_id: args.module_id,
    activated_by: args.actor_name,
    activated_at: nowIso(),
  };
  await db()
    .insert(t.stageModules)
    .values(values)
    .onConflictDoUpdate({ target: t.stageModules.stage, set: values });
}

export type StageWiring = {
  stage: StageId;
  active: ModuleManifest | null;
  available: ModuleManifest[];
  activated_by: string | null;
  activated_at: string | null;
  /** True when the active module ships its own gold cases and scorer. */
  has_evals: boolean;
};

export async function stageWiring(): Promise<StageWiring[]> {
  const rows = await activationRows();
  const out: StageWiring[] = [];
  for (const stage of STAGE_IDS) {
    const available = modulesForStage(stage).map((candidate) => candidate.manifest);
    const row = rows.find((candidate) => candidate.stage === stage);
    let active: ModuleManifest | null = null;
    let has_evals = false;
    if (available.length > 0) {
      const wired = await activeModule(stage);
      active = wired.manifest;
      has_evals = Boolean(wired.evals);
    }
    out.push({
      stage,
      active,
      available,
      activated_by: row?.activated_by ?? null,
      activated_at: row?.activated_at ?? null,
      has_evals,
    });
  }
  return out;
}

/** Test seam: drops in-memory registrations. */
export function resetRegistry() {
  registry.clear();
}
