import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppShell } from "@/components/insight-card";
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
  const active =
    SPECS.find((s) => s.slug === spec) ?? SPECS[0]!;
  const body = await readFile(
    path.join(process.cwd(), "docs", "sdlc", active.slug),
    "utf8",
  );

  return (
    <AppShell active="sdlc">
      <div className="mb-3 border-b border-border pb-2">
        <h1 className="text-sm tracking-[0.25em] text-primary">SPEC TAPE</h1>
        <p className="mt-1 text-[11px] text-muted-foreground">
          View-only. Requirements, architecture, TDD, and eval protocol as
          written. Hill-climb and tests run off-screen.
        </p>
      </div>
      <div className="mb-3 flex flex-wrap border border-border">
        {SPECS.map((s) => (
          <Link
            key={s.slug}
            href={`/sdlc?spec=${s.slug}`}
            className={`border-r border-border px-3 py-1.5 text-[10px] tracking-widest no-underline last:border-r-0 ${
              s.slug === active.slug
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {s.id}
          </Link>
        ))}
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {active.id} · {active.title} · docs/sdlc/{active.slug}
      </p>
      <pre className="overflow-auto border border-border bg-[#07090d] p-3 text-[11px] leading-5 whitespace-pre-wrap text-foreground/90">
        {body}
      </pre>
    </AppShell>
  );
}
