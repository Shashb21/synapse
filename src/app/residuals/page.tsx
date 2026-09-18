import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { LockMeta, PriorityBadge } from "@/components/iegp-badges";
import { PRIORITY_BANDS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function ResidualsPage() {
  const state = await loadState();
  const rows = state.residuals.map((r) => {
    const gap = state.gaps.find((g) => g.id === r.gap_id)!;
    const pri = state.priorities.find((p) => p.residual_id === r.id);
    return { r, gap, pri };
  });
  const bandRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  rows.sort((a, b) => {
    const aRank = a.pri?.lock.locked ? bandRank[a.pri.band] : 8;
    const bRank = b.pri?.lock.locked ? bandRank[b.pri.band] : 8;
    if (aRank !== bRank) return aRank - bRank;
    return a.gap.name.localeCompare(b.gap.name);
  });

  return (
    <AppShell active="residuals">
      <PageIntro kicker="Coverage ≠ priority" title="Residual evidence needs">
        A leftover is the open portion of a parent gap after tactics are pressure-tested. Residual
        drafts are validated in Review — accept as a new gap, reject, or modify. The original gap
        stays. Priority is a human lock. The engine does not assign a band.
      </PageIntro>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No leftovers queued here. Residual drafts live on Review with extracted gaps and tactics.
        </p>
      ) : (
      <div className="grid gap-4">
        {rows.map(({ r, gap, pri }) => (
          <article key={r.id} className="border border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              {pri?.lock.locked ? (
                <PriorityBadge band={pri.band} />
              ) : (
                <span className="text-[11px] text-amber-300">Priority unlocked — human gate</span>
              )}
              <Link href={`/gaps/${gap.id}`} className="text-[12px] text-muted-foreground">
                Parent: {gap.name}
              </Link>
            </div>
            <p className="mt-2 text-[13px] text-foreground">{r.statement}</p>
            <p className="mt-2 text-[12px] text-muted-foreground">{r.draft_rationale}</p>
            {pri?.override_reason ? (
              <p className="mt-2 text-[12px] text-muted-foreground">{pri.override_reason}</p>
            ) : null}
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
                  Band (you choose)
                  <select name="band" defaultValue={pri?.band ?? ""} required className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
                    <option value="" disabled>
                      Choose a band
                    </option>
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
      )}
    </AppShell>
  );
}
