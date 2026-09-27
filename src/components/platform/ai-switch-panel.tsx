import type { ActionIdentity } from "@/components/platform/action-dialog";
import { AiToggle } from "@/components/platform/ai-toggle";
import type { AiSwitch } from "@/modules/kernel/ai-switch";

/**
 * The platform AI switch on the control panel: the master switch for every
 * workspace. Each workspace owner also has their own AI assistance setting
 * (the workspace menu); AI runs only where both are on.
 */
export function AiSwitchPanel({
  ai,
  mayToggle,
  identity,
}: {
  ai: AiSwitch;
  mayToggle: boolean;
  identity: ActionIdentity;
}) {
  return (
    <section className="border border-border bg-card/40 p-4" data-testid="ai-switch-panel" aria-labelledby="ai-switch">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="ai-switch" className="text-[15px] font-medium text-foreground">
            AI for all workspaces (master switch)
          </h2>
          <p className="mt-1 text-[13px] text-foreground" data-testid="ai-switch-state">
            AI is {ai.enabled ? "on" : "off"}
            {ai.enabled ? " — where each workspace also has AI assistance on" : " for every workspace"}
          </p>
          <p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">
            {ai.enabled
              ? "Stages may call the routed models: extraction, mapping, suggestions, critics and schedules."
              : "No model is called and there is no upload or parsing. Work starts at Add gaps and Add tactics; mappings, needs, priorities, ideas and dates are all entered by hand."}
          </p>
          <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground" data-testid="ai-switch-workspace-note">
            Each workspace owner can also turn AI assistance off for their own workspace from the workspace menu. This
            switch overrides them all: while it is off, no workspace can turn AI on.
          </p>
          {ai.updated_by ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Last set by {ai.updated_by} · {ai.updated_at}
            </p>
          ) : null}
        </div>
        {mayToggle ? (
          <AiToggle enabled={ai.enabled} actorName={identity.actor_name} />
        ) : (
          <p className="text-[11px] text-muted-foreground">Only an admin can change this.</p>
        )}
      </div>
    </section>
  );
}
