import type { ZodType } from "zod";
import type { ActorFunction } from "@/lib/iegp/enums";

/**
 * Stage identifiers from the architecture plan. A stage is a contract slot:
 * exactly one module implementation is active per stage at a time, and it can
 * be swapped without touching its neighbours.
 */
export const STAGE_IDS = [
  "S0",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8",
  "S9",
  "S10",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type StageKind = "mechanical" | "agentic" | "human_gate" | "derived" | "presentation";

export type StageDescriptor = {
  id: StageId;
  title: string;
  purpose: string;
  kind: StageKind;
  /** Stages whose outputs this stage reads. Documentation for the run graph. */
  upstream: StageId[];
};

export const STAGES: Record<StageId, StageDescriptor> = {
  S0: {
    id: "S0",
    title: "File upload",
    purpose: "Accept stakeholder and internal source files for a workspace.",
    kind: "mechanical",
    upstream: [],
  },
  S1: {
    id: "S1",
    title: "File parse",
    purpose: "Turn raw files into parse artifacts with quality signals.",
    kind: "mechanical",
    upstream: ["S0"],
  },
  S2: {
    id: "S2",
    title: "Evidence gap extraction",
    purpose: "Propose evidence gaps from parsed documents (proposer → critic → judge).",
    kind: "agentic",
    upstream: ["S1"],
  },
  S3: {
    id: "S3",
    title: "Tactic extraction",
    purpose: "Propose tactics from parsed documents (proposer → critic → judge).",
    kind: "agentic",
    upstream: ["S1"],
  },
  S4: {
    id: "S4",
    title: "LLM mapping table",
    purpose: "Propose a per-gap mapping table (tactic assignments + status) via LLM; user edits feed hillclimb.",
    kind: "agentic",
    upstream: ["S2", "S3"],
  },
  S5: {
    id: "S5",
    title: "Gap classification & validation",
    purpose: "First user touch: classify, validate mappings, edit, add. Every edit carries a rationale.",
    kind: "human_gate",
    upstream: ["S4"],
  },
  S6: {
    id: "S6",
    title: "Partial gap split",
    purpose: "Propose a split of a partially addressed gap into addressed + open children.",
    kind: "agentic",
    upstream: ["S5"],
  },
  S7: {
    id: "S7",
    title: "Open / addressed consolidation",
    purpose: "Derive the definitive open and addressed lists from validated state.",
    kind: "derived",
    upstream: ["S6"],
  },
  S8: {
    id: "S8",
    title: "Prioritization",
    purpose: "Suggest High / Medium / Low on configurable axes; the user validates.",
    kind: "agentic",
    upstream: ["S7"],
  },
  S9: {
    id: "S9",
    title: "Tactics ideation",
    purpose: "Propose tactics for high-priority open gaps (proposer → critic → judge).",
    kind: "agentic",
    upstream: ["S8"],
  },
  S10: {
    id: "S10",
    title: "Interactive Gantt timeline",
    purpose: "Present the validated IEGP as the truth artifact: Gantt, detail, export, save final.",
    kind: "presentation",
    upstream: ["S9"],
  },
};

export type ModuleManifest = {
  /** Globally unique: `<stage-slug>.<implementation>`. */
  id: string;
  stage: StageId;
  /** Module version. Independent of every other module. */
  version: string;
  title: string;
  summary: string;
  /**
   * Envelope contract version the module speaks. The kernel refuses to activate
   * a module whose contract version it does not understand.
   */
  contract: 1;
  /** True when the module routes LLM calls through the control panel. */
  agentic: boolean;
  capabilities?: string[];
};

export const KERNEL_CONTRACT = 1 as const;

export type Actor = {
  name: string;
  function: ActorFunction;
};

/** One observable step inside a module run. */
export type RunStep = {
  name: string;
  at: string;
  duration_ms: number | null;
  detail: string | null;
  data: unknown;
};

export type RunStatus = "running" | "ok" | "error";

export type RunHandle = {
  id: string;
  /** Record a named step with optional structured payload. */
  step<T>(name: string, fn: () => Promise<T> | T, detail?: string): Promise<T>;
  /** Record a fact without timing a function. */
  note(name: string, data?: unknown, detail?: string): void;
  steps(): RunStep[];
};

export type EvalScore = {
  name: string;
  value: number;
  /** Optional pass threshold; when set, `value >= target` is a pass. */
  target?: number;
  unit?: "ratio" | "count" | "ms";
  detail?: string;
};

export type HillclimbSignalKind =
  | "user_edit"
  | "user_rejected_proposal"
  | "user_accepted_proposal"
  | "eval_regression"
  | "parse_quality"
  | "hillclimb_promotion";

export type HillclimbSignalDraft = {
  stage: StageId;
  kind: HillclimbSignalKind;
  /** Entity the signal is about, e.g. `gap:G-12`. */
  subject: string;
  rationale: string;
  weight?: number;
  payload?: unknown;
};

export type ResolvedRoute = {
  stage: StageId;
  provider_id: string;
  provider_label: string;
  model: string;
  auth: "oauth" | "api_key" | "none";
  connected: boolean;
  params: { temperature: number; max_tokens: number };
  fallbacks: string[];
  /** True when the route fell back because the preferred provider is unusable. */
  degraded: boolean;
  reason: string | null;
};

/** JSON completion bound to a resolved route and to the run's observability. */
export type JsonCompletion = (args: {
  system: string;
  user: string;
  purpose: string;
  maxTokens?: number;
}) => Promise<unknown>;

export type ModuleContext = {
  workspace_id: string;
  actor: Actor;
  role: string;
  run: RunHandle;
  route: ResolvedRoute;
  complete: JsonCompletion;
};

export type ModuleResult<O> = {
  output: O;
  /** One-line human summary shown in the observability list. */
  summary: string;
  evals?: EvalScore[];
  signals?: HillclimbSignalDraft[];
};

export type EvalCase<I> = {
  name: string;
  input: I;
  /** Curated gold metadata (not passed to the module input schema). */
  gold?: {
    pack: string;
    source_id: string;
    must_match?: string[];
    parse_min_blocks?: number;
    parse_min_need_cues?: number;
  };
};

export type EvalHarness<I, O> = {
  /** Gold cases the stage scores itself against. */
  cases: () => Promise<EvalCase<I>[]>;
  score: (args: { case: EvalCase<I>; output: O }) => EvalScore[];
};

export interface SynapseModule<I, O> {
  manifest: ModuleManifest;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  run(input: I, ctx: ModuleContext): Promise<ModuleResult<O>>;
  evals?: EvalHarness<I, O>;
  /** DDL owned by this module. The kernel applies it before the first run. */
  migrations?: string[];
}

/** Any module, for registry storage where the payload types are opaque. */
export type AnyModule = SynapseModule<never, unknown>;

export function stageTitle(stage: StageId): string {
  return `${stage} · ${STAGES[stage].title}`;
}
