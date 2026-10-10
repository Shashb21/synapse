import Link from "next/link";
import type { ReactNode } from "react";
import type { GapRecord } from "@/lib/iegp/gap-record";
import { gapNumberLabel } from "@/lib/iegp/gap-number";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";

const HEADING = "mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const CARD = "rounded-lg border border-border bg-card p-3 text-[13px]";

function when(at: string | null | undefined): string {
  return at ? at.replace("T", " ").slice(0, 16) : "—";
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="mb-8" data-testid={testId}>
      <h2 className={HEADING}>{title}</h2>
      {children}
    </section>
  );
}

function GapLink({ gap }: { gap: { id: string; name: string; number: number } }) {
  return (
    <Link href={`/gaps/${gap.id}`} className="text-foreground underline-offset-2 hover:underline">
      {gapNumberLabel(gap.number)} {gap.name}
    </Link>
  );
}

/**
 * Who confirmed the gap and which objective it serves (KAN-97). The objective
 * can be changed here; the change is on the gap's history.
 */
export function GapConfirmationAndObjective({
  record,
  objectives,
  identity,
}: {
  record: GapRecord;
  objectives: { id: string; name: string }[];
  identity: ActionIdentity;
}) {
  const { confirmation, objective, gap, origin } = record;
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2" data-testid="gap-confirmation">
      <div className={CARD}>
        <p className="text-[12px] font-medium text-muted-foreground">Confirmation</p>
        {confirmation.confirmed && confirmation.by ? (
          <p className="mt-1">
            Confirmed by <span className="font-medium">{confirmation.by.name}</span>
            {confirmation.by.principal && confirmation.by.principal !== "anonymous" ? ` (${confirmation.by.principal})` : null}
            {" · "}
            {when(confirmation.at)}
            {confirmation.rationale ? <span className="block text-muted-foreground">“{confirmation.rationale}”</span> : null}
          </p>
        ) : confirmation.confirmed ? (
          <p className="mt-1">Confirmed (before who confirmed was recorded).</p>
        ) : (
          <p className="mt-1 text-muted-foreground">Not confirmed yet. Validate the gap to confirm it.</p>
        )}
        {origin ? (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Taken from <GapLink gap={origin} /> by an accepted split suggestion.
          </p>
        ) : null}
      </div>
      <div className={CARD} data-testid="gap-objective">
        <p className="text-[12px] font-medium text-muted-foreground">Objective it serves</p>
        <p className="mt-1">{objective ? `${objective.id} · ${objective.name}` : "No objective linked yet."}</p>
        {gap.retired || objectives.length === 0 ? null : (
          <div className="mt-2">
            <ActionDialog
              endpoint="/api/iegp"
              payload={{ action: "set_gap_objective", gap_id: gap.id }}
              identity={identity}
              label="Change objective"
              title={`Objective for ${gapNumberLabel(gap.number)}`}
              description="The plan objective whose decision this gap's evidence serves. The change is kept on the gap's history."
              confirmLabel="Save objective"
              fields={[
                {
                  name: "objective_id",
                  label: "Objective",
                  type: "select",
                  defaultValue: objective?.id ?? objectives[0]!.id,
                  options: objectives.map((o) => ({ value: o.id, label: `${o.id} · ${o.name}` })),
                  required: true,
                },
                { name: "rationale", label: "Why (optional)", type: "textarea" },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Where a need came from: the S2 run and candidate, and the block it quotes (KAN-97). */
export function NeedProvenance({ entry }: { entry: GapRecord["needs"][number] }) {
  const { need, candidate, block } = entry;
  if (!need.run_id && !candidate && !block) return null;
  return (
    <p className="mt-1 text-[11px] text-muted-foreground" data-testid="need-provenance">
      {block ? `From “${block.heading || block.location}”` : null}
      {block && (need.run_id || candidate) ? " · " : null}
      {need.run_id ? (
        <>
          Extracted in run{" "}
          <Link href={`/admin/runs/${need.run_id}`} className="underline-offset-2 hover:underline">
            {need.run_id}
          </Link>
        </>
      ) : null}
      {candidate ? ` · candidate scored ${candidate.score}${candidate.critic_note ? `: ${candidate.critic_note}` : ""}` : null}
    </p>
  );
}

/** Priority, ideas, timeline, groups and waiting suggestions: the rest of the gap's record (KAN-97). */
export function GapRecordSections({ record }: { record: GapRecord }) {
  const { priority, ideas, timeline, breakout_groups, pending_suggestions } = record;
  return (
    <>
      <Section title="Priority" testId="gap-priority">
        {priority ? (
          <div className={CARD}>
            <p>
              {priority.band ? <span className="font-medium capitalize">{priority.band}</span> : "No band yet"}
              {" · "}
              {priority.validated ? "validated" : "not validated"}
              {priority.actor_name ? ` · ${priority.actor_name}` : null}
              {" · "}
              {when(priority.at)}
            </p>
            {priority.rationale || priority.suggested_rationale ? (
              <p className="mt-1 text-muted-foreground">{priority.rationale || priority.suggested_rationale}</p>
            ) : null}
          </div>
        ) : (
          <p className={`${CARD} text-muted-foreground`}>Not on the prioritization matrix yet.</p>
        )}
      </Section>
      <Section title="Ideas" testId="gap-ideas">
        {ideas.length === 0 ? (
          <p className={`${CARD} text-muted-foreground`}>No tactic ideas for this gap yet.</p>
        ) : (
          <ul className="grid gap-2">
            {ideas.map((idea) => (
              <li key={idea.id} className={CARD}>
                <p className="text-[12px] text-muted-foreground">
                  {idea.status} · {idea.type.replace(/_/g, " ")}
                  {idea.tactic_id ? ` · became ${idea.tactic_id}` : null}
                </p>
                <p className="mt-1">{idea.name}</p>
                {idea.decision_rationale ? <p className="mt-1 text-muted-foreground">{idea.decision_rationale}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Timeline" testId="gap-timeline">
        {timeline.length === 0 ? (
          <p className={`${CARD} text-muted-foreground`}>No timeline activity for this gap yet.</p>
        ) : (
          <ul className="grid gap-2">
            {timeline.map((activity) => (
              <li key={activity.id} className={CARD}>
                <p>
                  {activity.tactic_id} · {activity.start_date} → {activity.end_date}
                  {activity.readout_date ? ` · readout ${activity.readout_date}` : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {breakout_groups.length > 0 ? (
        <Section title="Breakout groups" testId="gap-breakout-groups">
          <p className={CARD}>{breakout_groups.map((group) => group.name).join(", ")}</p>
        </Section>
      ) : null}
      {pending_suggestions.length > 0 ? (
        <Section title="Waiting suggestions" testId="gap-pending-suggestions">
          <ul className="grid gap-2">
            {pending_suggestions.map((row) => (
              <li key={row.id} className={CARD}>
                <p className="text-[12px] text-muted-foreground">Overlapping source waiting on a decision on Gaps</p>
                <p className="mt-1">{row.name}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
