import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { LockMeta } from "@/components/iegp-badges";
import { Badge } from "@/components/ui/badge";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { DOMAIN_LABELS, EVIDENCE_DOMAINS, FUNCTION_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { sessionContext } from "@/modules/auth/session";
import { listRejectedGapCandidates } from "@/app/api/iegp/promote-candidates";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function NeedsPage() {
  const [state, session, rejected, ai] = await Promise.all([
    loadState(),
    sessionContext(),
    listRejectedGapCandidates(),
    aiEnabled().catch(() => true),
  ]);
  const identity: ActionIdentity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
  const filter = ["candidate", "accepted", "rejected"] as const;
  const gapOptions = state.gaps
    .filter((g) => !g.retired)
    .map((g) => ({ value: g.id, label: `${g.id} · ${g.name}` }));
  const pendingRejected = rejected.filter((row) => !row.committed_gap_id);
  const promotedRejected = rejected.filter((row) => row.committed_gap_id);

  return (
    <AppShell active="needs">
      <PageIntro kicker="Atomic sourced statements" title="Evidence needs">
        A stakeholder quote is a <strong>candidate</strong> need, never an automatic gap.
        Accepted needs join onto a named gap. The sentence is stored once. Edit a need&apos;s
        wording, or move it to another gap when the AI merged it into the wrong one — later runs
        never undo your change.
      </PageIntro>
      <div className="grid gap-4">
        {filter.map((status) => {
          const rows = state.needs.filter((n) => n.status === status);
          return (
            <section key={status}>
              <h2 className="mb-2 text-[13px] capitalize text-muted-foreground">
                {status} ({rows.length})
              </h2>
              {rows.length === 0 ? (
                <p className="mb-4 text-[12px] text-muted-foreground">
                  {status === "candidate"
                    ? ai
                      ? "Empty. Ingest a demo source to extract candidate needs, or add one by hand on a gap."
                      : "Empty. AI is off: add a need by hand on a gap."
                    : "None."}
                </p>
              ) : (
              <div className="grid gap-3">
                {rows.map((n) => {
                  const source = state.sources.find((s) => s.id === n.source_id);
                  const links = state.need_gap_links.filter((l) => l.need_id === n.id);
                  return (
                    <article key={n.id} className="border border-border bg-card p-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{DOMAIN_LABELS[n.domain]}</Badge>
                        <Badge variant="outline">{FUNCTION_LABELS[n.stakeholder]}</Badge>
                        <span className="text-[11px] text-muted-foreground">{n.id}</span>
                      </div>
                      <p className="mt-3 text-[13px] leading-5 text-foreground">{n.statement}</p>
                      <p className="mt-2 text-[12px] text-muted-foreground">
                        “{n.source_quote}” · {source?.title}
                        {n.population ? ` · ${n.population}` : ""}
                        {n.comparator ? ` · vs ${n.comparator}` : ""}
                      </p>
                      {links.length > 0 ? (
                        <ul className="mt-3 grid gap-2">
                          {links.map((l) => {
                            const gap = state.gaps.find((g) => g.id === l.gap_id);
                            const targets = [
                              ...gapOptions.filter((option) => option.value !== l.gap_id),
                              { value: "__new__", label: "A new gap made from this need" },
                            ];
                            return (
                              <li key={l.gap_id} className="flex flex-wrap items-center gap-2">
                                <Link
                                  href={`/gaps/${l.gap_id}`}
                                  className="text-[12px] text-muted-foreground"
                                >
                                  {gap?.name ?? l.gap_id} ({l.role})
                                </Link>
                                <ActionDialog
                                  endpoint="/api/iegp"
                                  payload={{ action: "move_need", need_id: n.id, from_gap_id: l.gap_id }}
                                  identity={identity}
                                  label="Move"
                                  description="Moves this need off this gap onto another one, or onto a new gap."
                                  confirmLabel="Move need"
                                  fields={[
                                    {
                                      name: "to_gap_id",
                                      label: "Move onto",
                                      type: "select",
                                      defaultValue: targets[0]?.value,
                                      options: targets,
                                      required: true,
                                    },
                                    {
                                      name: "new_gap_name",
                                      label: "Name for the new gap (only when moving to a new gap)",
                                      placeholder: "Blank: derived from the need",
                                    },
                                  ]}
                                />
                                <ActionDialog
                                  endpoint="/api/iegp"
                                  payload={{ action: "unlink_need", need_id: n.id, gap_id: l.gap_id }}
                                  identity={identity}
                                  label="Unlink"
                                  description="Removes this need from the gap. A live gap keeps at least one need."
                                  confirmLabel="Unlink need"
                                />
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <LockMeta lock={n.status_lock} />
                        <ActionDialog
                          endpoint="/api/iegp"
                          payload={{ action: "edit_need", need_id: n.id }}
                          identity={identity}
                          label="Edit need"
                          description="Correct the need's wording or its source quote. The edit is locked to you and kept on later AI runs."
                          confirmLabel="Save edit"
                          fields={[
                            { name: "statement", label: "Statement", type: "textarea", defaultValue: n.statement, required: true },
                            { name: "source_quote", label: "Source quote", type: "textarea", defaultValue: n.source_quote },
                          ]}
                        />
                        {status === "candidate" ? (
                          <>
                            <LockForm
                              label="Accept onto gap"
                              action="lock_need"
                              extra={{ need_id: n.id, status: "accepted" }}
                            >
                              <label className="grid gap-1 text-[12px] text-muted-foreground">
                                Gap
                                <select
                                  name="gap_id"
                                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                                  defaultValue={gapOptions[0]?.value}
                                >
                                  {gapOptions.map((g) => (
                                    <option key={g.value} value={g.value}>
                                      {g.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </LockForm>
                            <LockForm
                              label="Reject"
                              action="lock_need"
                              extra={{ need_id: n.id, status: "rejected" }}
                            />
                          </>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
              )}
            </section>
          );
        })}
        {/* With AI off nothing new is rejected; the list shows only if earlier runs left some. */}
        {ai || rejected.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[13px] text-muted-foreground">
            Rejected by the AI ({pendingRejected.length})
          </h2>
          <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
            Gap candidates the S2 judge rejected. If the AI was wrong, promote one: it becomes a
            gap you created, with its source quote as the first need.
          </p>
          {pendingRejected.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">None.</p>
          ) : (
            <div className="grid gap-3">
              {pendingRejected.map((row) => {
                const source = state.sources.find((s) => s.id === row.source_id);
                return (
                  <article key={row.id} className="border border-border bg-card/40 p-4">
                    <p className="text-[13px] text-foreground">{row.name}</p>
                    <p className="mt-1 text-[12px] leading-5 text-foreground">{row.statement}</p>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      “{row.source_quote}” · {source?.title ?? row.source_id}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      AI reason: {row.critic_note} · score {row.score}
                    </p>
                    <div className="mt-2">
                      <ActionDialog
                        endpoint="/api/iegp"
                        payload={{ action: "promote_gap_candidate", candidate_id: row.id }}
                        identity={identity}
                        label="Promote to gap"
                        description="Creates this candidate as a gap by hand, overriding the AI's rejection. Adjust the wording first if needed."
                        confirmLabel="Create gap"
                        fields={[
                          { name: "name", label: "Name", defaultValue: row.name, required: true },
                          { name: "statement", label: "Statement", type: "textarea", defaultValue: row.statement, required: true },
                          {
                            name: "domain",
                            label: "Domain",
                            type: "select",
                            defaultValue: row.domain,
                            options: EVIDENCE_DOMAINS.map((domain) => ({ value: domain, label: DOMAIN_LABELS[domain] })),
                          },
                        ]}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {promotedRejected.length > 0 ? (
            <p className="mt-3 text-[12px] text-muted-foreground">
              Promoted by hand:{" "}
              {promotedRejected.map((row, index) => (
                <span key={row.id}>
                  {index > 0 ? " · " : ""}
                  <Link href={`/gaps/${row.committed_gap_id}`} className="text-foreground">
                    {row.name}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
        </section>
        ) : null}
      </div>
    </AppShell>
  );
}
