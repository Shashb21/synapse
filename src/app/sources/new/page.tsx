import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { ManualSourceForm } from "@/components/platform/manual-source-form";
import { ACTOR_FUNCTIONS, FUNCTION_LABELS, SOURCE_TYPES, SOURCE_TYPE_LABELS } from "@/lib/iegp/enums";
import { sessionContext } from "@/modules/auth/session";
import { aiSectionEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function NewTypedSourcePage() {
  const context = await sessionContext();
  // With AI off there are no sources at all: gaps and tactics are added by hand.
  if (!(await aiSectionEnabled("ingestion").catch(() => false))) {
    return (
      <AppShell active="sources">
        <PageIntro kicker="Sources" title="Sources are not used">
          Sources are not used in this plan. Add gaps and tactics by hand from{" "}
          <Link href="/" className="underline-offset-2 hover:underline">
            Start
          </Link>
          .
        </PageIntro>
      </AppShell>
    );
  }
  return (
    <AppShell active="sources">
      <PageIntro kicker="Manual entry" title="Type a source">
        Paste or type a source&apos;s text, split it into one block per paragraph, adjust the blocks and
        save. Every block is stored as human-entered and is never replaced by a re-parse.{" "}
        <Link href="/sources" className="underline-offset-2 hover:underline">
          All sources
        </Link>
      </PageIntro>
      <ManualSourceForm
        endpoint="/api/sources/blocks"
        payload={{}}
        fields={[
          { name: "title", label: "Title", required: true, placeholder: "e.g. KOL call notes" },
          {
            name: "source_type",
            label: "Source type",
            type: "select",
            placeholder: "Choose a source type",
            required: true,
            options: SOURCE_TYPES.map((v) => ({ value: v, label: SOURCE_TYPE_LABELS[v] })),
          },
          {
            name: "stakeholder_function",
            label: "Stakeholder function",
            type: "select",
            placeholder: "Choose a function",
            required: true,
            options: ACTOR_FUNCTIONS.map((v) => ({ value: v, label: FUNCTION_LABELS[v] })),
          },
        ]}
        identity={{
          signed_in: context.signed_in,
          actor_name: context.actor.name,
          actor_function: context.actor.function,
        }}
        onSavedHref="/sources/{id}"
      />
    </AppShell>
  );
}
