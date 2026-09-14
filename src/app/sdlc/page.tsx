import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppShell, PageIntro } from "@/components/insight-card";
import Link from "next/link";

export const dynamic = "force-dynamic";

const SPECS = [
  {
    slug: "01-requirements.md",
    id: "REQ",
    title: "Requirements",
  },
  {
    slug: "02-architecture.md",
    id: "ARCH",
    title: "Architecture",
  },
  {
    slug: "03-design.md",
    id: "DES",
    title: "Design",
  },
  {
    slug: "04-tdd.md",
    id: "TDD",
    title: "TDD",
  },
  {
    slug: "05-process.md",
    id: "PRC",
    title: "Process",
  },
  {
    slug: "06-eval-protocol.md",
    id: "EVA",
    title: "Eval protocol",
  },
  {
    slug: "07-catalog-evolution.md",
    id: "CAT",
    title: "Catalog evolution",
  },
  {
    slug: "08-knowledge-graph.md",
    id: "GRF",
    title: "Knowledge graph",
  },
] as const;

export default async function SdlcPage({
  searchParams,
}: {
  searchParams: Promise<{ spec?: string }>;
}) {
  const { spec } = await searchParams;
  const active = SPECS.find((s) => s.slug === spec) ?? SPECS[0]!;
  const body = await readFile(
    path.join(process.cwd(), "docs", "sdlc", active.slug),
    "utf8",
  );

  return (
    <AppShell active="sdlc">
      <PageIntro kicker="View-only" title="Spec tape">
        Requirements, architecture, TDD, and eval protocol as written.
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
        {active.id} · docs/sdlc/{active.slug}
      </p>
      <pre className="overflow-auto border border-border bg-card p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap text-foreground/90">
        {body}
      </pre>
    </AppShell>
  );
}
