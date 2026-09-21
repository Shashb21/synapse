import { eq } from "drizzle-orm";
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

export function registerModule<I, O>(module: SynapseModule<I, O>): SynapseModule<I, O> {
  if (module.manifest.contract !== KERNEL_CONTRACT) {
    throw new Error(
      `${module.manifest.id} speaks contract ${module.manifest.contract}; kernel speaks ${KERNEL_CONTRACT}`,
    );
  }
  if (registry.has(module.manifest.id)) {
    const existing = registry.get(module.manifest.id)!;
    if (existing.manifest.version !== module.manifest.version) {
      throw new Error(`${module.manifest.id} is already registered at ${existing.manifest.version}`);
    }
    return module;
  }
  registry.set(module.manifest.id, module as unknown as Registered);
  return module;
}

export function allModules(): Registered[] {
  return [...registry.values()];
}

export function modulesForStage(stage: StageId): Registered[] {
  return allModules().filter((module) => module.manifest.stage === stage);
}

export function moduleById(id: string): Registered | undefined {
  return registry.get(id);
}

export function manifests(): ModuleManifest[] {
  return allModules().map((module) => module.manifest);
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
    const module = candidates.find((candidate) => candidate.manifest.id === chosen.module_id);
    if (module) return module;
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
  const module = moduleById(args.module_id);
  if (!module) throw new Error(`Unknown module ${args.module_id}`);
  if (module.manifest.stage !== args.stage) {
    throw new Error(`${args.module_id} implements ${module.manifest.stage}, not ${args.stage}`);
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
};

export async function stageWiring(): Promise<StageWiring[]> {
  const rows = await activationRows();
  const out: StageWiring[] = [];
  for (const stage of STAGE_IDS) {
    const available = modulesForStage(stage).map((module) => module.manifest);
    const row = rows.find((candidate) => candidate.stage === stage);
    let active: ModuleManifest | null = null;
    if (available.length > 0) active = (await activeModule(stage)).manifest;
    out.push({
      stage,
      active,
      available,
      activated_by: row?.activated_by ?? null,
      activated_at: row?.activated_at ?? null,
    });
  }
  return out;
}

/** Test seam: drops in-memory registrations. */
export function resetRegistry() {
  registry.clear();
}
