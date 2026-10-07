import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import {
  accuracyEvalReferencePack,
  listReferencePacks,
} from "@/accuracy/eval/reference-gold";
import { listAccuracyModules, activeAccuracyModuleId } from "@/accuracy/kernel/registry";
import { CALL_KINDS } from "@/accuracy/kernel/contracts";
import { registerAccuracyStack } from "@/accuracy";

/** Orchestrator status for accuracy v2 dev bots / CI. */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  registerAccuracyStack();
  const modules = listAccuracyModules().map((m) => ({
    id: m.manifest.id,
    call_kind: m.manifest.call_kind,
    version: m.manifest.version,
    agentic: m.manifest.agentic,
  }));
  const active = CALL_KINDS.map((k) => ({
    call_kind: k,
    module_id: activeAccuracyModuleId(k) ?? null,
  }));
  const reference_packs = listReferencePacks().map((p) => p.id);
  const reference_eval = await Promise.all(
    reference_packs.map((id) => accuracyEvalReferencePack(id)),
  );
  return NextResponse.json({
    branch: "cursor/accuracy-first-modular-b7b5",
    reference_packs,
    reference_eval,
    modules,
    active,
    orchestration_doc: "/docs/accuracy-dev-orchestration.md",
  });
}
