import Link from "next/link";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { SDLC_DOCS } from "@/components/admin/sdlc-docs";
import { requireOwnerPage } from "@/modules/auth/owner";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  await requireOwnerPage();
  return (
    <AdminMain>
      <PageIntro kicker="Owner · reference" title="Docs">
        The raw spec documents, as markdown. SDLC renders the same set with diagrams.
      </PageIntro>
      <ul className="grid gap-1 text-[13px]">
        {SDLC_DOCS.map((slug) => (
          <li key={slug} className="flex flex-wrap items-baseline gap-3">
            <a href={`/admin/docs/sdlc/${slug}`} className="text-foreground underline-offset-2 hover:underline">
              {slug}
            </a>
            <Link
              href={`/admin/sdlc?spec=${slug}`}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              rendered
            </Link>
          </li>
        ))}
      </ul>
    </AdminMain>
  );
}
