import type { ActorFunction } from "@/lib/iegp/enums";
import { insertFeedback, insertGoldGap, patchFeedback } from "./store";

export type GapFeedbackKind = "wording" | "not_a_gap" | "is_a_gap" | "missed";

export async function recordHumanGapFeedback(args: {
  gap_id: string;
  kind: GapFeedbackKind;
  before: { name?: string; statement?: string; domain?: string };
  after: { name?: string; statement?: string; domain?: string };
  actor_name: string;
  actor_function: ActorFunction;
  source_key?: string;
  source_quote?: string;
  note?: string;
}): Promise<{ feedback_id: string; gold_id: string }> {
  const isGap = args.kind !== "not_a_gap";
  const goldId = `GOLD-H-${args.kind}-${args.gap_id}`.slice(0, 64);
  await insertGoldGap({
    id: goldId,
    name: args.after.name || args.before.name || "Unnamed gap",
    statement: args.after.statement || args.before.statement || "",
    domain: args.after.domain || args.before.domain || "unmet_need",
    source_key: args.source_key || args.gap_id,
    source_quote: args.source_quote || args.after.statement || args.before.statement || "",
    must_find: isGap,
    is_gap: isGap,
    origin: `human_${args.kind}`,
    from_gap_id: args.gap_id,
    metadata: { note: args.note ?? null, kind: args.kind },
    actor_name: args.actor_name,
    actor_function: args.actor_function,
  });
  const feedbackId = await insertFeedback({
    gap_id: args.gap_id,
    kind: args.kind,
    before: args.before,
    after: args.after,
    actor_name: args.actor_name,
    actor_function: args.actor_function,
    gold_id: goldId,
  });
  void import("./hillclimb")
    .then(({ runGapPromptHillclimb }) =>
      runGapPromptHillclimb({
        actor_name: args.actor_name,
        actor_function: args.actor_function,
        trigger: `feedback:${args.kind}:${args.gap_id}`,
      }),
    )
    .then((hill) => patchFeedback(feedbackId, { hillclimb_run_id: hill.run_id }))
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : "Hill-climb failed";
      await patchFeedback(feedbackId, { error: message });
    });
  return { feedback_id: feedbackId, gold_id: goldId };
}
