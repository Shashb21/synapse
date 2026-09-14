import { AppShell, PageIntro } from "@/components/insight-card";
import { ThemeChip } from "@/components/theme-chip";
import { RESIDUAL_THEME_ID } from "@/lib/cluster/cluster";
import {
  graphFromState,
  revelationInsights,
  type Revelation,
} from "@/lib/graph/connections";
import { getState } from "@/lib/store";
import { themeStyle } from "@/lib/theme-style";
import Link from "next/link";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<Revelation["kind"], string> = {
  blend: "Blend",
  bridge: "Bridge",
  gap_closure: "New implication",
};

export default async function GraphPage() {
  const state = await getState();
  const graph = graphFromState(state);
  const named = state.themes.filter(
    (t) => t.id !== RESIDUAL_THEME_ID && t.insight_ids.length > 0,
  );
  const width = 520;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 150;
  const positions = new Map(
    named.map((theme, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(named.length, 1) - Math.PI / 2;
      return [
        theme.id,
        { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius },
      ] as const;
    }),
  );

  return (
    <AppShell active="graph">
      <PageIntro kicker="Associative memory" title="Knowledge graph">
        <p>
          CIR rows are atomic notes. Themes are maps of content, not folders.
          The graph is what grows: membership, corroboration, and links that
          only exist because two claims share an entity across decks.
        </p>
        <p className="mt-2 text-sm">
          {graph.multi_theme_insights} blended CIR · {graph.theme_bridges.length}{" "}
          theme bridges · {graph.corroboration_pairs} corroborations ·{" "}
          {graph.revelations.length} revelations
        </p>
      </PageIntro>

      <section className="mb-8 space-y-3 border border-border bg-card p-4 text-[13px] leading-5 text-muted-foreground">
        <h2 className="text-[13px] font-medium text-foreground">
          How this knowledge base is supposed to work
        </h2>
        <p>
          Not a file cabinet. Closer to a Zettelkasten / Obsidian vault: each
          insight is stored once, then the system forms typed links as more
          decks arrive. Themes emerge or split when the catalog of decision
          objects must grow (
          <Link href="/catalog" className="underline">
            Catalog
          </Link>
          ). The graph below is the other half — spreading activation over those
          links, so a gap in Medical and a fact in Access can imply something
          neither function wrote.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Blend</strong> — one CIR on two
            themes (polyhierarchy). Aetna delaying formulary pending RWE is
            Access and Evidence; copying the sentence would hide the join.
          </li>
          <li>
            <strong className="text-foreground">Bridge</strong> — two CIR share
            an entity but not a theme. Walking neighbors (structural hole)
            is the new fact.
          </li>
          <li>
            <strong className="text-foreground">New implication</strong> — an
            unknown next to a known/opportunity on the same entity. Conceptual
            blending: the combined move did not exist in any source.
          </li>
        </ul>
      </section>

      <h2 className="text-[13px] font-medium">Theme network</h2>
      <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
        Edge weight is shared CIR. Isolated themes still sit on the ring —
        they have not formed a join yet.
      </p>
      <div className="mb-8 overflow-x-auto border border-border bg-card">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mx-auto h-auto w-full max-w-[520px]"
          role="img"
          aria-label="Theme network showing shared insight links"
        >
          {graph.theme_bridges.map((edge) => {
            const a = positions.get(edge.from);
            const b = positions.get(edge.to);
            if (!a || !b) return null;
            return (
              <line
                key={`${edge.from}-${edge.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="currentColor"
                className="text-zinc-500"
                strokeWidth={Math.min(5, 1 + edge.shared)}
                strokeOpacity={0.55}
              />
            );
          })}
          {named.map((theme) => {
            const pos = positions.get(theme.id);
            if (!pos) return null;
            const color = themeStyle(theme.id);
            return (
              <g key={theme.id}>
                <a href={`/themes/${theme.id}`}>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={18}
                    fill={color.hue}
                    fillOpacity={0.25}
                    stroke={color.hue}
                    strokeWidth={2}
                  />
                  <text
                    x={pos.x}
                    y={pos.y + 32}
                    textAnchor="middle"
                    className="fill-zinc-300"
                    fontSize={10}
                  >
                    {theme.name.length > 22
                      ? `${theme.name.slice(0, 20)}…`
                      : theme.name}
                  </text>
                </a>
              </g>
            );
          })}
        </svg>
      </div>

      <h2 className="text-[13px] font-medium">Revealed connections</h2>
      <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
        These are the notes that only exist because the graph exists. Ingest
        more decks and this list should grow — not replace what you already
        know.
      </p>
      {graph.revelations.length === 0 ? (
        <p className="border border-border bg-card p-4 text-[13px] leading-5 text-muted-foreground">
          No blends or bridges yet. Ingest another function&apos;s readout so
          entities can collide across themes.
        </p>
      ) : (
        <ul className="space-y-3">
          {graph.revelations.map((revelation) => {
            const members = revelationInsights(revelation, state.insights);
            return (
              <li
                key={revelation.id}
                className="border border-border bg-card p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] uppercase">
                    {KIND_LABEL[revelation.kind]}
                  </span>
                  <h3 className="text-[13px] font-medium">{revelation.title}</h3>
                </div>
                <p className="mt-2 text-[13px] leading-5">{revelation.why}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {revelation.theme_ids.map((id) => {
                    const theme = state.themes.find((t) => t.id === id);
                    return theme ? (
                      <ThemeChip
                        key={id}
                        id={theme.id}
                        name={theme.name}
                        href={`/themes/${theme.id}`}
                      />
                    ) : null;
                  })}
                </div>
                <ul className="mt-3 space-y-2">
                  {members.map((insight) => (
                    <li
                      key={insight.id}
                      className="text-[13px] leading-5 text-foreground/90"
                    >
                      <span className="text-[11px] uppercase text-muted-foreground">
                        {insight.classification}
                      </span>{" "}
                      {insight.statement}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
