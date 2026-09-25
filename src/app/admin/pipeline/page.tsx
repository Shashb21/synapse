import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import "@/modules";
import { AdminMain, PageIntro } from "@/components/admin/admin-page";
import { Badge } from "@/components/ui/badge";
import { RunStageButton } from "@/components/platform/run-stage-button";
import { stageNeedsAi } from "@/modules/kernel/stage-ai";
import { RunEvalsButton } from "@/components/platform/run-evals-button";
import { ChainRunner, ModularUploadForm } from "@/components/platform/pipeline-runner";
import { STAGES, STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { stageWiring } from "@/modules/kernel/registry";
import { previewRoute } from "@/modules/kernel/routing";
import { listRuns } from "@/modules/kernel/observability";
import { aiEnabled } from "@/modules/kernel/ai-switch";
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

/** Where each AI stage's work is done by hand while AI is off. */
const ADD_GAPS = { href: "/?place=gaps", label: "Add gaps" };
const ADD_TACTICS = { href: "/tactics", label: "Add tactics" };
const MANUAL_PATH: Partial<Record<StageId, { href: string; label: string }[]>> = {
  S0: [ADD_GAPS, ADD_TACTICS],
  S1: [ADD_GAPS, ADD_TACTICS],
  S2: [ADD_GAPS],
  S3: [ADD_TACTICS],
  S4: [{ href: "/mappings", label: "Map gaps to tactics" }],
  S6: [{ href: "/gaps", label: "Split a gap by hand" }],
  S8: [{ href: "/?place=plan", label: "Prioritize" }],
  S9: [{ href: "/ideation", label: "Add ideas" }],
};

/** The manual walk-through shown in place of upload and the chains while AI is off. */
const MANUAL_STEPS: { href: string; label: string; detail: string }[] = [
  { href: "/?place=gaps", label: "Add gaps", detail: "Enter each evidence gap and its needs." },
  { href: "/tactics", label: "Add tactics", detail: "Enter the studies and activities in the library." },
  { href: "/mappings", label: "Map", detail: "Record which tactic covers which gap." },
  { href: "/?place=plan", label: "Prioritize", detail: "Place each gap on the matrix and confirm its band." },
  { href: "/ideation", label: "Ideate", detail: "Add proposed tactics for open gaps." },
  { href: "/timeline", label: "Timeline", detail: "Add and move activities; S10 lays out your dates." },
];

export default async function PipelinePage() {
  await requireOwnerPage();
  const [wiring, runs, identity, files, documents, iegp, ai] = await Promise.all([
    stageWiring(),
    listRuns({ limit: 200 }),
    sessionContext(),
    listSourceFiles(),
    listParsedDocuments(),
    loadState(),
    aiEnabled(),
  ]);
  const routes = await Promise.all(STAGE_IDS.map((stage) => previewRoute(stage)));
  const actionIdentity = {
    signed_in: identity.signed_in,
    actor_name: identity.actor.name,
    actor_function: identity.actor.function,
  };

  return (
    <AdminMain>
      <PageIntro kicker="Modular pipeline · S0 → S10" title="Pipeline">
        {ai
          ? "Each stage is its own module behind a versioned contract. Run one stage, or run the chain. Every run is traced, scored and attributed."
          : "AI is off, so there is no upload, parsing or AI stage to run. Every step is done by hand on its own page; consolidation (S7) and the timeline (S10) still run without a model."}
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

      {ai ? null : (
        <section
          className="mb-8 border border-border bg-card/40 p-3"
          aria-labelledby="manual"
          data-testid="pipeline-ai-off"
        >
          <h2 id="manual" className="text-[13px] font-medium text-foreground">
            AI is off — done by hand
          </h2>
          <p className="mb-3 mt-1 text-[11px] text-muted-foreground">
            Start with Add gaps and Add tactics, then work down the list.
          </p>
          <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {MANUAL_STEPS.map((step, index) => (
              <li key={step.href + step.label} className="text-[12px] text-muted-foreground">
                <span className="text-foreground">{index + 1}. </span>
                <Link href={step.href} className="font-medium text-foreground underline-offset-2 hover:underline">
                  {step.label}
                </Link>{" "}
                — {step.detail}
              </li>
            ))}
          </ol>
        </section>
      )}

      {ai ? (
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
              { stage: "S4", label: "S4 Mapping table" },
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
      ) : null}

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
                      {ai ? `${route.provider_label} · ${route.model}` : "unused while AI is off"}
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

              {ai && route.degraded && wired.active?.agentic ? (
                <p className="text-[11px] text-[var(--unknown)]">{route.reason}</p>
              ) : null}

              {lastRun?.summary ? (
                <p className="text-[11px] text-muted-foreground">{lastRun.summary}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {!ai && stageNeedsAi(stage) ? (
                  <span className="text-[11px] text-muted-foreground" data-testid={`ai-off-${stage}`}>
                    AI is off — done by hand.{" "}
                    {(MANUAL_PATH[stage] ?? []).map((path, pathIndex) => (
                      <span key={path.href + path.label}>
                        {pathIndex > 0 ? " · " : null}
                        <Link href={path.href} className="text-foreground underline-offset-2 hover:underline">
                          {path.label}
                        </Link>
                      </span>
                    ))}
                  </span>
                ) : DIRECT_RUN.includes(stage) ? (
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
                {ai && wired.has_evals ? <RunEvalsButton stage={stage} identity={actionIdentity} /> : null}
                {lastRun ? (
                  <Link href={`/admin/runs/${lastRun.id}`} className="text-[11px] text-muted-foreground no-underline hover:text-foreground">
                    View trace
                  </Link>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </AdminMain>
  );
}
