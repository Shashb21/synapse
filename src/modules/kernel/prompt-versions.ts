import type { StageId } from "./contracts";

/** Registered prompt versions a stage can hillclimb across. */
export const PROMPT_VERSION_IDS = [
  "v1.0-baseline",
  "v1.1-atomic",
  "v1.2-hillclimb-hints",
] as const;

export type PromptVersionId = (typeof PROMPT_VERSION_IDS)[number];

const VARIANT_COPY: Record<PromptVersionId, string> = {
  "v1.0-baseline": "",
  "v1.1-atomic":
    "Hillclimb variant: split any compound question into separate atomic gaps. Never merge two decision questions into one statement.",
  "v1.2-hillclimb-hints":
    "Hillclimb variant: prefer gaps that quote a verbatim source sentence and name the decision audience (payer, KOL, regulator) when visible in the text.",
};

export function promptVariantInstruction(version: PromptVersionId): string {
  return VARIANT_COPY[version] ?? "";
}

/** Agentic stages that participate in the improvement loop. */
export const HILLCLIMB_STAGES: StageId[] = ["S2", "S3", "S4", "S6", "S8", "S9"];

export function promptVersionsFor(stage: StageId): PromptVersionId[] {
  if (!HILLCLIMB_STAGES.includes(stage)) return ["v1.0-baseline"];
  return [...PROMPT_VERSION_IDS];
}
