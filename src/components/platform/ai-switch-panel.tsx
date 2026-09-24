import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import type { AiSwitch } from "@/modules/kernel/ai-switch";

/** The admin AI switch on the control panel. */
export function AiSwitchPanel({
  ai,
  mayToggle,
  identity,
}: {
  ai: AiSwitch;
  mayToggle: boolean;
  identity: ActionIdentity;
}) {
  const next = !ai.enabled;
  return (
    <section className="border border-border bg-card/40 p-4" data-testid="ai-switch-panel" aria-labelledby="ai-switch">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="ai-switch" className="text-[15px] font-medium text-foreground">
            AI is {ai.enabled ? "on" : "off"}
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">
            {ai.enabled
              ? "Stages may call the routed models: extraction, mapping, suggestions, critics and schedules."
              : "No model is called. Upload and parsing are hidden; gaps, tactics, mappings, priorities and dates are all entered by hand."}
          </p>
          {ai.updated_by ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Last set by {ai.updated_by} · {ai.updated_at}
              {ai.rationale ? ` · “${ai.rationale}”` : ""}
            </p>
          ) : null}
        </div>
        {mayToggle ? (
          <ActionDialog
            endpoint="/api/control"
            payload={{ action: "set_ai_enabled", enabled: next }}
            label={next ? "Turn AI on" : "Turn AI off"}
            title={next ? "Turn AI on" : "Turn AI off"}
            description={
              next
                ? "Every stage may call its routed model again. Nothing entered by hand is changed."
                : "Every AI suggestion and automatic AI step stops for everyone. Work already done stays."
            }
            confirmLabel={next ? "Turn AI on" : "Turn AI off"}
            identity={identity}
            variant={next ? "default" : "outline"}
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">Only an admin can change this.</p>
        )}
      </div>
    </section>
  );
}
