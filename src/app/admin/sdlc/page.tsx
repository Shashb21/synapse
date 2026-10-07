import { requireOwnerPage } from "@/modules/auth/owner";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { SpecBody } from "@/app/admin/sdlc/spec-body";
import Link from "next/link";
import { SPEC_DOCS, specDoc } from "@/components/admin/sdlc-docs";
import { RetiredMarker } from "./retired-marker";

export const dynamic = "force-dynamic";

export default async function SdlcPage({
  searchParams,
}: {
  searchParams: Promise<{ spec?: string }>;
}) {
  await requireOwnerPage();
  const { spec } = await searchParams;
  const active = specDoc(spec) ?? SPEC_DOCS[0];
  const body = await readFile(path.join(process.cwd(), active.rel), "utf8");

  return (
    <AdminMain>
      <PageIntro kicker="View-only" title="Spec tape">
        Problem and solution paper, requirements, architecture, TDD, eval
        protocol, gold inventory, and application flow diagrams as written.
        Hill-climb and tests run off-screen.
      </PageIntro>
      <div className="mb-4 flex flex-wrap gap-1">
        {SPEC_DOCS.map((s) => (
          <Link
            key={s.slug}
            href={`/admin/sdlc?spec=${s.slug}`}
            aria-current={s.slug === active.slug ? "page" : undefined}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] no-underline ${
              s.slug === active.slug
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            }`}
          >
            {s.title}
            {s.retired ? <RetiredMarker /> : null}
          </Link>
        ))}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        {active.id} · {active.rel}
        {active.retired ? " · Retired v1 spec, kept for lineage only: it does not describe the current product." : ""}
      </p>
      <SpecBody markdown={body} />
    </AdminMain>
  );
}
