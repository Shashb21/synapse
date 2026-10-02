/** Shared public experiment parsing, module input allowlists and source authorization. */
import { z } from "zod";
import { CALL_KINDS, validateExperimentCycleControl } from "@/accuracy/kernel/contracts";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import { getReferencePack } from "@/accuracy/eval/reference-gold";
import { PASS_COMPARISON_RESERVED_CONDITION_FIELDS } from "@/accuracy/experiments/pass-comparison";
import { getSourceFile } from "@/accuracy/store/source-store";
import { getAuthorizedWorkspace } from "@/accuracy/store/tenant";
import type { sessionContext } from "@/modules/auth/session";

const requestSchema = z.object({
  mode: z.enum(["single_call", "pipeline"]),
  source_workspace_id: z.string().trim().min(1),
  source_file_ids: z.array(z.string().trim().min(1)).min(1),
  pack_id: z.string().trim().min(1),
  condition: z.object({
    label: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(65_536).optional(),
    prompt_version: z.string().trim().min(1).max(120).optional(),
    critic_revision_passes: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }).strict(),
  call: z.object({ call_kind: z.enum(CALL_KINDS), input: z.record(z.string(), z.unknown()) }).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "single_call" && !value.call) {
    context.addIssue({ code: "custom", path: ["call"], message: "A single_call experiment requires a call." });
  }
  if (value.mode === "pipeline" && value.call) {
    context.addIssue({ code: "custom", path: ["call"], message: "A pipeline experiment does not accept a single call." });
  }
});

type ExperimentBody = z.infer<typeof requestSchema>;

/** A safe public validation message; unexpected failures remain server errors. */
export class InvalidExperimentRequestError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidExperimentRequestError"; }
}

/** Parse the existing public shape and reject controlled-call/cohort overrides before copies. */
export async function parseExperimentRequest(request: Request, comparison = false): Promise<ExperimentBody> {
  let json: unknown;
  try { json = await request.json(); }
  catch (error) {
    if (comparison && error instanceof SyntaxError) throw new InvalidExperimentRequestError("Invalid experiment request");
    throw error;
  }
  const body = requestSchema.parse(json);
  if (comparison) {
    const reserved = PASS_COMPARISON_RESERVED_CONDITION_FIELDS.find(key => Object.hasOwn(body.condition, key));
    if (reserved) throw new InvalidExperimentRequestError("Invalid experiment request");
  }
  const passes = comparison ? 1 : body.condition.critic_revision_passes;
  if (passes !== undefined) {
    try {
      validateExperimentCycleControl({ critic_revision_passes: passes }, "experiment", body.call?.call_kind);
    } catch (error) {
      if (error instanceof Error) throw new InvalidExperimentRequestError("Controlled experiments support extraction calls only.");
      throw error;
    }
  }
  return body;
}

/** Resolve source access from the authenticated subject and its server-side grants. */
export async function authorizedSourceWorkspace(source_workspace_id: string, session: Awaited<ReturnType<typeof sessionContext>>) {
  if (!session.session) return null;
  return getAuthorizedWorkspace({ workspace_id: source_workspace_id, subject: session.session.subject, role: session.role });
}

/** Detect schema-stripped keys while permitting defaults and value normalization. */
function hasUnknownInputKeys(input: unknown, normalized: unknown): boolean {
  if (Array.isArray(input)) {
    return !Array.isArray(normalized) || input.some((value, index) => hasUnknownInputKeys(value, normalized[index]));
  }
  if (!input || typeof input !== "object") return false;
  if (!normalized || typeof normalized !== "object") return true;
  return Object.entries(input).some(([key, value]) => !Object.hasOwn(normalized, key)
    || hasUnknownInputKeys(value, (normalized as Record<string, unknown>)[key]));
}

/** Validate pack, active module input and selected source ownership before execution. */
export async function validateExperimentSources(body: ExperimentBody): Promise<ExperimentBody> {
  if (!getReferencePack(body.pack_id)) throw new InvalidExperimentRequestError("Unknown reference pack");
  let call = body.call;
  if (call) {
    const implementation = await activeAccuracyModule(call.call_kind);
    const parsed = implementation.inputSchema.safeParse(call.input);
    if (!parsed.success || hasUnknownInputKeys(call.input, parsed.data)) {
      throw new InvalidExperimentRequestError("Invalid single-call input.");
    }
    call = { ...call, input: parsed.data as Record<string, unknown> };
  }
  const sources = await Promise.all(body.source_file_ids.map(id => getSourceFile(body.source_workspace_id, id)));
  if (sources.some(source => !source)) {
    throw new InvalidExperimentRequestError("Every source_file_id must belong to the source workspace");
  }
  return { ...body, call };
}

/** Map known validation failures to safe public messages, leaving server faults unclassified. */
export function experimentRequestError(error: unknown): string | null {
  if (error instanceof z.ZodError) return "Invalid experiment request";
  if (error instanceof InvalidExperimentRequestError) return error.message;
  if (error instanceof Error && error.message.startsWith("Unknown reference pack")) return "Unknown reference pack";
  return null;
}
