import { z } from "zod";

export const parsePolicyInputSchema = z.object({
  filename: z.string(),
  mime: z.string(),
});

export type ParsePolicyInput = z.infer<typeof parsePolicyInputSchema>;

export type ParsePolicy = {
  /** "llm": text is extracted mechanically and the chosen LLM structures it. */
  parser: "llm" | "local_structured";
  reason: string;
};

/**
 * Every file type is parsed by the LLM on the parse route. LlamaParse is
 * disabled for now; "local_structured" only ever appears under the test stub.
 */
export function resolveParsePolicy(input: ParsePolicyInput): ParsePolicy {
  const lower = input.filename.toLowerCase();
  const kind = lower.slice(lower.lastIndexOf(".") + 1) || input.mime || "file";
  return { parser: "llm", reason: `${kind}_structured_by_llm` };
}
