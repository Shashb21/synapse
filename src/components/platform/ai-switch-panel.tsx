import type { ActionIdentity } from "@/components/platform/action-dialog";
import { AiToggle } from "@/components/platform/ai-toggle";
import { AiSectionToggle } from "@/components/platform/ai-section-toggle";
import type { AiSwitch } from "@/modules/kernel/ai-switch";
import { AI_SECTIONS, type AiSections } from "@/modules/kernel/ai-sections";

/**
 * AI on the control panel (KAN-53): the master switch, then one switch per AI section.
 * Both apply to every customer; customers have no AI switch of their own and simply see
 * the manual flow wherever a section is off.
 */
export function AiSwitchPanel({
  ai,
  sections,
  mayToggle,
  identity,
}: {
  ai: AiSwitch | null;
  /** The stored per-section switches (the master switch still has to be on). */
  sections: AiSections | null;
  mayToggle: boolean;
  identity: ActionIdentity;
}) {
  return (
    <section className="border border-border bg-card p-4 rounded-lg" data-testid="ai-switch-panel" aria-labelledby="ai-switch">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="ai-switch" className="text-base font-semibold text-foreground">
            AI for all customers (master switch)
          </h2>
          <p className="mt-1 text-[13px] text-foreground" data-testid="ai-switch-state">
            {ai ? <>AI is {ai.enabled ? "on" : "off"}
            {ai.enabled ? " — each section below decides where it runs" : " for every customer"}</> : "Master AI switch unavailable. Retry configuration to read its saved state."}
          </p>
          <p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">
            {ai?.enabled
              ? "Stages may call the routed models: extraction, mapping, suggestions, critics and schedules."
              : ai ? "No model is called and there is no upload or parsing. Work starts at Add gaps and Add tactics; mappings, needs, priorities, ideas and dates are all entered by hand." : "The saved master state could not be confirmed. Master and section changes are disabled until it is available."}
          </p>
          <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground" data-testid="ai-switch-workspace-note">
            Customers have no AI switch. Where a section is off they see the manual flow only, with no AI buttons or
            suggestions. While this master switch is off, every section is off.
          </p>
          {ai?.updated_by ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Last set by {ai.updated_by} · {ai.updated_at}
            </p>
          ) : null}
        </div>
        {mayToggle && ai ? (
          <AiToggle enabled={ai.enabled} actorName={identity.actor_name} />
        ) : (
          <p className="text-[11px] text-muted-foreground">{ai ? "Only an admin can change this." : "Master changes unavailable."}</p>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3" data-testid="ai-sections">
        <h3 className="text-sm font-semibold text-foreground">AI by section</h3>
        {!sections ? <p className="mt-1 text-sm text-[var(--unknown-foreground)]">Section switches unavailable. Retry configuration to read their saved states.</p> : null}
        <ul className="mt-2 grid gap-1.5">
          {AI_SECTIONS.map((section) => (
            <li
              key={section.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-foreground">
                  {section.label}{" "}
                  <span className="font-mono text-[10px] font-normal text-muted-foreground">{section.stages.join(" · ")}</span>
                </p>
                <p className="text-[11px] leading-4 text-muted-foreground">{section.detail}</p>
              </div>
              {!section.built ? (
                <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                  No AI module developed yet
                </span>
              ) : mayToggle && sections ? (
                <AiSectionToggle
                  section={section.id}
                  label={section.label}
                  enabled={sections[section.id]}
                  disabled={!ai || !ai.enabled}
                />
              ) : (
                <span className="text-[11px] text-muted-foreground">{sections ? sections[section.id] ? "On" : "Off" : "Unavailable"}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
