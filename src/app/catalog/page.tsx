import { AppShell, PageIntro } from "@/components/insight-card";
import { CatalogDecision } from "@/app/catalog/decision";
import { RESIDUAL_THEME_ID } from "@/lib/cluster/cluster";
import { getState } from "@/lib/store";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const state = await getState();
  const named = state.catalog.filter((c) => c.id !== RESIDUAL_THEME_ID);
  const open = state.catalog_proposals.filter((p) => p.status === "proposed");
  const decided = state.catalog_proposals.filter((p) => p.status !== "proposed");
  const unassigned = state.insights.filter((i) =>
    i.theme_ids.includes(RESIDUAL_THEME_ID),
  ).length;
  const byId = new Map(state.catalog.map((c) => [c.id, c]));

  return (
    <AppShell active="catalog">
      <PageIntro title="Catalog">
        The catalog is an ever-growing knowledge base of decision objects. CIR
        rows accumulate on ingest and stay once. Theme <em>names</em> grow only
        when a human accepts an emerge or split. The engine never invents a
        label, never auto-promotes, and never deletes a parent.
      </PageIntro>

      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="border border-border bg-card p-4">
          <p className="text-[11px] text-muted-foreground">Named themes</p>
          <p className="mt-1 text-[13px] font-medium">{named.length}</p>
        </div>
        <div className="border border-border bg-card p-4">
          <p className="text-[11px] text-muted-foreground">Unassigned CIR</p>
          <p className="mt-1 text-[13px] font-medium">{unassigned}</p>
        </div>
        <div className="border border-border bg-card p-4">
          <p className="text-[11px] text-muted-foreground">Open proposals</p>
          <p className="mt-1 text-[13px] font-medium">{open.length}</p>
        </div>
      </section>

      <section className="mb-8 space-y-4 border border-border bg-card p-4 text-[13px] leading-5 text-muted-foreground">
        <h2 className="text-[13px] font-medium text-foreground">
          How a claim is scored
        </h2>
        <p>
          Each CIR is scored against the current catalog: keyword hits (with
          light plurals), theme patterns, and a stakeholder prior. The best
          named theme that clears the floor becomes primary; a strong
          runner-up can join as secondary. Membership lives on{" "}
          <code className="text-[12px]">theme_links</code> — the statement is
          never copied onto a theme.
        </p>

        <h2 className="text-[13px] font-medium text-foreground">
          Unassigned versus a named theme
        </h2>
        <p>
          If the max named score stays under the floor, the claim lands in
          Unassigned. It is held once, not dropped, and not mashed into Access
          or Evidence because those decks were nearby.{" "}
          <Link href="/insights?theme=THEME-RESIDUAL" className="underline">
            View Unassigned
          </Link>
        </p>

        <h2 className="text-[13px] font-medium text-foreground">
          When a theme emerges
        </h2>
        <p>
          Unassigned CIR are clustered by shared language (not an embedding
          vibe). A cluster of two or more claims with cohesion ≥ 0.34 becomes
          an <strong>emerge</strong> proposal: suggested keywords and a
          placeholder name. A human names the decision. The engine does not
          auto-name or write the catalog on ingest. Accepting appends the
          entry, re-scores, and force-links those CIR onto the new theme
          (they leave Unassigned). Rejecting keeps them in Unassigned; the
          same fingerprint is not queued again.
        </p>

        <h2 className="text-[13px] font-medium text-foreground">
          When a theme splits
        </h2>
        <p>
          A named theme with four or more CIR splits when it is briefing two
          decision objects. Members are partitioned on the parent’s catalog
          keywords (formularies counts as formulary; CNS, intracranial,
          brain-mets, and n=28 are one family; discontinuation and
          persistence are another). The best exclusive pair, each side at
          least two claims, proposes a <strong>child</strong> from the smaller
          cohort. Accepting appends the child with parent lineage. The parent
          stays. Joins change; CIR rows are not copied. Example: Evidence
          gaps may yield a CNS RWE theme if intracranial package and 6-month
          discontinuation stop briefing as one situation.
        </p>

        <h2 className="text-[13px] font-medium text-foreground">
          What never happens
        </h2>
        <p>
          Embeddings do not name themes. Ingest does not auto-promote a
          proposal into the catalog. A split does not retire or rewrite the
          parent. Statements are never duplicated onto a theme. Gold and
          evals stay on CIR ids, not on theme names.
        </p>
      </section>

      <h2 className="text-[13px] font-medium">Open proposals</h2>
      {open.length === 0 ? (
        <p className="mt-2 border border-border bg-card p-4 text-[13px] leading-5 text-muted-foreground">
          None yet. Emerge waits on a residual cluster (ingest more
          off-catalog claims). Split waits on a named theme that is holding
          two distinct decisions.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {open.map((proposal) => (
            <li key={proposal.id} className="border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] uppercase">
                  {proposal.kind}
                </span>
                <h3 className="text-[13px] font-medium">{proposal.name}</h3>
              </div>
              <p className="mt-2 text-[13px] leading-5">{proposal.summary}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {proposal.rationale}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {proposal.insight_ids.length} insights · {proposal.sources}{" "}
                sources · cohesion {proposal.cohesion.toFixed(2)}
                {proposal.parent_theme_id
                  ? ` · parent ${byId.get(proposal.parent_theme_id)?.name ?? proposal.parent_theme_id}`
                  : ""}
              </p>
              {proposal.keywords.length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Keywords: {proposal.keywords.join(", ")}
                </p>
              ) : null}
              <CatalogDecision proposalId={proposal.id} />
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-[13px] font-medium">Named themes</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Append-only. New names appear under the parent they split from.
      </p>
      <ul className="mt-2 divide-y divide-border border border-border bg-card">
        {named.map((theme) => (
          <li key={theme.id} className="px-4 py-3 text-[13px]">
            <Link href={`/themes/${theme.id}`} className="font-medium no-underline hover:underline">
              {theme.name}
            </Link>
            {theme.parent_theme_id ? (
              <span className="ml-2 text-xs text-muted-foreground">
                split from{" "}
                {byId.get(theme.parent_theme_id)?.name ?? theme.parent_theme_id}
              </span>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">{theme.summary}</p>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-[13px] font-medium">Decided</h2>
      {decided.length === 0 ? (
        <p className="mt-2 border border-border bg-card p-4 text-[13px] leading-5 text-muted-foreground">
          No emerge or split has been accepted or rejected yet. Each decision
          is kept here so the knowledge base of theme decisions grows with
          the catalog.
        </p>
      ) : (
        <ul className="mt-2 space-y-2 border border-border bg-card p-4 text-[13px] text-muted-foreground">
          {decided.map((p) => (
            <li key={p.id}>
              {p.status} · {p.kind} · {p.name}
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
