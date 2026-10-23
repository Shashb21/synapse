"use client";

import { useState } from "react";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { useAiEnabled } from "@/components/platform/ai-status";
import { BAND_LABELS, BANDS } from "@/components/matrix/bands";
import { placementGapError, scoreError } from "./score-input";
import type { PriorityAxis } from "@/modules/stages/s8-prioritization/axis-math";
import type { PrioritizeGap } from "./prioritize-matrix";

/** Existing S8 editors; every submission carries the displayed saved snapshot. */
export function GapPriorityActions({ gap, xAxis, yAxis, identity, mayPrioritize }: {
  gap: PrioritizeGap; xAxis: PriorityAxis; yAxis: PriorityAxis;
  identity: ActionIdentity; mayPrioritize: boolean;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const confirmed = () => setSaved("Priority validated across all settings.");
  const ai = useAiEnabled("prioritization");
  const band = gap.band ?? gap.suggested_band;
  const point = typeof gap.axis_scores?.[xAxis.id] === "number" && typeof gap.axis_scores?.[yAxis.id] === "number";
  return <section className="mb-5 grid gap-2" aria-label="Priority actions">
      <h3 className="text-[14px] font-medium text-foreground">3. Validate priority</h3>
      <p className="text-[12px] leading-5 text-muted-foreground">Save scores as a draft while reviewing placement. Validate priority with your reason when you are ready; it applies across all settings.</p>
      <p role="status" aria-atomic="true" className="text-[12px] text-foreground">{saved}</p>
      <div className="flex flex-wrap gap-2">
      {ai && band && mayPrioritize && !gap.validated && !gap.needs_review && !gap.human_band && !gap.human_axes?.length && gap.support_status === "supported" ? (
        <ActionDialog onOpenChange={(open) => { if (open) setSaved(null); }} protectUnsavedChanges endpoint="/api/plan"
          onSuccess={confirmed}
          payload={{ action: "accept_priority_suggestion", gap_id: gap.gap_id, band: gap.suggested_band, expected_version: gap.version ?? null }}
          label="Accept supported AI suggestion" title={`Accept AI priority for ${gap.gap_name}`}
          description="Inspect the supporting records before accepting this suggestion. Your reason and its references will be retained in history."
          confirmLabel="Accept supported AI suggestion" requireRationale rationaleFieldName="reason" rationaleLabel="Reason for acceptance (required)" identity={identity} />
      ) : null}
      {mayPrioritize ? (
        <ActionDialog onOpenChange={(open) => { if (open) setSaved(null); }} protectUnsavedChanges
          endpoint="/api/plan"
          onSuccess={(result) => setSaved((result.placement as { validated?: boolean } | undefined)?.validated ? "Priority validated across all settings." : "Draft placement saved. Validate priority when you are ready.")}
          payload={{ action: "set_placement", gap_id: gap.gap_id, x_axis: xAxis.id, y_axis: yAxis.id, expected_version: gap.version ?? null, expected_context_version: gap.context_version ?? null }}
          fields={[
            { name: "rationale", label: "Priority rationale (optional)", type: "textarea", defaultValue: gap.rationale ?? "", hint: "Why this priority is appropriate. Kept separately from the reason for this change." },
            {
              name: "y_score",
              label: `${yAxis.label} score (0–100)`,
              defaultValue:
                typeof gap.axis_scores?.[yAxis.id] === "number" ? String(gap.axis_scores[yAxis.id]) : "",
              placeholder: "0–100",
              hint: `0 = ${yAxis.low_label}, 100 = ${yAxis.high_label}. Leave empty to keep it unscored.`,
              validate: (value) => scoreError(yAxis.label, value),
            },
            {
              name: "x_score",
              label: `${xAxis.label} score (0–100)`,
              defaultValue:
                typeof gap.axis_scores?.[xAxis.id] === "number" ? String(gap.axis_scores[xAxis.id]) : "",
              placeholder: "0–100",
              hint: `0 = ${xAxis.low_label}, 100 = ${xAxis.high_label}. Leave empty to keep it unscored.`,
              validate: (value) => scoreError(xAxis.label, value),
            },
            {
              name: "band",
              label: "Band",
              type: "select",
              defaultValue: "",
              options: [
                { value: "", label: point ? "The quadrant the scores fall in" : "The quadrant (needs both scores)" },
                ...BANDS.map((value) => ({ value, label: BAND_LABELS[value] })),
              ],
              // Customers aren't told about AI when it is off (KAN-53).
              hint: ai
                ? "A band you set here is yours: a later model run keeps it and only updates its own suggestion."
                : "A band you set here is kept until you change it.",
            },
            {
              name: "validate",
              label: "Validate priority now",
              type: "select",
              defaultValue: "no",
              options: [
                { value: "no", label: "No — keep it as a draft" },
                { value: "yes", label: "Yes — validate priority" },
              ],
            },
          ]}
          validateForm={(values) =>
            placementGapError({
              x: { label: xAxis.label, typed: values.x_score ?? "", saved: gap.axis_scores?.[xAxis.id] },
              y: { label: yAxis.label, typed: values.y_score ?? "", saved: gap.axis_scores?.[yAxis.id] },
              band: values.band ?? "",
            })
          }
          label={band ? "Edit scores" : "Set priority"}
          title={`${point ? "Edit the placement of" : "Place"} ${gap.gap_name}`}
          description={
            ai
              ? "Type the exact axis scores and, if you want, the band. No model run is needed; what you set is kept across re-runs."
              : "Type the exact axis scores and, if you want, the band."
          }
          confirmLabel="Save placement"
          requireRationale
          rationaleFieldName="reason"
          rationaleLabel="Reason for change (required)"
          identity={identity}
          variant="outline"
          size="sm"
        />
      ) : null}
      {band && mayPrioritize ? (
        <ActionDialog onOpenChange={(open) => { if (open) setSaved(null); }} protectUnsavedChanges
          endpoint="/api/plan"
          onSuccess={confirmed}
          payload={{ action: "validate_band", gap_id: gap.gap_id, band, expected_version: gap.version ?? null, expected_context_version: gap.context_version ?? null }}
          label={gap.needs_review ? "Review changed context and revalidate priority" : gap.validated ? "Review or change validated priority" : ai && (gap.run_id || gap.suggested_rationale) && !gap.human_band ? "Make manual judgement" : "Validate priority"}
          title={`Validate ${BAND_LABELS[band]} priority for ${gap.gap_name}`}
          description="Make an explicit manual judgement across all settings and record your own reason. Supporting references are not required for a manual judgement, including when you retain the same band and scores."
          confirmLabel="Validate priority"
          requireRationale
          rationaleFieldName="reason"
          rationaleLabel="Reason for change (required)"
          identity={identity}
          variant={gap.validated ? "outline" : "default"}
          size="sm"
        />
      ) : null}
      </div>
  </section>;
}
