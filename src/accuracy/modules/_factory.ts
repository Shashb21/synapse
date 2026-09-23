import { z } from "zod";
import type { AccuracyModule, CallKind } from "@/accuracy/kernel/contracts";

export function mechanicalModule<I, O>(args: {
  id: string;
  call_kind: CallKind;
  title: string;
  summary: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  run: AccuracyModule<I, O>["run"];
}): AccuracyModule<I, O> {
  return {
    manifest: {
      id: args.id,
      call_kind: args.call_kind,
      version: "0.1.0",
      title: args.title,
      summary: args.summary,
      contract: 1,
      agentic: false,
    },
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    run: args.run,
  };
}

export function agenticModule<I, O>(args: {
  id: string;
  call_kind: CallKind;
  title: string;
  summary: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  run: AccuracyModule<I, O>["run"];
}): AccuracyModule<I, O> {
  return {
    manifest: {
      id: args.id,
      call_kind: args.call_kind,
      version: "0.1.0",
      title: args.title,
      summary: args.summary,
      contract: 1,
      agentic: true,
    },
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    run: args.run,
  };
}
