import { BREAKOUTS_ENABLED } from "@/lib/breakouts-enabled";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { SessionPanel } from "@/components/platform/session-panel";
import {
  AddGapsDialog,
  BreakoutBoard,
  EditGroupDialog,
  RoomAutoRefresh,
  type PickableGap,
} from "@/components/breakouts/breakout-room";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { capabilitiesOf } from "@/modules/auth/roles";
import { loginOptions, sessionContext } from "@/modules/auth/session";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

export const dynamic = "force-dynamic";

const PRIORITY_LABELS: Record<string, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  defer: "Deferred",
};

export default async function BreakoutRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!BREAKOUTS_ENABLED) redirect("/");
  const { id } = await params;
  const [state, session, placements] = await Promise.all([loadState(), sessionContext(), listPlacements().catch(() => [])]);
  const group = state.breakout_groups.find((g) => g.id === id);
  if (!group) notFound();

  const bands = new Map(placements.filter((row) => row.validated && row.band).map((row) => [row.gap_id, row.band!]));
  const groupName = new Map(state.breakout_groups.map((row) => [row.id, row.name]));
  const workspace = buildPlanWorkspace(state);
  const assignedIds = new Set(
    state.breakout_group_gaps.filter((row) => row.group_id === id).map((row) => row.gap_id),
  );
  const assigned = workspace.review.filter((card) => assignedIds.has(card.gap_id));
  const available: PickableGap[] = workspace.review
    .filter((card) => !assignedIds.has(card.gap_id))
    .map((card) => ({
      gap_id: card.gap_id,
      gap_name: card.gap_name,
      domain_label: DOMAIN_LABELS[card.domain],
      settings: card.settings,
      priority: PRIORITY_LABELS[bands.get(card.gap_id) ?? ""] ?? "Not prioritized",
      other_groups: state.breakout_group_gaps
        .filter((row) => row.gap_id === card.gap_id && row.group_id !== id)
        .map((row) => groupName.get(row.group_id) ?? row.group_id),
    }));
  const otherGroups = state.breakout_groups.filter((row) => row.id !== id).map((row) => ({ id: row.id, name: row.name }));

  return (
    <AppShell active="breakouts">
      <RoomAutoRefresh />
      <Link href="/breakouts" className="text-[12px] text-muted-foreground no-underline hover:underline">
        ← All breakout groups
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <PageIntro kicker="Breakout group" title={group.name}>
          {group.note ?? undefined}
        </PageIntro>
        <div className="flex flex-wrap items-center gap-2">
          <EditGroupDialog groupId={group.id} name={group.name} note={group.note} />
          <AddGapsDialog groupId={group.id} availableGaps={available} />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Gaps in this group ({assigned.length})
        </h2>
        <p className="text-[11px] text-muted-foreground">← → moves between cards, Esc clears it.</p>
      </div>
      <BreakoutBoard groupId={group.id} cards={assigned} otherGroups={otherGroups} />

      <div className="mt-8">
        <SessionPanel
          actorName={session.actor.name}
          role={session.role}
          signedIn={session.signed_in}
          demo={session.demo}
          providers={loginOptions().providers}
          capabilities={capabilitiesOf(session.role)}
        />
      </div>
    </AppShell>
  );
}
