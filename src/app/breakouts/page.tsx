import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { loadState } from "@/lib/iegp/store";
import { isLiveGap } from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

export default async function BreakoutsPage() {
  const state = await loadState();
  const liveGapCount = state.gaps.filter(isLiveGap).length;

  return (
    <AppShell active="breakouts">
      <div className="mb-2 flex justify-end">
        <Link href="/room" className="text-[12px] text-muted-foreground no-underline hover:underline">
          Back to the Room presenter view →
        </Link>
      </div>
      <PageIntro kicker="Workshop day" title="Breakout groups">
        Group gaps by theme, then open each group&apos;s room in its own browser window — one per
        screen. A different consultant can open the same room on their own device and sign in there
        to facilitate it.
      </PageIntro>

      <div className="mb-8 border border-border bg-card p-4">
        <h2 className="mb-3 text-[13px] font-medium text-foreground">New breakout group</h2>
        <LockForm label="Create group" action="create_breakout_group" confirmLabel="Create group">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Name
            <input
              name="name"
              required
              placeholder="e.g. Comparative effectiveness"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
          </label>
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Note (optional)
            <input
              name="note"
              placeholder="What this breakout covers"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
          </label>
        </LockForm>
      </div>

      {state.breakout_groups.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No breakout groups yet. {liveGapCount} live gap{liveGapCount === 1 ? "" : "s"} available
          to assign once you create one.
        </p>
      ) : (
        <div className="grid gap-3">
          {state.breakout_groups.map((group) => {
            const gapCount = state.breakout_group_gaps.filter(
              (row) => row.group_id === group.id,
            ).length;
            return (
              <article key={group.id} className="border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">{group.name}</p>
                    {group.note ? (
                      <p className="mt-0.5 text-[12px] text-muted-foreground">{group.note}</p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {gapCount} gap{gapCount === 1 ? "" : "s"} assigned
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/breakouts/${group.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 text-[13px] text-foreground no-underline"
                    >
                      Open room ↗
                    </Link>
                    <LockForm
                      label="Delete"
                      action="delete_breakout_group"
                      extra={{ group_id: group.id }}
                      confirmLabel="Delete group"
                      description={`This ungroups ${gapCount} gap${gapCount === 1 ? "" : "s"} from "${group.name}". Gaps themselves are unaffected.`}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
