"use client";

import type { ReactNode } from "react";
import {
  LIFECYCLE_STAGES,
  PLAN_FUNCTIONS,
  PRESSURE_LEVELS,
  SUGGESTED_SETTINGS,
  lifecycleLabel,
  type PlanningContext,
  type PressureLevel,
  type SetupCompetitor,
  type SetupIndication,
  type SetupMilestone,
  type SetupObjective,
  type SetupSection,
  type SetupStakeholder,
} from "@/lib/iegp/planning-context";
import { ChoiceField, ListField, TagField, TextField } from "./setup-fields";
import { cn } from "@/lib/utils";

export type StepProps = {
  form: PlanningContext;
  set: <K extends keyof PlanningContext>(key: K, value: PlanningContext[K]) => void;
  /** Validation messages by field key (e.g. `asset_name`, `objectives.0.name`). */
  errors: Record<string, string>;
};

const MODALITIES = [
  "Small molecule",
  "Monoclonal antibody",
  "Antibody-drug conjugate",
  "Bispecific",
  "Cell therapy",
  "Gene therapy",
  "RNA therapy",
  "Vaccine",
  "Peptide",
  "Device / combination",
];
const MARKETS = ["US", "EU5", "UK", "Germany", "France", "Italy", "Spain", "Japan", "China", "Canada", "Australia", "Global"];
const PAYERS = ["CMS", "US commercial payers", "NICE", "G-BA / IQWiG", "HAS", "AIFA", "AEMPS", "CDA-AMC (CADTH)", "PBAC", "ICER", "EU JCA"];
const PRESSURE_OPTIONS = PRESSURE_LEVELS.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
const IMPORTANCE = [1, 2, 3, 4, 5].map((id) => ({ id, label: String(id) }));

function Section({ title, intro, children, id }: { title: string; intro: string; children: ReactNode; id: SetupSection }) {
  return (
    <section
      data-testid={`setup-step-${id}`}
      aria-labelledby={`setup-${id}-title`}
      className="grid gap-5 rounded-lg border border-border bg-gradient-to-br from-card/80 via-card/40 to-transparent p-5"
    >
      <header className="grid gap-1">
        <h2 id={`setup-${id}-title`} className="text-[15px] font-medium text-foreground">
          {title}
        </h2>
        <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">{intro}</p>
      </header>
      {children}
    </section>
  );
}

export function AssetStep({ form, set, errors }: StepProps) {
  return (
    <Section
      id="asset"
      title="The asset"
      intro="What this IEGP is for. Name and indication appear on every stage; lifecycle stage and markets shape how gaps are prioritized."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Asset / brand name" required value={form.asset_name} onChange={(v) => set("asset_name", v)} error={errors.asset_name} placeholder="e.g. Velmara" />
        <TextField label="INN / generic name" value={form.inn} onChange={(v) => set("inn", v)} placeholder="e.g. velmaratinib" />
        <TextField label="Mechanism of action" value={form.mechanism} onChange={(v) => set("mechanism", v)} placeholder="e.g. third-generation EGFR TKI" />
        <TextField label="Modality" value={form.modality} onChange={(v) => set("modality", v)} list="setup-modalities" placeholder="e.g. Small molecule" />
        <datalist id="setup-modalities">
          {MODALITIES.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <TextField
          label="Therapeutic area"
          required
          value={form.therapeutic_area}
          onChange={(v) => set("therapeutic_area", v)}
          error={errors.therapeutic_area}
          placeholder="e.g. Thoracic oncology"
        />
      </div>
      <ListField<SetupIndication>
        label="Indications"
        required
        hint="Current indications and the ones planned in this plan's horizon."
        items={form.indications}
        onChange={(items) => set("indications", items)}
        blank={() => ({ name: "", status: form.indications.some((i) => i.status === "current") ? "planned" : "current" })}
        addLabel="Add indication"
        error={errors.indications}
        renderItem={(item, update, index) => (
          <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
            <TextField label={`Indication ${index + 1}`} value={item.name} onChange={(v) => update({ name: v })} placeholder="e.g. 2L EGFR-mutant NSCLC" />
            <ChoiceField
              label="Status"
              value={item.status}
              options={[
                { id: "current", label: "Current" },
                { id: "planned", label: "Planned" },
              ]}
              onChange={(v) => update({ status: v })}
            />
          </div>
        )}
      />
      <ChoiceField
        label="Lifecycle stage"
        required
        value={form.lifecycle_stage}
        options={[
          ...LIFECYCLE_STAGES,
          ...(form.lifecycle_stage && !LIFECYCLE_STAGES.some((s) => s.id === form.lifecycle_stage)
            ? [{ id: form.lifecycle_stage, label: form.lifecycle_stage }]
            : []),
        ]}
        onChange={(v) => set("lifecycle_stage", v)}
        error={errors.lifecycle_stage}
      />
      <TagField
        label="Markets in scope"
        required
        values={form.markets}
        onChange={(v) => set("markets", v)}
        suggestions={MARKETS}
        error={errors.markets}
        placeholder="Type a market and press Enter"
      />
    </Section>
  );
}

export function CompanyStep({ form, set, errors }: StepProps) {
  return (
    <Section
      id="company"
      title="Company & plan"
      intro="Who owns this plan and over what cycle. The company situation is given to the prioritization and timeline suggestions as background."
    >
      <TextField
        label="Company situation"
        multiline
        value={form.company_situation}
        onChange={(v) => set("company_situation", v)}
        placeholder="Portfolio position, what leadership already knows about evidence risk, budget constraints…"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Plan owner" required value={form.plan_owner} onChange={(v) => set("plan_owner", v)} error={errors.plan_owner} placeholder="e.g. T. Okonkwo, Global Medical Lead" />
        <TextField
          label="Sponsoring function"
          required
          value={form.sponsoring_function}
          onChange={(v) => set("sponsoring_function", v)}
          list="setup-functions"
          error={errors.sponsoring_function}
          placeholder="e.g. Medical Affairs"
        />
        <TextField
          label="Plan horizon (years)"
          type="number"
          value={String(form.plan_horizon_years)}
          onChange={(v) => set("plan_horizon_years", Math.max(1, Math.min(15, Math.round(Number(v) || 1))))}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Planning cycle start" type="date" value={form.cycle_start} onChange={(v) => set("cycle_start", v)} error={errors.cycle_start} />
          <TextField label="Planning cycle end" type="date" value={form.cycle_end} onChange={(v) => set("cycle_end", v)} error={errors.cycle_end} />
        </div>
      </div>
      <datalist id="setup-functions">
        {PLAN_FUNCTIONS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </Section>
  );
}

export function ObjectivesStep({ form, set, errors }: StepProps) {
  return (
    <Section
      id="objectives"
      title="Strategic objectives & key decisions"
      intro="Each objective's key decision and date become the decision dates the timeline plans against. The first objective is the plan's primary one."
    >
      <ListField<SetupObjective>
        label="Objectives"
        required
        items={form.objectives}
        onChange={(items) => set("objectives", items)}
        blank={() => ({ id: "", name: "", description: "", strategic_importance: 3, owner: "", key_decision: "", decision_date: "" })}
        addLabel="Add objective"
        error={errors.objectives ?? errors.key_decision}
        renderItem={(item, update, index) => (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label={`Objective ${index + 1}`}
              required
              value={item.name}
              onChange={(v) => update({ name: v })}
              error={errors[`objectives.${index}.name`]}
              placeholder="e.g. Support reimbursement and HTA"
            />
            <TextField label="Owner" value={item.owner} onChange={(v) => update({ owner: v })} placeholder="e.g. HEOR lead" />
            <TextField
              className="md:col-span-2"
              label="Description"
              value={item.description}
              onChange={(v) => update({ description: v })}
              placeholder="What evidence this objective needs and why"
            />
            <ChoiceField
              label="Strategic importance (1–5)"
              value={item.strategic_importance}
              options={IMPORTANCE}
              onChange={(v) => update({ strategic_importance: v })}
            />
            <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
              <TextField
                label="Key decision"
                value={item.key_decision}
                onChange={(v) => update({ key_decision: v })}
                error={errors[`objectives.${index}.key_decision`]}
                placeholder="e.g. EU5 HTA filings"
              />
              <TextField
                label="Decision date"
                type="date"
                value={item.decision_date}
                onChange={(v) => update({ decision_date: v })}
                error={errors[`objectives.${index}.decision_date`]}
              />
            </div>
          </div>
        )}
      />
    </Section>
  );
}

export function LandscapeStep({ form, set, errors }: StepProps) {
  return (
    <Section
      id="landscape"
      title="Evidence landscape"
      intro="Competition, standard of care, the payers and HTA bodies you must convince, and the regulatory and launch dates the evidence must land before."
    >
      <ChoiceField<PressureLevel>
        label="Overall competitive pressure"
        value={form.competitive_pressure}
        options={PRESSURE_OPTIONS}
        onChange={(v) => set("competitive_pressure", v)}
      />
      <ListField<SetupCompetitor>
        label="Competitors"
        items={form.competitors}
        onChange={(items) => set("competitors", items)}
        blank={() => ({ name: "", pressure: "medium", note: "" })}
        addLabel="Add competitor"
        renderItem={(item, update, index) => (
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <TextField label={`Competitor ${index + 1}`} value={item.name} onChange={(v) => update({ name: v })} placeholder="e.g. osimertinib" />
            <ChoiceField<PressureLevel> label="Pressure" value={item.pressure} options={PRESSURE_OPTIONS} onChange={(v) => update({ pressure: v })} />
            <TextField className="md:col-span-2" label="Note" value={item.note} onChange={(v) => update({ note: v })} placeholder="Where they compete, recent readouts…" />
          </div>
        )}
      />
      <TextField
        label="Positioning versus competitors"
        multiline
        value={form.competitor_positioning}
        onChange={(v) => set("competitor_positioning", v)}
        placeholder="e.g. Differentiate on CNS control and elderly tolerability"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Standard of care"
          multiline
          value={form.standard_of_care}
          onChange={(v) => set("standard_of_care", v)}
          placeholder="What patients get today in each setting"
        />
        <TagField label="Comparators" values={form.comparators} onChange={(v) => set("comparators", v)} placeholder="e.g. platinum doublet" />
      </div>
      <TagField label="Key payer / HTA bodies" values={form.payer_hta_bodies} onChange={(v) => set("payer_hta_bodies", v)} suggestions={PAYERS} />
      <ListField<SetupMilestone>
        label="Regulatory milestones"
        items={form.regulatory_milestones}
        onChange={(items) => set("regulatory_milestones", items)}
        blank={() => ({ name: "", date: "" })}
        addLabel="Add milestone"
        renderItem={(item, update, index) => (
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <TextField label={`Milestone ${index + 1}`} value={item.name} onChange={(v) => update({ name: v })} placeholder="e.g. EMA filing" />
            <TextField label="Date" type="date" value={item.date} onChange={(v) => update({ date: v })} error={errors[`regulatory_milestones.${index}.date`]} />
          </div>
        )}
      />
      <TextField label="Launch timeline" value={form.launch_timeline} onChange={(v) => set("launch_timeline", v)} placeholder="e.g. US launch 2027-H1; EU5 staggered through 2027" />
    </Section>
  );
}

export function StakeholdersStep({ form, set, errors }: StepProps) {
  const missing = PLAN_FUNCTIONS.filter((f) => !form.stakeholders.some((s) => s.function.toLowerCase() === f.toLowerCase()));
  return (
    <Section
      id="stakeholders"
      title="Stakeholders & functions"
      intro="The functions that bring needs into the plan and own its tactics, with the lead for each."
    >
      <ListField<SetupStakeholder>
        label="Functions involved"
        required
        items={form.stakeholders}
        onChange={(items) => set("stakeholders", items)}
        blank={() => ({ function: "", lead: "" })}
        addLabel="Add function"
        error={errors.stakeholders}
        renderItem={(item, update, index) => (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={`Function ${index + 1}`} value={item.function} onChange={(v) => update({ function: v })} list="setup-functions-stakeholders" placeholder="e.g. HEOR" />
            <TextField label="Lead" value={item.lead} onChange={(v) => update({ lead: v })} placeholder="Name, role" />
          </div>
        )}
      />
      <datalist id="setup-functions-stakeholders">
        {PLAN_FUNCTIONS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      {missing.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span>Quick add:</span>
          {missing.map((f) => (
            <button
              key={f}
              type="button"
              className="rounded-full border border-dashed border-border px-2 py-0.5 hover:border-[var(--chart-1)]/50 hover:text-foreground"
              onClick={() => set("stakeholders", [...form.stakeholders, { function: f, lead: "" }])}
            >
              + {f}
            </button>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

export function SettingsStep({ form, set }: StepProps) {
  return (
    <Section
      id="settings"
      title="Treatment settings"
      intro="The lines of therapy or settings this plan covers. They are offered as setting tags on every gap, and each tag becomes a scope on Prioritize so you rank gaps setting by setting."
    >
      <TagField
        label="Settings"
        values={form.treatment_settings}
        onChange={(v) => set("treatment_settings", v)}
        suggestions={SUGGESTED_SETTINGS}
        placeholder="e.g. 2L, perioperative"
        hint="Optional. You can also add settings on a gap later."
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Review summary

function Row({ label, value }: { label: string; value: ReactNode }) {
  const empty = value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-1 text-[12px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-foreground", empty && "text-muted-foreground/70")}>{empty ? "—" : value}</dd>
    </div>
  );
}

const list = (values: string[]) => values.join(", ");

/** Everything saved, section by section, each with a way back to edit it. */
export function SetupSummary({
  form,
  onEdit,
  issues,
}: {
  form: PlanningContext;
  onEdit: (section: SetupSection) => void;
  issues: Partial<Record<SetupSection, string[]>>;
}) {
  const block = (section: SetupSection, title: string, rows: ReactNode) => (
    <div key={section} className="grid content-start gap-1 rounded-md border border-border bg-card/40 p-4" data-testid={`setup-summary-${section}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        <button type="button" className="text-[11px] text-[var(--chart-1)] hover:underline" onClick={() => onEdit(section)}>
          Edit
        </button>
      </div>
      {issues[section]?.length ? (
        <ul className="grid gap-0.5 text-[11px] text-destructive">
          {issues[section]!.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      <dl>{rows}</dl>
    </div>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {block(
        "asset",
        "Asset",
        <>
          <Row label="Asset" value={[form.asset_name, form.inn && `(${form.inn})`].filter(Boolean).join(" ")} />
          <Row label="Mechanism / modality" value={[form.mechanism, form.modality].filter(Boolean).join(" · ")} />
          <Row label="Therapeutic area" value={form.therapeutic_area} />
          <Row label="Indications" value={form.indications.map((i) => `${i.name} (${i.status})`).join("; ")} />
          <Row label="Lifecycle stage" value={lifecycleLabel(form.lifecycle_stage)} />
          <Row label="Markets" value={list(form.markets)} />
        </>,
      )}
      {block(
        "company",
        "Company & plan",
        <>
          <Row label="Plan owner" value={form.plan_owner} />
          <Row label="Sponsoring function" value={form.sponsoring_function} />
          <Row label="Horizon" value={`${form.plan_horizon_years} years`} />
          <Row label="Planning cycle" value={form.cycle_start || form.cycle_end ? `${form.cycle_start || "?"} to ${form.cycle_end || "?"}` : ""} />
          <Row label="Company situation" value={form.company_situation} />
        </>,
      )}
      {block(
        "objectives",
        "Objectives & decisions",
        form.objectives.length ? (
          form.objectives.map((o, i) => (
            <Row
              key={`${o.id}-${i}`}
              label={`${i + 1}. Importance ${o.strategic_importance}`}
              value={`${o.name}${o.key_decision ? ` — ${o.key_decision}` : ""}${o.decision_date ? ` by ${o.decision_date}` : ""}`}
            />
          ))
        ) : (
          <Row label="Objectives" value="" />
        ),
      )}
      {block(
        "landscape",
        "Evidence landscape",
        <>
          <Row label="Competitive pressure" value={form.competitive_pressure} />
          <Row label="Competitors" value={form.competitors.map((c) => `${c.name} (${c.pressure})`).join(", ")} />
          <Row label="Standard of care" value={form.standard_of_care} />
          <Row label="Comparators" value={list(form.comparators)} />
          <Row label="Payer / HTA bodies" value={list(form.payer_hta_bodies)} />
          <Row label="Regulatory milestones" value={form.regulatory_milestones.map((m) => `${m.name}${m.date ? ` (${m.date})` : ""}`).join("; ")} />
          <Row label="Launch timeline" value={form.launch_timeline} />
        </>,
      )}
      {block(
        "stakeholders",
        "Stakeholders",
        <Row label="Functions" value={form.stakeholders.map((s) => `${s.function}${s.lead ? ` (${s.lead})` : ""}`).join("; ")} />,
      )}
      {block("settings", "Treatment settings", <Row label="Settings" value={list(form.treatment_settings)} />)}
    </div>
  );
}
