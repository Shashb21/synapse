import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { TacticRecordContent } from "@/components/tactic-record-content";
import { tacticRecord } from "@/lib/iegp/tactic-record";
import { TACTIC_TYPE_LABELS } from "@/lib/iegp/enums";
import { requireCustomerContext } from "@/modules/auth/api-guard";
import { can } from "@/modules/auth/roles";

export const dynamic = "force-dynamic";

export default async function TacticDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await requireCustomerContext();
  const { id } = await params;
  const record = await tacticRecord(id);
  if (!record) notFound();
  const { tactic } = record;
  return <AppShell active="tactics">
    <PageIntro kicker={tactic.custom_type ? `${tactic.custom_type.label} · counts as ${TACTIC_TYPE_LABELS[tactic.type]}` : TACTIC_TYPE_LABELS[tactic.type]} title={tactic.name}>
      {tactic.description}
    </PageIntro>
    <TacticRecordContent record={{ ...record, permissions: { edit: can(context.role, "ideate"), coverage: can(context.role, "validate") } }} panel={false}
      identity={{ signed_in: context.session !== null, actor_name: context.actor.name, actor_function: context.actor.function }} />
  </AppShell>;
}
