import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { LockMeta, PriorityBadge } from "@/components/iegp-badges";
import { PRIORITY_BANDS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { suggestPriority } from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

export default async function ResidualsPage() {
  const state = await loadState();
  const rows = state.residuals.map((r) => {
    const gap = state.gaps.find((g) => g.id === r.gap_id)!;
    const objective = state.objectives.find((o) => o.id === gap.objective_id)!;
    const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
    const suggested = suggestPriority({ residual: r, objective, coverages });
    const pri = state.priorities.find((p) => p.residual_id === r.id);
    return { r, gap, suggested, pri };
  });
  rows.sort((a, b) => (b.pri?.suggested_score ?? b.suggested.score) - (a.pri?.suggested_score ?? a.suggested.score));

  return (
    <AppShell active="residuals">
      <PageIntro kicker="Coverage ≠ priority" title="Residual evidence needs">
        A residual is the open portion of a parent gap after tactics are mapped. The original gap
        stays. Suggested score uses decision criticality × residual severity × stakeholder ×
        time-to-need. Effort/cost live on the tactic. Engine never puts a residual on the roadmap.
      </PageIntro>
      <div className="grid gap-4">
        {rows.map(({ r, gap, suggested, pri }) => (
          <article key={r.id} className="border border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              {pri ? <PriorityBadge band={pri.band} /> : <span className="text-[11px] text-amber-300">Priority unlocked</span>}
              <Link href={`/gaps/${gap.id}`} className="text-[12px] text-muted-foreground">
                Parent: {gap.name}
              </Link>
            </div>
            <p className="mt-2 text-[13px] text-foreground">{r.statement}</p>
            <p className="mt-2 text-[12px] text-muted-foreground">{r.draft_rationale}</p>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Suggested {suggested.score} / {suggested.band}
              {pri?.override_reason ? ` · locked ${pri.band} (${pri.override_reason})` : ""}
            </p>
            <ul className="mt-1 text-[11px] text-muted-foreground">
              {(pri?.reasons ?? suggested.reasons).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <LockMeta lock={r.lock} />
              <LockForm label="Lock residual text" action="lock_residual" extra={{ residual_id: r.id }}>
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Statement
                  <textarea name="statement" defaultValue={r.statement} className="min-h-20 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm" />
                </label>
              </LockForm>
              <LockForm label="Lock priority band" action="lock_priority" extra={{ residual_id: r.id }}>
                <label className="grid gap-1 text-[12px] text-muted-foreground">
                  Band
                  <select name="band" defaultValue={pri?.band ?? suggested.band} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
                    {PRIORITY_BANDS.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </label>
              </LockForm>
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
