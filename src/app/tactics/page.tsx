import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { TacticBadge } from "@/components/iegp-badges";
import { TACTIC_TYPE_LABELS, TACTIC_TYPES } from "@/lib/iegp/enums";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function TacticsPage() {
  const state = await loadState();
  return (
    <AppShell active="tactics">
      <PageIntro kicker="Structured objects, not a text field" title="Tactics">
        Generation and dissemination are both tactics. One tactic can map to many gaps
        (see the prospective registry). Human-authored proposals only — no AI ideation in v1.
      </PageIntro>

      <div className="mb-6 border border-border bg-card p-4">
        <h2 className="mb-3 text-[13px] text-foreground">Propose a tactic</h2>
        <LockForm label="Create proposed tactic" action="create_tactic">
          <input name="name" required placeholder="Name" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <select name="type" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {TACTIC_TYPES.map((ty) => (
              <option key={ty} value={ty}>{TACTIC_TYPE_LABELS[ty]}</option>
            ))}
          </select>
          <textarea name="description" placeholder="Description" className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm" />
          <input name="evidence_question" required placeholder="Evidence question" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <input name="population" placeholder="Population" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <input name="intervention" placeholder="Intervention" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <input name="comparator" placeholder="Comparator" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <input name="outcomes" placeholder="Outcomes" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <input name="geography" placeholder="Geography" defaultValue="US + EU5" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <input name="owner" placeholder="Owner" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <select name="function" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {ACTOR_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>{FUNCTION_LABELS[fn]}</option>
            ))}
          </select>
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Residual ids (comma)
            <input name="residual_ids" placeholder="RES-001" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          </label>
        </LockForm>
      </div>

      <div className="grid gap-3">
        {state.tactics.map((tac) => {
          const maps = state.coverages.filter((c) => c.tactic_id === tac.id);
          return (
            <Link key={tac.id} href={`/tactics/${tac.id}`} className="border border-border bg-card p-4 no-underline">
              <div className="flex flex-wrap items-center gap-2">
                <TacticBadge status={tac.status} />
                <span className="text-[12px] text-muted-foreground">
                  {TACTIC_TYPE_LABELS[tac.type]}
                </span>
              </div>
              <p className="mt-2 text-[14px] text-foreground">{tac.name}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{tac.evidence_question}</p>
              <p className="mt-2 text-[12px] text-muted-foreground">
                Maps to {maps.length} gap{maps.length === 1 ? "" : "s"}
                {maps.length ? `: ${maps.map((m) => state.gaps.find((g) => g.id === m.gap_id)?.name).join("; ")}` : ""}
              </p>
            </Link>
          );
        })}
      </div>
    </AppShell>
  );
}
