import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { LedgerClaimCard, type LedgerClaimCardModel } from "@/components/accuracy/ledger-claim-card";
import { LedgerFilterBar } from "@/components/accuracy/ledger-filter-bar";
import { LedgerMergedList, type MergedClaimModel } from "@/components/accuracy/ledger-merged-list";
import { LedgerNewClaimForm } from "@/components/accuracy/ledger-new-claim-form";
import { claimFieldSnapshot } from "@/accuracy/domain/claim-fields";
import { humanLockedFields } from "@/accuracy/store/claim-edit";
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";
import { registerAccuracyStack } from "@/accuracy";
import {
  chapterLabel,
  claimChapterSlug,
  claimSiSlugs,
  filterLedgerClaims,
  ledgerFilterFacets,
  parseLedgerFilters,
  siThemeLabel,
} from "@/accuracy/domain/ledger-filters";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { latestWorkshopSnapshot, workshopReadiness } from "@/accuracy/store/workshop-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

type ClaimRow = Awaited<ReturnType<typeof listClaims>>[number];

function toCard(claim: ClaimRow, statementById: Map<string, string>): LedgerClaimCardModel {
  const meta = claimMetadata(claim);
  const lastEdit =
    meta.last_human_edit && typeof meta.last_human_edit === "object"
      ? (meta.last_human_edit as { at?: unknown; by?: unknown; rationale?: unknown })
      : null;
  const proposal = meta.merge_proposal ?? null;
  const chapter = claimChapterSlug({ metadata: meta });
  const si = claimSiSlugs({ metadata: meta })[0] ?? null;
  return {
    id: claim.id,
    claim_type: claim.claim_type,
    statement: claim.statement,
    status: claim.status,
    validated: claim.validated,
    source_badge: String(meta.source_badge ?? claim.source_file_id ?? "unspecified source"),
    validation_rationale: meta.validation?.rationale ?? null,
    computed_status: typeof meta.computed_status === "string" ? meta.computed_status : null,
    external_id: typeof meta.external_id === "string" ? meta.external_id : null,
    chapter_label: chapter ? chapterLabel(chapter) : null,
    si_label: si ? siThemeLabel(si) : null,
    fields: claimFieldSnapshot(claim),
    human_locked: humanLockedFields(meta),
    last_edit: lastEdit
      ? {
          at: String(lastEdit.at ?? ""),
          by: String(lastEdit.by ?? ""),
          rationale: String(lastEdit.rationale ?? ""),
        }
      : null,
    status_override:
      meta.status_override && typeof meta.status_override === "object"
        ? String(meta.status_override.status ?? "") || null
        : null,
    merge_proposal: proposal
      ? {
          survivor_id: proposal.survivor_id,
          survivor_statement: statementById.get(proposal.survivor_id) ?? null,
          reason: proposal.reason,
          rationale: proposal.rationale ?? null,
        }
      : null,
  };
}

export default async function AccuracyLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; chapter?: string; si?: string }>;
}) {
  const params = await searchParams;
  const workspaceId = params.workspace_id ?? "";
  const filters = parseLedgerFilters(params);

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let gaps: LedgerClaimCardModel[] = [];
  let tactics: LedgerClaimCardModel[] = [];
  let facets = ledgerFilterFacets([]);
  let tacticOptions: { id: string; statement: string }[] = [];
  let gapTargets: { id: string; statement: string }[] = [];
  let merged: MergedClaimModel[] = [];
  let loadError: string | null = null;
  let ready: Awaited<ReturnType<typeof workshopReadiness>>["readiness"] | null = null;
  let hasSnapshot = false;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const claims = await listClaims(workspaceId);
      const live = claims.filter((c) => c.status !== "merged");
      const statementById = new Map(claims.map((c) => [c.id, c.statement]));
      const active = live.filter((c) => c.status !== "rejected");
      tacticOptions = active
        .filter((c) => c.claim_type === "tactic")
        .map((c) => ({ id: c.id, statement: c.statement }));
      gapTargets = active
        .filter((c) => c.claim_type === "gap")
        .map((c) => ({ id: c.id, statement: c.statement }));
      merged = claims
        .filter((c) => c.status === "merged")
        .map((c) => {
          const meta = claimMetadata(c);
          const into = typeof meta.merged_into === "string" ? meta.merged_into : null;
          return {
            id: c.id,
            claim_type: c.claim_type,
            statement: c.statement,
            merged_into: into,
            merged_into_statement: into ? (statementById.get(into) ?? null) : null,
            merge_reason: typeof meta.merge_reason === "string" ? meta.merge_reason : null,
          };
        });
      facets = ledgerFilterFacets(live.map((c) => ({ metadata: claimMetadata(c) })));
      const visible = filterLedgerClaims(
        live.map((c) => ({ ...c, metadata: claimMetadata(c) })),
        filters,
      );
      gaps = visible
        .filter((c) => c.claim_type === "gap")
        .map((c) => toCard(c, statementById));
      tactics = visible
        .filter((c) => c.claim_type === "tactic")
        .map((c) => toCard(c, statementById));
      const workshop = await workshopReadiness(workspaceId);
      ready = workshop.readiness;
      hasSnapshot = Boolean(await latestWorkshopSnapshot(workspaceId));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load ledger";
  }

  const activeWorkspace = workspaces.find((row) => row.id === workspaceId);
  const planLabel = workspacePlanLabel(activeWorkspace);
  const filtering = Boolean(filters.chapter || filters.si);

  return (
    <AccuracyAppShell active="ledger" planLabel={planLabel}>
      <PageIntro kicker="Human gate · gaps & tactics" title="Ledger">
        Draft and validated claims for one workspace. Filter by chapter (Tisle) or SI (BGB). Validate
        or reject with a rationale — every decision feeds hillclimb.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <section className="grid gap-2" aria-labelledby="ledger-empty">
          <h2 id="ledger-empty" className="text-[15px] font-medium text-foreground">
            Choose a workspace
          </h2>
          <p className="text-[12px] text-muted-foreground">
            No workspace selected. Open a workspace from{" "}
            <Link href="/accuracy" className="text-foreground underline-offset-2 hover:underline">
              Workspaces
            </Link>{" "}
            or append <code className="text-[11px]">?workspace_id=</code> to this URL.
          </p>
          {workspaces.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="inline-flex rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground no-underline hover:text-foreground"
                  >
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <>
          <section className="mb-6 grid gap-2" aria-labelledby="workspace-picker">
            <h2 id="workspace-picker" className="text-[15px] font-medium text-foreground">
              Workspace
              {activeWorkspace ? (
                <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                  · {activeWorkspace.name}
                  {planLabel ? ` · ${planLabel}` : ""}
                </span>
              ) : null}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className={`inline-flex rounded-md border px-2 py-1 text-[12px] no-underline ${
                      workspace.id === workspaceId
                        ? "border-foreground bg-card text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          {ready ? (
            <WorkshopSaveCta
              workspaceId={workspaceId}
              ready={ready.ready}
              blockers={ready.blockers}
              hasSnapshot={hasSnapshot}
              workshopHref={`/accuracy/workshop?workspace_id=${encodeURIComponent(workspaceId)}`}
            />
          ) : null}

          <LedgerNewClaimForm workspaceId={workspaceId} tacticOptions={tacticOptions} />

          <LedgerFilterBar workspaceId={workspaceId} facets={facets} selected={filters} />

          <section className="mb-8 grid gap-2" aria-labelledby="gaps-section">
            <h2 id="gaps-section" className="text-[15px] font-medium text-foreground">
              Gaps
            </h2>
            {gaps.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                {filtering
                  ? "No gap cards match these filters."
                  : "No gap claims in this workspace yet."}
              </p>
            ) : (
              <ul className="grid gap-2">
                {gaps.map((claim) => (
                  <LedgerClaimCard
                    key={claim.id}
                    claim={claim}
                    workspaceId={workspaceId}
                    tacticOptions={tacticOptions}
                    mergeTargets={gapTargets.filter((row) => row.id !== claim.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2" aria-labelledby="tactics-section">
            <h2 id="tactics-section" className="text-[15px] font-medium text-foreground">
              Tactics
            </h2>
            {tactics.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                {filtering
                  ? "No tactic cards match these filters."
                  : "No tactic claims in this workspace yet."}
              </p>
            ) : (
              <ul className="grid gap-2">
                {tactics.map((claim) => (
                  <LedgerClaimCard
                    key={claim.id}
                    claim={claim}
                    workspaceId={workspaceId}
                    tacticOptions={tacticOptions}
                    mergeTargets={tacticOptions.filter((row) => row.id !== claim.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <LedgerMergedList workspaceId={workspaceId} rows={merged} />
        </>
      )}
    </AccuracyAppShell>
  );
}
