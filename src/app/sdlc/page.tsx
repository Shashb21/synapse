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
      <div className="mb-6 flex flex-wrap gap-2">
        {SPECS.map((s) => (
          <Link
            key={s.slug}
            href={`/sdlc?spec=${s.slug}`}
            className={`rounded-full px-3.5 py-1.5 text-sm no-underline transition ${
              s.slug === active.slug
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            {s.title}
          </Link>
        ))}
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        {active.id} · docs/sdlc/{active.slug}
      </p>
      <pre className="overflow-auto rounded-2xl border border-border bg-card p-6 font-mono text-sm leading-7 whitespace-pre-wrap text-foreground/90 sm:p-8">
        {body}
      </pre>
    </AppShell>
  );
}
