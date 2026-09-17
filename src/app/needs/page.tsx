import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { LockMeta } from "@/components/iegp-badges";
import { Badge } from "@/components/ui/badge";
import { DOMAIN_LABELS, FUNCTION_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function NeedsPage() {
  const state = await loadState();
  const filter = ["candidate", "accepted", "rejected"] as const;

  return (
    <AppShell active="needs">
      <PageIntro kicker="Atomic sourced statements" title="Evidence needs">
        A stakeholder quote is a <strong>candidate</strong> need, never an automatic gap.
        Accepted needs join onto a named gap. The sentence is stored once.
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
                    ? "Empty. Ingest a demo source to extract candidate needs."
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
                        {links.map((l) => {
                          const gap = state.gaps.find((g) => g.id === l.gap_id);
                          return (
                            <Link
                              key={l.gap_id}
                              href={`/gaps/${l.gap_id}`}
                              className="text-[12px] text-muted-foreground"
                            >
                              {gap?.name} ({l.role})
                            </Link>
                          );
                        })}
                      </div>
                      <p className="mt-3 text-[13px] leading-5 text-foreground">{n.statement}</p>
                      <p className="mt-2 text-[12px] text-muted-foreground">
                        “{n.source_quote}” · {source?.title} · {n.population} · vs {n.comparator}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <LockMeta lock={n.status_lock} />
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
                                  defaultValue={state.gaps[0]?.id}
                                >
                                  {state.gaps.map((g) => (
                                    <option key={g.id} value={g.id}>
                                      {g.name}
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
      </div>
    </AppShell>
  );
}
