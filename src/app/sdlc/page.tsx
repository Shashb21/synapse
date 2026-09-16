import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppShell, PageIntro } from "@/components/insight-card";
import { SpecBody } from "@/app/sdlc/spec-body";
import Link from "next/link";

export const dynamic = "force-dynamic";

const SPECS = [
  {
    slug: "problem-and-solution.md",
    rel: "docs/problem-and-solution.md",
    id: "PS",
    title: "Problem & solution",
  },
  {
    slug: "01-requirements.md",
    rel: "docs/sdlc/01-requirements.md",
    id: "REQ",
    title: "Requirements",
  },
  {
    slug: "02-architecture.md",
    rel: "docs/sdlc/02-architecture.md",
    id: "ARCH",
    title: "Architecture",
  },
  {
    slug: "03-design.md",
    rel: "docs/sdlc/03-design.md",
    id: "DES",
    title: "Design",
  },
  {
    slug: "04-tdd.md",
    rel: "docs/sdlc/04-tdd.md",
    id: "TDD",
    title: "TDD",
  },
  {
    slug: "05-process.md",
    rel: "docs/sdlc/05-process.md",
    id: "PRC",
    title: "Process",
  },
  {
    slug: "06-eval-protocol.md",
    rel: "docs/sdlc/06-eval-protocol.md",
    id: "EVA",
    title: "Eval protocol",
  },
  {
    slug: "07-catalog-evolution.md",
    rel: "docs/sdlc/07-catalog-evolution.md",
    id: "CAT",
    title: "Catalog evolution",
  },
  {
    slug: "08-knowledge-graph.md",
    rel: "docs/sdlc/08-knowledge-graph.md",
    id: "GRF",
    title: "Knowledge graph",
  },
  {
    slug: "09-flow-high-level.md",
    rel: "docs/sdlc/09-flow-high-level.md",
    id: "FLOW",
    title: "Flow (process)",
  },
  {
    slug: "10-flow-technical.md",
    rel: "docs/sdlc/10-flow-technical.md",
    id: "TECH",
    title: "Flow (technical)",
  },
  {
    slug: "11-regression.md",
    rel: "docs/sdlc/11-regression.md",
    id: "REG",
    title: "Regression",
  },
  {
    slug: "12-gold-set.md",
    rel: "docs/sdlc/12-gold-set.md",
    id: "GOLD",
    title: "Gold set",
  },
] as const;

export default async function SdlcPage({
  searchParams,
}: {
  searchParams: Promise<{ spec?: string }>;
}) {
  const { spec } = await searchParams;
  const active = SPECS.find((s) => s.slug === spec) ?? SPECS[0]!;
  const body = await readFile(path.join(process.cwd(), active.rel), "utf8");

  return (
    <AppShell active="sdlc">
      <PageIntro kicker="View-only" title="Spec tape">
        Problem and solution paper, requirements, architecture, TDD, eval
        protocol, gold inventory, and application flow diagrams as written.
        Hill-climb and tests run off-screen.
      </PageIntro>
      <div className="mb-4 flex flex-wrap gap-1">
        {SPECS.map((s) => (
          <Link
            key={s.slug}
            href={`/sdlc?spec=${s.slug}`}
            className={`rounded-md px-2 py-1 text-[12px] no-underline ${
              s.slug === active.slug
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            }`}
          >
            {s.title}
          </Link>
        ))}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        {active.id} · {active.rel}
      </p>
      <SpecBody markdown={body} />
    </AppShell>
  );
}
