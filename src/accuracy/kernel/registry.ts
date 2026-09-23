import type { AnyAccuracyModule, CallKind } from "../kernel/contracts";

const implementations = new Map<string, AnyAccuracyModule>();
const activeByKind = new Map<CallKind, string>();

export function registerAccuracyModule(module: AnyAccuracyModule) {
  implementations.set(module.manifest.id, module);
  if (!activeByKind.has(module.manifest.call_kind)) {
    activeByKind.set(module.manifest.call_kind, module.manifest.id);
  }
}

export function activateAccuracyModule(args: {
  call_kind: CallKind;
  module_id: string;
  activated_by: string;
}) {
  if (!implementations.has(args.module_id)) {
    throw new Error(`Unknown accuracy module ${args.module_id}`);
  }
  const mod = implementations.get(args.module_id)!;
  if (mod.manifest.call_kind !== args.call_kind) {
    throw new Error(`Module ${args.module_id} is for ${mod.manifest.call_kind}, not ${args.call_kind}`);
  }
  activeByKind.set(args.call_kind, args.module_id);
}

export async function activeAccuracyModule(call_kind: CallKind): Promise<AnyAccuracyModule> {
  const id = activeByKind.get(call_kind);
  if (!id) throw new Error(`No active module for call kind ${call_kind}`);
  const mod = implementations.get(id);
  if (!mod) throw new Error(`Active module ${id} not registered`);
  return mod;
}

export function listAccuracyModules(): AnyAccuracyModule[] {
  return [...implementations.values()];
}

export function activeAccuracyModuleId(call_kind: CallKind): string | undefined {
  return activeByKind.get(call_kind);
}
