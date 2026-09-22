import Link from "next/link";
import "@/modules";
import { AppShell, PageIntro } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { RunEvalsButton } from "@/components/platform/run-evals-button";
import { ChainRunner, ModularUploadForm } from "@/components/platform/pipeline-runner";
import { STAGES, STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { previewRoute } from "@/modules/kernel/routing";
import { listRuns } from "@/modules/kernel/observability";
import { sessionContext } from "@/modules/auth/session";
import { loadState } from "@/lib/iegp/store";
import { DEMO_FILE_OPTIONS, listSourceFiles } from "@/modules/stages/s0-upload/module";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";

export const dynamic = "force-dynamic";

const KIND_COPY: Record<string, string> = {
  mechanical: "mechanical",
  agentic: "proposer → critic → judge",
  human_gate: "human gate",
  derived: "derived",
  presentation: "presentation",
};

const STAGE_INPUT: Partial<Record<StageId, Record<string, unknown>>> = {
  S10: { persist: true },
};

/** Stages that a user can trigger straight from here without choosing a subject. */
const DIRECT_RUN: StageId[] = ["S1", "S2", "S3", "S4", "S7", "S8", "S9", "S10"];

export default async function PipelinePage() {
  const [wiring, runs, identity, files, documents, iegp] = await Promise.all([
    stageWiring(),
    listRuns({ limit: 200 }),
    sessionContext(),
    listSourceFiles(),
    listParsedDocuments(),
    loadState(),
  ]);
  const routes = await Promise.all(STAGE_IDS.map((stage) => previewRoute(stage)));
  const actionIdentity = {
    signed_in: identity.signed_in,
    actor_name: identity.actor.name,
    actor_function: identity.actor.function,
  };

  return (
    <AppShell active="pipeline">
      <PageIntro kicker="Modular pipeline · S0 → S10" title="Pipeline">
        Each stage is its own module behind a versioned contract. Run one stage, or run the chain. Every
        run is traced, scored and attributed.
      </PageIntro>

      {!iegp.asset.setup_complete ? (
        <p className="mb-6 border border-[var(--chart-1)]/30 bg-[var(--chart-1)]/5 px-3 py-2 text-[12px] text-muted-foreground">
          New here?{" "}
          <Link href="/setup" className="font-medium text-foreground underline-offset-2 hover:underline">
            Complete the setup wizard
          </Link>{" "}
          to capture asset context and walk the pipeline before your first run.
        </p>
      ) : null}

      <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="border border-border bg-card/40 p-3" aria-labelledby="ingest">
          <h2 id="ingest" className="text-[13px] font-medium text-foreground">
            S0 · Upload sources
          </h2>
          <p className="mb-3 mt-1 text-[11px] text-muted-foreground">
            {files.length} file(s) uploaded, {documents.length} parsed.
          </p>
          <ModularUploadForm demoOptions={DEMO_FILE_OPTIONS} identity={actionIdentity} />
        </section>

        <section className="border border-border bg-card/40 p-3" aria-labelledby="chain">
          <h2 id="chain" className="text-[13px] font-medium text-foreground">
            Run the chain
          </h2>
          <p className="mb-3 mt-1 text-[11px] text-muted-foreground">
            Extraction through mapping, then consolidation, prioritization and the timeline. Human gates
            (S5, S6) stay where they belong: on Gaps and the split dialog.
          </p>
          <ChainRunner
            label="Parse → extract → map → consolidate"
            identity={actionIdentity}
            steps={[
              { stage: "S1", label: "S1 Parse" },
              { stage: "S2", label: "S2 Gap extraction" },
              { stage: "S3", label: "S3 Tactic extraction" },
              { stage: "S4", label: "S4 Knowledge graph" },
              { stage: "S7", label: "S7 Consolidation" },
            ]}
          />
          <div className="mt-3 border-t border-border pt-3">
            <ChainRunner
              label="Prioritize → ideate → timeline"
              identity={actionIdentity}
              steps={[
                { stage: "S8", label: "S8 Prioritization" },
                { stage: "S9", label: "S9 Ideation" },
                { stage: "S10", label: "S10 Timeline", input: { persist: true } },
              ]}
            />
          </div>
        </section>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {STAGE_IDS.map((stage, index) => {
          const descriptor = STAGES[stage];
          const wired = wiring.find((row) => row.stage === stage)!;
          const route = routes[index]!;
          const lastRun = runs.find((run) => run.stage === stage);
          return (
            <article key={stage} className="grid content-start gap-2 border border-border bg-card/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-[13px] font-medium text-foreground">
                    {stage} · {descriptor.title}
                  </h2>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{descriptor.purpose}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {KIND_COPY[descriptor.kind]}
                </Badge>
              </div>

              <dl className="grid gap-1 text-[11px] text-muted-foreground">
                <div className="flex justify-between gap-2">
                  <dt>Module</dt>
                  <dd className="truncate text-foreground">
                    {wired.active ? `${wired.active.id} v${wired.active.version}` : "none"}
                  </dd>
                </div>
                {wired.active?.agentic ? (
                  <div className="flex justify-between gap-2">
                    <dt>Route</dt>
                    <dd className="truncate text-foreground">
                      {route.provider_label} · {route.model}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-2">
                  <dt>Last run</dt>
                  <dd className="truncate text-foreground">
                    {lastRun ? `${lastRun.status} · ${lastRun.started_at.slice(0, 16).replace("T", " ")}` : "never"}
                  </dd>
                </div>
              </dl>

              {route.degraded && wired.active?.agentic ? (
                <p className="text-[11px] text-[var(--unknown)]">{route.reason}</p>
              ) : null}

              {lastRun?.summary ? (
                <p className="text-[11px] text-muted-foreground">{lastRun.summary}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {DIRECT_RUN.includes(stage) ? (
                  <RunStageButton
                    stage={stage}
                    input={STAGE_INPUT[stage]}
                    label={`Run ${stage}`}
                    identity={actionIdentity}
                  />
                ) : stage === "S0" ? (
                  <span className="text-[11px] text-muted-foreground">Upload above.</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Runs from the {stage === "S5" ? "Gaps workbench" : "split dialog"}, per gap.
                  </span>
                )}
                {wired.has_evals ? <RunEvalsButton stage={stage} identity={actionIdentity} /> : null}
                {lastRun ? (
                  <Link href={`/runs/${lastRun.id}`} className="text-[11px] text-muted-foreground no-underline hover:text-foreground">
                    View trace
                  </Link>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </AppShell>
  );
}
