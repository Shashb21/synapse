import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CostRollupPanel } from "@/components/accuracy/cost-rollup-panel";
import { registerAccuracyStack } from "@/accuracy";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { listCoveragePairs } from "@/accuracy/store/coverage-store";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { listAccuracyRuns, summarizeAccuracyRunCost } from "@/accuracy/kernel/observability";
import type { AccuracyCostRollup } from "@/accuracy/kernel/cost-rollup";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

type AuditRow = {
  kind: "validation" | "coverage" | "priority" | "run";
  at: string;
  title: string;
  detail: string;
};

export default async function AccuracyAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let rows: AuditRow[] = [];
  let rollup: AccuracyCostRollup | null = null;
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const [claims, pairs, runs, cost] = await Promise.all([
        listClaims(workspaceId, { limit: 300 }),
        listCoveragePairs(workspaceId),
        listAccuracyRuns(workspaceId, 40),
        summarizeAccuracyRunCost(workspaceId),
      ]);
      rollup = cost;

      for (const claim of claims) {
        const meta = claimMetadata(claim);
        const validation = meta.validation;
        if (validation && typeof validation === "object") {
          const v = validation as {
            action?: string;
            rationale?: string;
            at?: string;
            by?: string;
          };
          rows.push({
            kind: "validation",
            at: v.at ?? claim.updated_at,
            title: `${v.action ?? "decision"} · ${claim.claim_type}`,
            detail: `${claim.statement.slice(0, 120)} — ${v.rationale ?? ""} (${v.by ?? "unknown"})`,
          });
        }
        if (typeof meta.priority_rationale === "string" && meta.priority_rationale) {
          rows.push({
            kind: "priority",
            at: claim.updated_at,
            title: `priority → ${String(meta.priority ?? "?")}`,
            detail: `${claim.statement.slice(0, 100)} — ${meta.priority_rationale}`,
          });
        }
      }

      for (const pair of pairs) {
        if (!pair.validated || !pair.rationale) continue;
        rows.push({
          kind: "coverage",
          at: pair.gap.updated_at,
          title: `coverage · ${pair.overall ?? "unknown"}`,
          detail: `${pair.gap.statement.slice(0, 80)} ↔ ${pair.tactic.statement.slice(0, 80)} — ${pair.rationale}`,
        });
      }

      for (const run of runs) {
        const costLabel = run.cost_usd ? ` · $${run.cost_usd}` : "";
        rows.push({
          kind: "run",
          at: run.started_at,
          title: `${run.call_kind} · ${run.status}${costLabel}`,
          detail: run.summary ?? run.module_id,
        });
      }

      rows.sort((a, b) => b.at.localeCompare(a.at));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load audit";
  }

  const active = workspaces.find((w) => w.id === workspaceId);

  return (
    <AccuracyAppShell active="audit">
      <PageIntro kicker="Trace · rationales & runs" title="Audit">
        Hillclimb trail: validation rationales, coverage decisions, priority changes, module runs, and
        estimated spend for one workspace.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <p className="text-[12px] text-muted-foreground">
          Open from{" "}
          <Link href="/accuracy" className="underline-offset-2 hover:underline">
            Workspaces
          </Link>{" "}
          with a <code>workspace_id</code>.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active?.name ?? workspaceId} · {rows.length} event(s)
          </p>
          {rollup ? <CostRollupPanel rollup={rollup} workspaceName={active?.name} /> : null}
          {rows.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No audit events yet. Validate claims, decide coverage, or run modules.
            </p>
          ) : (
            <ul className="grid gap-2">
              {rows.slice(0, 80).map((row, index) => (
                <li key={`${row.kind}-${row.at}-${index}`} className="border border-border bg-card/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[12px] font-medium text-foreground">{row.title}</p>
                    <span className="font-mono text-[10px] text-muted-foreground">{row.at}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted-foreground">{row.detail}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {row.kind}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
