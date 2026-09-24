import { notFound } from "next/navigation";
import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { CoverageBadge, LockMeta, TacticBadge } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { TACTIC_STATUSES, TACTIC_TYPE_LABELS, TACTIC_TYPES } from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { sessionContext } from "@/modules/auth/session";

export const dynamic = "force-dynamic";

export default async function TacticDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [state, session] = await Promise.all([loadState(), sessionContext()]);
  const tactic = state.tactics.find((x) => x.id === id);
  if (!tactic) notFound();
  const maps = state.coverages.filter((c) => c.tactic_id === tactic.id);
  const identity: ActionIdentity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };

  return (
    <AppShell active="tactics">
      <PageIntro kicker={TACTIC_TYPE_LABELS[tactic.type]} title={tactic.name}>
        {tactic.description}
      </PageIntro>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TacticBadge status={tactic.status} />
        <span className="text-[11px] capitalize text-muted-foreground">
          Review: {tactic.review_status}
        </span>
        <LockMeta lock={tactic.lock} />
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <ActionDialog
          endpoint="/api/iegp"
          payload={{ action: "modify_tactic", tactic_id: tactic.id }}
          identity={identity}
          label="Edit tactic"
          title={`Edit ${tactic.id}`}
          description="Your values replace the current ones and are locked to you. AI re-runs never rewrite an existing tactic; the Timeline uses the dates you enter here."
          confirmLabel="Save edit"
          fields={[
            { name: "name", label: "Name", defaultValue: tactic.name, required: true },
            {
              name: "type",
              label: "Type",
              type: "select",
              defaultValue: tactic.type,
              options: TACTIC_TYPES.map((type) => ({ value: type, label: TACTIC_TYPE_LABELS[type] })),
            },
            { name: "evidence_question", label: "Evidence question", type: "textarea", defaultValue: tactic.evidence_question, required: true },
            { name: "population", label: "Population", defaultValue: tactic.population },
            { name: "intervention", label: "Intervention", defaultValue: tactic.intervention },
            { name: "comparator", label: "Comparator", defaultValue: tactic.comparator },
            { name: "outcomes", label: "Outcomes", defaultValue: tactic.outcomes },
            { name: "study_design", label: "Study design", defaultValue: tactic.study_design },
            { name: "data_source", label: "Data source", defaultValue: tactic.data_source },
            { name: "geography", label: "Geography", defaultValue: tactic.geography },
            { name: "start_date", label: "Start date (YYYY-MM-DD, blank for none)", placeholder: "2026-01-15", defaultValue: tactic.start_date ?? "" },
            {
              name: "evidence_available",
              label: "Evidence available (YYYY-MM-DD, blank for none)",
              placeholder: "2027-06-30",
              defaultValue: tactic.evidence_available ?? "",
            },
          ]}
        />
        {tactic.review_status !== "accepted" ? (
          <ActionDialog
            endpoint="/api/iegp"
            payload={{ action: "lock_tactic_review", tactic_id: tactic.id, review_status: "accepted" }}
            identity={identity}
            label="Accept tactic"
            description="Accepts this tactic into the library. The decision is locked to you."
            confirmLabel="Accept"
          />
        ) : null}
        {tactic.review_status !== "rejected" ? (
          <ActionDialog
            endpoint="/api/iegp"
            payload={{ action: "lock_tactic_review", tactic_id: tactic.id, review_status: "rejected" }}
            identity={identity}
            label="Reject tactic"
            description="Marks this tactic rejected: it stays on record but is not a real study for this plan."
            confirmLabel="Reject"
          />
        ) : null}
      </div>
      <dl className="mb-6 grid gap-2 text-[13px] sm:grid-cols-2">
        <Item k="Question" v={tactic.evidence_question} />
        <Item k="Population" v={tactic.population} />
        <Item k="Intervention" v={tactic.intervention} />
        <Item k="Comparator" v={tactic.comparator} />
        <Item k="Outcomes" v={tactic.outcomes} />
        <Item k="Geography" v={tactic.geography} />
        <Item k="Design" v={tactic.study_design} />
        <Item k="Data source" v={tactic.data_source} />
        <Item k="Start date" v={tactic.start_date ?? "—"} />
        <Item k="Evidence available" v={tactic.evidence_available ?? "—"} />
        {tactic.source_quote ? <Item k="Source quote" v={`“${tactic.source_quote}”`} /> : null}
        <Item k="Owner" v={`${tactic.owner} · ${tactic.function.replaceAll("_", " ")}`} />
        <Item k="Budget" v={tactic.budget ?? "—"} />
      </dl>
      <h2 className="mb-2 text-[13px] text-muted-foreground">Gaps this tactic is mapped to</h2>
      <div className="mb-6 grid gap-2">
        {maps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No mappings yet.</p>
        ) : (
          maps.map((c) => {
            const gap = state.gaps.find((g) => g.id === c.gap_id);
            return (
              <Link key={c.id} href={`/gaps/${c.gap_id}`} className="flex justify-between border border-border bg-card p-3 no-underline">
                <span>{gap?.name}</span>
                <CoverageBadge overall={c.overall} />
              </Link>
            );
          })
        )}
      </div>
      <LockForm label="Lock tactic status" action="lock_tactic" extra={{ tactic_id: tactic.id }}>
        <p className="text-[12px] text-muted-foreground">
          Changing status recomputes related gap status. Residuals stay open for a human to
          reassess. Nothing auto-closes.
        </p>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Status
          <select name="status" defaultValue={tactic.status} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {TACTIC_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </LockForm>
    </AppShell>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}
