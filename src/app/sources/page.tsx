import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS, ACTOR_FUNCTIONS, FUNCTION_LABELS } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const state = await loadState();
  return (
    <AppShell active="sources">
      <PageIntro kicker="Interviews, TLR, internal materials" title="Sources">
        Upload a note. The engine extracts candidate gaps and tactics, drafts residual evidence
        needs, and marks related coverage stale. Humans then accept, reject, or modify gaps on
        the plan — the engine does not prioritize.
      </PageIntro>

      <div className="mb-6 border border-border bg-card p-4">
        <h2 className="mb-3 text-[13px] text-foreground">Ingest a note</h2>
        <LockForm label="Ingest gaps and tactics" action="ingest" confirmLabel="Ingest">
          <input name="title" required placeholder="Title" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <select name="source_type" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</option>
            ))}
          </select>
          <select name="stakeholder_function" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {ACTOR_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>{FUNCTION_LABELS[fn]}</option>
            ))}
          </select>
          <textarea
            name="text"
            required
            placeholder="Paste interview notes or TLR findings. Gap cues such as 'need to understand' or 'limited evidence' become candidate gaps. Mentions of trials, registries, chart reviews, or publications become extracted tactics."
            className="min-h-28 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </LockForm>
      </div>

      <div className="grid gap-3">
        {state.sources.map((s) => {
          const needCount = state.needs.filter((n) => n.source_id === s.id).length;
          const gapCount = state.need_gap_links.filter((l) =>
            state.needs.some((n) => n.id === l.need_id && n.source_id === s.id),
          ).length;
          const tacticCount = state.tactics.filter((tac) =>
            tac.intended_use.includes(s.id) || tac.data_source === s.title,
          ).length;
          return (
            <article key={s.id} className="border border-border bg-card p-4">
              <p className="text-[13px] text-foreground">{s.title}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {SOURCE_TYPE_LABELS[s.source_type]} · {FUNCTION_LABELS[s.stakeholder_function]} ·{" "}
                {needCount} need{needCount === 1 ? "" : "s"} · {gapCount} linked gap
                {gapCount === 1 ? "" : "s"}
                {tacticCount ? ` · ${tacticCount} extracted tactic${tacticCount === 1 ? "" : "s"}` : ""}
              </p>
              <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                {s.full_text.slice(0, 280)}
                {s.full_text.length > 280 ? "…" : ""}
              </p>
            </article>
          );
        })}
      </div>
    </AppShell>
  );
}
