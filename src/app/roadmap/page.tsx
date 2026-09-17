import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { LockMeta, TacticBadge } from "@/components/iegp-badges";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function RoadmapPage() {
  const state = await loadState();
  const forward = state.tactics.filter((t) =>
    t.status === "ongoing" || t.status === "planned" || t.status === "proposed",
  );
  const items = forward
    .map((tactic) => ({
      tactic,
      item: state.roadmap.find((r) => r.tactic_id === tactic.id),
    }))
    .sort((a, b) => (a.item?.start_date ?? a.tactic.start_date ?? "9999").localeCompare(b.item?.start_date ?? b.tactic.start_date ?? "9999"));

  return (
    <AppShell active="roadmap">
      <PageIntro kicker="Forward plan" title="Integrated evidence-generation roadmap">
        Ongoing, planned and proposed tactics only. Completed tactics stay on the gap/tactic
        dossier. Priority is not automatic inclusion — a residual must be accepted onto a tactic
        here.
      </PageIntro>
      <ol className="grid gap-3">
        {items.map(({ tactic, item }) => (
          <li key={tactic.id} className="border border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <TacticBadge status={tactic.status} />
              <Link href={`/tactics/${tactic.id}`} className="text-[14px] text-foreground">
                {tactic.name}
              </Link>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {item?.start_date ?? tactic.start_date ?? "Start TBD"} →{" "}
              {item?.evidence_available ?? tactic.evidence_available ?? "Evidence TBD"} ·{" "}
              {item?.owner ?? tactic.owner}
            </p>
            {item?.note ? <p className="mt-1 text-[12px] text-muted-foreground">{item.note}</p> : null}
            {item?.residual_ids.length ? (
              <p className="mt-1 text-[12px] text-muted-foreground">
                Residuals: {item.residual_ids.join(", ")}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {item ? <LockMeta lock={item.lock} /> : <span className="text-[11px] text-amber-300">Not yet on locked roadmap</span>}
              <LockForm
                label={item ? "Re-lock roadmap row" : "Accept onto roadmap"}
                action="lock_roadmap"
                extra={{ tactic_id: tactic.id }}
              >
                <input name="owner" defaultValue={item?.owner ?? tactic.owner} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
                <input name="start_date" defaultValue={item?.start_date ?? tactic.start_date ?? ""} placeholder="Start YYYY-MM-DD" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
                <input name="evidence_available" defaultValue={item?.evidence_available ?? tactic.evidence_available ?? ""} placeholder="Evidence YYYY-MM-DD" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
                <input name="residual_ids" defaultValue={item?.residual_ids.join(",") ?? ""} placeholder="RES- ids comma separated" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
              </LockForm>
            </div>
          </li>
        ))}
      </ol>
    </AppShell>
  );
}
