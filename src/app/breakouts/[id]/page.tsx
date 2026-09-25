import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { SessionPanel } from "@/components/platform/session-panel";
import { AddGapsDialog, BreakoutBoard, RoomAutoRefresh } from "@/components/breakouts/breakout-room";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { capabilitiesOf } from "@/modules/auth/roles";
import { loginOptions, sessionContext } from "@/modules/auth/session";

export const dynamic = "force-dynamic";

export default async function BreakoutRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [state, session] = await Promise.all([loadState(), sessionContext()]);
  const group = state.breakout_groups.find((g) => g.id === id);
  if (!group) notFound();

  const workspace = buildPlanWorkspace(state);
  const assignedIds = new Set(
    state.breakout_group_gaps.filter((row) => row.group_id === id).map((row) => row.gap_id),
  );
  const assigned = workspace.review.filter((card) => assignedIds.has(card.gap_id));
  const available = workspace.review
    .filter((card) => !assignedIds.has(card.gap_id))
    .map((card) => ({
      gap_id: card.gap_id,
      gap_name: card.gap_name,
      domain_label: DOMAIN_LABELS[card.domain],
    }));

  return (
    <AppShell active="breakouts">
      <RoomAutoRefresh />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <PageIntro kicker="Breakout room" title={group.name} />
        <Link href="/room" className="text-[12px] text-muted-foreground no-underline hover:underline">
          Switch to presentation →
        </Link>
      </div>
      {group.note ? <p className="-mt-4 mb-6 text-[13px] text-muted-foreground">{group.note}</p> : null}

      <div className="mb-8">
        <SessionPanel
          actorName={session.actor.name}
          role={session.role}
          signedIn={session.signed_in}
          demo={session.demo}
          providers={loginOptions().providers}
          capabilities={capabilitiesOf(session.role)}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium text-foreground">
          Assigned gaps <span className="font-normal text-muted-foreground">({assigned.length})</span>
        </h2>
        <AddGapsDialog
          groupId={group.id}
          availableGaps={available}
          defaultActorName={session.signed_in ? session.actor.name : undefined}
          defaultActorFunction={session.signed_in ? session.actor.function : undefined}
        />
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        ← → moves focus between cards, Esc clears it.
      </p>

      <BreakoutBoard
        groupId={group.id}
        cards={assigned}
        defaultActorName={session.signed_in ? session.actor.name : undefined}
        defaultActorFunction={session.signed_in ? session.actor.function : undefined}
      />
    </AppShell>
  );
}
