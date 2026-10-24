import Link from "next/link";
import {
  ledgerHref,
  type LedgerFilterFacets,
  type LedgerFilterQuery,
} from "@/accuracy/domain/ledger-filters";

function chipClass(active: boolean): string {
  return `inline-flex rounded-md border px-2 py-1 text-callout no-underline ${
    active
      ? "border-foreground bg-card text-foreground"
      : "border-border text-muted-foreground hover:text-foreground"
  }`;
}

function FilterRow({
  legend,
  workspaceId,
  selected,
  keyName,
  facets,
}: {
  legend: string;
  workspaceId: string;
  selected: LedgerFilterQuery;
  keyName: "chapter" | "si";
  facets: LedgerFilterFacets["chapters"];
}) {
  const current = selected[keyName] ?? null;
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-caption font-medium text-muted-foreground">
        {legend}
      </legend>
      <ul className="flex flex-wrap gap-2">
        <li>
          <Link
            href={ledgerHref(workspaceId, { ...selected, [keyName]: null })}
            className={chipClass(!current)}
            aria-current={!current ? "page" : undefined}
          >
            All
          </Link>
        </li>
        {facets.map((facet) => {
          const active = current === facet.slug;
          return (
            <li key={facet.slug}>
              <Link
                href={ledgerHref(workspaceId, {
                  ...selected,
                  [keyName]: active ? null : facet.slug,
                })}
                className={chipClass(active)}
                aria-current={active ? "page" : undefined}
              >
                {facet.label}
                <span className="ml-1 text-caption text-muted-foreground">{facet.count}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

export function LedgerFilterBar({
  workspaceId,
  facets,
  selected,
}: {
  workspaceId: string;
  facets: LedgerFilterFacets;
  selected: LedgerFilterQuery;
}) {
  if (facets.chapters.length === 0 && facets.siThemes.length === 0) return null;

  return (
    <section className="mb-6 grid gap-3" aria-labelledby="ledger-filters">
      <h2 id="ledger-filters" className="text-body font-semibold text-foreground">
        Filters
      </h2>
      <p className="text-callout text-muted-foreground">
        Chapter follows Tislelizumab indication boards; SI follows BGB NSCLC theme codes. Cards stay
        the ledger — not a spreadsheet.
      </p>
      {facets.chapters.length > 0 ? (
        <FilterRow
          legend="Chapter"
          workspaceId={workspaceId}
          selected={selected}
          keyName="chapter"
          facets={facets.chapters}
        />
      ) : null}
      {facets.siThemes.length > 0 ? (
        <FilterRow
          legend="Strategic imperative"
          workspaceId={workspaceId}
          selected={selected}
          keyName="si"
          facets={facets.siThemes}
        />
      ) : null}
    </section>
  );
}
