import { evidenceHash } from "./decision-replay";
import type { JsonCompletion, ResolvedRoute, ModuleContext } from "./contracts";
import { findProvider, type ProviderRequestBudget } from "@/modules/llm/provider";
import { TrustedApplicationError } from "./stage-errors";

type Call = Parameters<JsonCompletion>[0];
export type RequestIdentity = { wire: string; actual: string; design: string };

/** Preserve the shape of fields constructed from earlier replies without using the reply as an instruction. */
function dialogueShape(value: unknown): unknown {
  if (Array.isArray(value)) return { arrayOf: [...new Set(value.map((v) => JSON.stringify(dialogueShape(v))))].sort() };
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, dialogueShape(v)]));
  return value === null ? "null" : typeof value;
}

export function diagnosticRequestIdentity(
  call: Call,
  route: ResolvedRoute,
  policy: ModuleContext["execution_policy"],
  first: boolean,
): RequestIdentity {
  const settings = {
    provider: route.provider_id,
    model: route.model,
    max_tokens: call.maxTokens ?? route.params.max_tokens,
    temperature:
      findProvider(route.provider_id)?.sendsTemperature?.(route.model) === false ? null : route.params.temperature,
  };
  const wire = { ...settings, system: call.system, user: call.user };
  const metadata = { role: call.role ?? null, purpose: call.purpose, policy: policy ?? "standard" };
  const actual = evidenceHash({ ...wire, ...metadata });
  let design = actual;
  if (!first && call.dialogueFields?.length) {
    const message = JSON.parse(call.user) as Record<string, unknown>;
    const template = Object.fromEntries(
      Object.entries(message).map(([field, value]) => [
        field,
        call.dialogueFields!.includes(field) ? { dialogue: dialogueShape(value) } : value,
      ]),
    );
    design = evidenceHash({ ...wire, user: template, ...metadata, repairGuidance: call.repairGuidance });
  }
  return { wire: evidenceHash(wire), actual, design };
}

export class DiagnosticPreview extends Error {
  constructor(readonly identity: RequestIdentity) {
    super("Captured first diagnostic request.");
  }
}

export const DIAGNOSTIC_ATTEMPT_LIMIT = 128;
/** A single allowance covers every stage, variant, retry and provider transport attempt in this invocation. */
export function diagnosticRequestBudget(): ProviderRequestBudget {
  let sent = 0;
  const check = () => {
    if (sent >= DIAGNOSTIC_ATTEMPT_LIMIT)
      throw new TrustedApplicationError("The diagnostic reached its provider request limit.", "diagnostic_limit", 422);
  };
  return {
    check,
    consume() {
      check();
      sent++;
    },
  };
}

export function withinDiagnosticBudget(
  group: ProviderRequestBudget,
  local?: ProviderRequestBudget,
): ProviderRequestBudget {
  if (!local) return group;
  return {
    check(failure) {
      group.check(failure);
      local.check(failure);
    },
    consume() {
      group.check();
      local.check();
      group.consume();
      local.consume();
    },
  };
}
