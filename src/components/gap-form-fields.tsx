import { DOMAIN_LABELS, EVIDENCE_DOMAINS } from "@/lib/iegp/enums";

const INPUT = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const AREA = "w-full rounded-lg border border-input bg-card px-2.5 py-2 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[11px] font-medium text-muted-foreground";
const HINT = "text-[10.5px] font-normal leading-4 text-muted-foreground/90";

/**
 * Everything a gap carries, entered when it is created (owner feedback, KAN-52): title,
 * domain, what evidence is missing, treatment settings, who it affects and where, notes.
 */
export function GapFormFields() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={`${LABEL} sm:col-span-2`}>
        Title
        <input
          name="name"
          required
          placeholder="Comparative effectiveness in elderly patients"
          className={INPUT}
        />
        <span className={HINT}>A short name for the gap, as it shows in lists and on the matrix.</span>
      </label>
      <label className={`${LABEL} sm:col-span-2`}>
        Description — what evidence is missing
        <textarea
          name="statement"
          rows={3}
          placeholder="No head-to-head data versus the regional standard of care in patients aged 65 and over."
          className={AREA}
        />
        <span className={HINT}>
          The full sentence behind the title. Tactics and sources are matched against it, so the more precise, the
          better the mapping. Left blank, the title is used.
        </span>
      </label>
      <label className={LABEL}>
        Domain
        <select name="domain" required defaultValue="" className={INPUT}>
          <option value="" disabled>
            Choose a domain
          </option>
          {EVIDENCE_DOMAINS.map((domain) => (
            <option key={domain} value={domain}>
              {DOMAIN_LABELS[domain]}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Treatment settings
        <input name="settings" placeholder="1L, Perioperative" className={INPUT} />
        <span className={HINT}>Comma-separated. The matrix can be scoped by setting.</span>
      </label>
      <label className={LABEL}>
        Impacted stakeholders
        <input name="stakeholders" placeholder="Payers, HTA bodies, KOLs" className={INPUT} />
        <span className={HINT}>Comma-separated.</span>
      </label>
      <label className={LABEL}>
        Geography
        <input name="geography" placeholder="US, EU5" className={INPUT} />
      </label>
      <label className={`${LABEL} sm:col-span-2`}>
        Regional nuances
        <textarea
          name="regional_nuances"
          rows={2}
          placeholder="Germany: G-BA expects a comparator matching regional standard of care."
          className={AREA}
        />
      </label>
      <label className={`${LABEL} sm:col-span-2`}>
        Notes
        <textarea name="notes" rows={2} className={AREA} />
      </label>
    </div>
  );
}
