import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { TacticsPlace } from "@/components/tactics-place";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { buildPlanWorkspace, planGates } from "@/lib/iegp/engine";
import { CATCH_UP_TACTIC_STATUSES, TACTIC_TYPE_LABELS, TACTIC_TYPES } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { sessionContext } from "@/modules/auth/session";
import { listRejectedTacticCandidates } from "@/app/api/iegp/promote-candidates";

export const dynamic = "force-dynamic";

export default async function TacticsPage() {
  const [state, session, rejected] = await Promise.all([
    loadState(),
    sessionContext(),
    listRejectedTacticCandidates(),
  ]);
  const workspace = buildPlanWorkspace(state);
  const gates = planGates(state);
  const identity: ActionIdentity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
  const gapOptions = [
    { value: "", label: "Do not map yet" },
    ...state.gaps
      .filter((g) => !g.retired && g.status !== "excluded" && !g.parked_at)
      .map((g) => ({ value: g.id, label: `${g.id} · ${g.name}` })),
  ];
  const pending = rejected.filter((row) => !row.promoted_tactic_id);
  return (
    <AppShell active="tactics">
      <PageIntro kicker="Open gaps only" title="Tactics">
        Create and assign proposed tactics for Open gaps after they are prioritized. Proposed tactics
        do not change gap status until they are planned, ongoing, or completed. Recording missed
        real studies happens on Gaps.
      </PageIntro>
      <TacticsPlace
        unlocked={gates.tacticsUnlocked}
        openGaps={workspace.openGaps}
        availableTactics={workspace.availableTactics}
      />
      <section className="mt-8">
        <h2 className="mb-2 text-[13px] text-muted-foreground">Rejected by the AI ({pending.length})</h2>
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          Tactic candidates the S3 judge rejected. If a real study was dropped, promote it: it is
          recorded by hand with its source quote, and can be mapped onto a gap at once.
        </p>
        {pending.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">None.</p>
        ) : (
          <div className="grid gap-3">
            {pending.map((row) => {
              const source = state.sources.find((s) => s.id === row.source_id);
              return (
                <article key={row.id} className="border border-border bg-card/40 p-4">
                  <p className="text-[13px] text-foreground">{row.name}</p>
                  <p className="mt-1 text-[12px] text-foreground">{row.evidence_question}</p>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    “{row.source_quote}” · {source?.title ?? row.source_id}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    AI reason: {row.critic_note} · score {row.score}
                  </p>
                  <div className="mt-2">
                    <ActionDialog
                      endpoint="/api/iegp"
                      payload={{ action: "promote_tactic_candidate", candidate_id: row.id }}
                      identity={identity}
                      label="Promote to tactic"
                      description="Records this candidate as a real tactic by hand, overriding the AI's rejection."
                      confirmLabel="Record tactic"
                      fields={[
                        { name: "name", label: "Name", defaultValue: row.name, required: true },
                        {
                          name: "type",
                          label: "Type",
                          type: "select",
                          defaultValue: row.type,
                          options: TACTIC_TYPES.map((type) => ({ value: type, label: TACTIC_TYPE_LABELS[type] })),
                        },
                        {
                          name: "status",
                          label: "Status",
                          type: "select",
                          defaultValue: (CATCH_UP_TACTIC_STATUSES as readonly string[]).includes(row.status)
                            ? row.status
                            : "planned",
                          options: CATCH_UP_TACTIC_STATUSES.map((status) => ({ value: status, label: status })),
                        },
                        {
                          name: "evidence_question",
                          label: "Evidence question",
                          type: "textarea",
                          defaultValue: row.evidence_question,
                          required: true,
                        },
                        { name: "gap_id", label: "Map onto gap", type: "select", defaultValue: "", options: gapOptions },
                      ]}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {rejected.length > pending.length ? (
          <p className="mt-3 text-[12px] text-muted-foreground">
            Promoted by hand:{" "}
            {rejected
              .filter((row) => row.promoted_tactic_id)
              .map((row, index) => (
                <span key={row.id}>
                  {index > 0 ? " · " : ""}
                  <Link href={`/tactics/${row.promoted_tactic_id}`} className="text-foreground">
                    {row.name}
                  </Link>
                </span>
              ))}
          </p>
        ) : null}
      </section>
    </AppShell>
  );
}
