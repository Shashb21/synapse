import { sql } from "drizzle-orm";
import { runStage, type StageRunResult } from "@/modules/kernel/run";
import { sharedDb } from "@/modules/kernel/db";
import { nowIso } from "@/modules/kernel/ids";
import { isTestStub } from "@/modules/kernel/llm";
import { resolveRoute } from "@/modules/kernel/routing";
import type { Actor, StageId } from "@/modules/kernel/contracts";
import { AI_SECTIONS, type AiSectionId } from "@/modules/kernel/ai-sections";
import { AiDisabledError, platformAiEnabled } from "@/modules/kernel/ai-switch";
import { replaceContentsOf } from "@/modules/workspaces/contents";
import { createWorkspace, getWorkspace, withWorkspace } from "@/modules/workspaces/store";
import { createGap, loadState } from "@/lib/iegp/store";
import { eligibilityGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { SOURCE_TYPES, type EvidenceDomain } from "@/lib/iegp/enums";
import { movePlacement, validatePlacement } from "@/modules/stages/s8-prioritization/module";
import { loadAxes } from "@/modules/stages/s8-prioritization/axes";

/**
 * The admin AI harness (owner, 2026-09-30, KAN-54): each AI use case runs on its own
 * against the live routed model, on the Velmara samples or on the admin's own input.
 * Nothing is scored; the output is shown for the admin to judge. Every run happens in a
 * private sandbox workspace, reset to the demo first, so customer data is never touched.
 * The harness ignores the per-section switches, but never the platform master switch:
 * with AI off for the platform no model is called (KAN-61).
 */

const SANDBOX_KEY = "ai_harness_workspace";
const SANDBOX_OWNER = "ai-harness@synapse.internal";

export class HarnessNotBuiltError extends Error {}
export class HarnessNoModelError extends Error {}

/** Why the harness will not run while the platform AI switch is off. */
export const HARNESS_AI_OFF_MESSAGE =
  "AI is turned off for the platform, so the harness calls no model. Turn AI on in AI & routing to run it.";

/** The harness refused because the platform AI switch is off (409 `ai_off`). */
export class HarnessAiOffError extends AiDisabledError {
  constructor() {
    super();
    this.message = HARNESS_AI_OFF_MESSAGE;
  }
}

export type HarnessInput = {
  /** "sample" runs the fixed Velmara input; "custom" runs the admin's own. */
  mode: "sample" | "custom";
  /** Ingestion and extraction: a demo file id (sample) or pasted text (custom). */
  demo_id?: string;
  title?: string;
  text?: string;
  /** Mapping, prioritization, ideation: a gap written by the admin (custom). */
  gap_name?: string;
  gap_statement?: string;
  gap_domain?: EvidenceDomain;
  /** Partial split: which of the sandbox's partially addressed gaps (custom). */
  gap_id?: string;
};

export type HarnessStep = {
  stage: StageId;
  run_id: string;
  module: string;
  mode: "llm" | "deterministic";
  summary: string;
  output: unknown;
};

export type HarnessResult = {
  case: AiSectionId;
  mode: HarnessInput["mode"];
  /** Which model answered (or "test stub" in the unit and e2e suites). */
  route: string;
  started_at: string;
  duration_ms: number;
  /** The run of the use case itself; setup runs (upload, parse) come first in `steps`. */
  steps: HarnessStep[];
  /** What the run was given, in words, so the output can be read against it. */
  input_summary: string;
  /** The sandbox workspace every run here was recorded in, so a trace link can open it. */
  workspace_id: string;
};

/** The sandbox workspace: created once, owned by an internal principal no customer can be. */
export async function harnessSandboxId(): Promise<string> {
  const rows = (await sharedDb().execute(
    sql`select value from platform_settings where key = ${SANDBOX_KEY} limit 1`,
  )) as unknown as { value: { workspace_id?: string } }[];
  const known = rows[0]?.value.workspace_id;
  if (known && (await getWorkspace(known))) return known;
  const workspace = await createWorkspace({ name: "AI harness sandbox", owner: SANDBOX_OWNER, ai_enabled: true });
  await sharedDb().execute(
    sql`insert into platform_settings (key, value, updated_by, updated_at)
        values (${SANDBOX_KEY}, ${JSON.stringify({ workspace_id: workspace.id })}::jsonb, ${"ai-harness"}, ${nowIso()})
        on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  );
  return workspace.id;
}

/** The stage the use case itself runs (setup runs come before it). */
const CASE_STAGE: Record<AiSectionId, StageId> = {
  ingestion: "S1",
  gap_extraction: "S2",
  tactic_extraction: "S3",
  mapping: "S4",
  gap_status: "S5",
  partial_split: "S6",
  prioritization: "S8",
  ideation: "S9",
};

async function routeLabel(stage: StageId): Promise<string> {
  if (isTestStub()) return "test stub (unit and e2e suites only)";
  try {
    const route = await resolveRoute(stage);
    if (!route.connected) throw new Error(route.reason ?? "not connected");
    return `${route.provider_label} · ${route.model}${route.degraded ? ` (fallback: ${route.reason})` : ""}`;
  } catch (error) {
    throw new HarnessNoModelError(harnessNoModelMessage(stage, error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Why a case cannot run without a model. The routing reason often already says where
 * to set the provider's API key, so the message ends with a single instruction, not
 * the same one twice.
 */
export function harnessNoModelMessage(stage: StageId, reason: string): string {
  const detail = reason.trim().replace(/[.\s]+$/, "") || "no API key is set";
  const advice = /\bserver environment\b/i.test(detail)
    ? ""
    : " Set the provider's API key in the server environment.";
  return `No live model is available for ${stage}: ${detail}.${advice}`;
}

/** The sandbox's partially addressed gaps, for the split case's picker. */
export async function harnessPartialGaps(): Promise<{ id: string; name: string }[]> {
  const sandbox = await harnessSandboxId();
  return withWorkspace(sandbox, async () => {
    await replaceContentsOf(sandbox, "demo");
    const state = await loadState();
    return state.gaps
      .filter((gap) => isLiveGap(gap) && eligibilityGapStatus(gap, state) === "validated_partial")
      .map((gap) => ({ id: gap.id, name: gap.name }));
  });
}

export async function runHarness(args: { case: AiSectionId; input: HarnessInput; actor: Actor }): Promise<HarnessResult> {
  const section = AI_SECTIONS.find((row) => row.id === args.case);
  if (!section) throw new Error("Unknown AI use case.");
  if (!section.built) {
    throw new HarnessNotBuiltError(`${section.label}: no AI module is developed yet. ${section.detail}`);
  }
  if (!(await platformAiEnabled())) throw new HarnessAiOffError();
  const stage = CASE_STAGE[args.case];
  const route = await routeLabel(stage);
  const sandbox = await harnessSandboxId();
  const started = Date.now();
  const steps: HarnessStep[] = [];

  const run = async <O>(runStageId: StageId, input: unknown): Promise<StageRunResult<O>> => {
    const result = await runStage<O>({
      stage: runStageId,
      input,
      actor: args.actor,
      role: "operator",
      workspace_id: sandbox,
      force_ai: true,
    });
    steps.push({
      stage: runStageId,
      run_id: result.run_id,
      module: `${result.module_id} v${result.module_version}`,
      mode: result.mode,
      summary: result.summary,
      output: result.output,
    });
    return result;
  };

  const inputSummary = await withWorkspace(sandbox, async () => {
    await replaceContentsOf(sandbox, "demo");
    const { input } = args;
    const mode = input.mode;

    /** Upload and parse one source into the sandbox; returns its document id. */
    const parseOne = async (): Promise<{ document_ids: string[]; described: string }> => {
      let upload: StageRunResult<{ files: { id: string }[]; skipped: { reason: string }[] }>;
      let described: string;
      if (mode === "custom") {
        const text = input.text?.trim();
        if (!text) throw new Error("Paste the source text to run on your own input.");
        const title = input.title?.trim() || "Harness source";
        upload = await run("S0", {
          files: [
            {
              filename: `${title.replaceAll(/\s+/g, "_")}.txt`,
              title,
              source_type: SOURCE_TYPES[0],
              stakeholder_function: "medical_affairs",
              text,
            },
          ],
        });
        described = `Your source “${title}” (${text.length} characters)`;
      } else {
        const demo = DEMO_PACK.find((file) => file.id === input.demo_id) ?? DEMO_PACK[0]!;
        upload = await run("S0", { demo_ids: [demo.id] });
        described = `Velmara sample “${demo.title}” (${demo.filename})`;
      }
      if (upload.output.files.length === 0) {
        throw new Error(`Nothing was uploaded: ${upload.output.skipped.map((row) => row.reason).join("; ")}`);
      }
      const parse = await run<{ documents: { id: string }[]; failures: { reason: string }[] }>("S1", {
        file_ids: upload.output.files.map((file) => file.id),
      });
      if (parse.output.failures.length > 0) {
        throw new Error(`Parsing failed: ${parse.output.failures.map((row) => row.reason).join("; ")}`);
      }
      return { document_ids: parse.output.documents.map((document) => document.id), described };
    };

    /** The admin's own gap, created in the sandbox as a validated Open gap. */
    const customGap = async (): Promise<string> => {
      const statement = input.gap_statement?.trim() || input.gap_name?.trim();
      if (!statement) throw new Error("Write the gap to run on your own input.");
      return createGap({
        name: input.gap_name?.trim() || undefined,
        statement,
        domain: input.gap_domain,
        actor_name: args.actor.name,
        actor_function: args.actor.function,
      });
    };

    switch (args.case) {
      case "ingestion": {
        const parsed = await parseOne();
        return parsed.described;
      }
      case "gap_extraction": {
        const parsed = await parseOne();
        await run("S2", { document_ids: parsed.document_ids, dry_run: true });
        return parsed.described;
      }
      case "tactic_extraction": {
        const parsed = await parseOne();
        await run("S3", { document_ids: parsed.document_ids, dry_run: true });
        return parsed.described;
      }
      case "mapping": {
        if (mode === "custom") {
          const gapId = await customGap();
          await run("S4", { gap_ids: [gapId], dry_run: true });
          return `Your gap “${input.gap_name || input.gap_statement}” against the Velmara tactic library`;
        }
        await run("S4", { dry_run: true });
        return "Every Velmara gap against the Velmara tactic library";
      }
      case "partial_split": {
        const state = await loadState();
        const partial = state.gaps.filter((gap) => isLiveGap(gap) && eligibilityGapStatus(gap, state) === "validated_partial");
        const gap = (mode === "custom" ? partial.find((row) => row.id === input.gap_id) : undefined) ?? partial[0];
        if (!gap) throw new Error("The sandbox has no partially addressed gap to split.");
        await run("S6", { gap_id: gap.id });
        return `Partially addressed gap ${gap.id}: “${gap.name}”`;
      }
      case "prioritization": {
        const axes = await loadAxes();
        const x_axis = axes.x_axis;
        const y_axis = axes.y_axis;
        if (mode === "custom") {
          const gapId = await customGap();
          await run("S8", { gap_ids: [gapId], x_axis, y_axis });
          return `Your gap “${input.gap_name || input.gap_statement}” on ${y_axis} × ${x_axis}`;
        }
        await run("S8", { x_axis, y_axis });
        return `Every Velmara Open gap on ${y_axis} × ${x_axis}`;
      }
      case "ideation": {
        if (mode === "custom") {
          const gapId = await customGap();
          const axes = await loadAxes();
          // Ideation serves gaps a person validated as High, so the sandbox copy is placed and validated High.
          await movePlacement({ gap_id: gapId, x_axis: axes.x_axis, y_axis: axes.y_axis, x: 90, y: 90, actor: args.actor });
          await validatePlacement({ gap_id: gapId, band: "high", rationale: "AI harness: treated as High", actor: args.actor });
          await run("S9", { gap_ids: [gapId], dry_run: true });
          return `Your gap “${input.gap_name || input.gap_statement}”, treated as High priority`;
        }
        await run("S9", { dry_run: true });
        return "The Velmara gaps validated as High priority";
      }
      default:
        throw new HarnessNotBuiltError(`${section.label}: no AI module is developed yet.`);
    }
  });

  return {
    case: args.case,
    mode: args.input.mode,
    route,
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    steps,
    input_summary: inputSummary,
    workspace_id: sandbox,
  };
}
