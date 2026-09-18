import { notFound } from "next/navigation";
import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { CoverageBadge, LockMeta, TacticBadge } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { TACTIC_STATUSES, TACTIC_TYPE_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function TacticDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await loadState();
  const tactic = state.tactics.find((x) => x.id === id);
  if (!tactic) notFound();
  const maps = state.coverages.filter((c) => c.tactic_id === tactic.id);

  return (
    <AppShell active="tactics">
      <PageIntro kicker={TACTIC_TYPE_LABELS[tactic.type]} title={tactic.name}>
        {tactic.description}
      </PageIntro>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TacticBadge status={tactic.status} />
        <LockMeta lock={tactic.lock} />
      </div>
      <dl className="mb-6 grid gap-2 text-[13px] sm:grid-cols-2">
        <Item k="Question" v={tactic.evidence_question} />
        <Item k="Population" v={tactic.population} />
        <Item k="Intervention" v={tactic.intervention} />
        <Item k="Comparator" v={tactic.comparator} />
        <Item k="Outcomes" v={tactic.outcomes} />
        <Item k="Geography" v={tactic.geography} />
        <Item k="Design" v={tactic.study_design} />
        <Item k="Evidence available" v={tactic.evidence_available ?? "—"} />
        <Item k="Owner" v={`${tactic.owner} · ${tactic.function.replaceAll("_", " ")}`} />
        <Item k="Budget" v={tactic.budget ?? "—"} />
      </dl>
      <h2 className="mb-2 text-[13px] text-muted-foreground">Gaps this tactic is mapped to</h2>
      <div className="mb-6 grid gap-2">
        {maps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No mappings yet.</p>
        ) : (
          maps.map((c) => {
            const gap = state.gaps.find((g) => g.id === c.gap_id);
            return (
              <Link key={c.id} href={`/gaps/${c.gap_id}`} className="flex justify-between border border-border bg-card p-3 no-underline">
                <span>{gap?.name}</span>
                <CoverageBadge overall={c.overall} />
              </Link>
            );
          })
        )}
      </div>
      <LockForm label="Lock tactic status" action="lock_tactic" extra={{ tactic_id: tactic.id }}>
        <p className="text-[12px] text-muted-foreground">
          Changing status marks related coverage outdated for review (tactic or sources
          changed). Residuals stay open for a human to reassess. Nothing auto-closes.
        </p>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Status
          <select name="status" defaultValue={tactic.status} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {TACTIC_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </LockForm>
    </AppShell>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}
