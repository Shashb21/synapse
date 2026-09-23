import type { ZodType } from "zod";
import type { ActorFunction } from "@/lib/iegp/enums";

/** Accuracy-first pipeline slots (not S0–S10). */
export const CALL_KINDS = [
  "upload",
  "parse",
  "inventory_extract",
  "need_extract",
  "merge_dedupe",
  "completeness_audit",
  "pair_generate",
  "coverage_decide",
  "coverage_critic",
  "validation_gate",
  "partial_split",
  "status_derive",
  "prioritize",
  "ideate",
  "gantt_project",
] as const;

export type CallKind = (typeof CALL_KINDS)[number];

export const AGENT_ROLES = ["proposer", "critic", "reviser", "judge"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export type CallKindKind =
  | "mechanical"
  | "agentic"
  | "human_gate"
  | "derived"
  | "presentation";

export type CallKindDescriptor = {
  id: CallKind;
  title: string;
  purpose: string;
  kind: CallKindKind;
  /** Roles that may invoke LLM routing for this kind (empty = no LLM). */
  llm_roles: AgentRole[];
  upstream: CallKind[];
};

export const CALL_KINDS_META: Record<CallKind, CallKindDescriptor> = {
  upload: {
    id: "upload",
    title: "Source upload",
    purpose: "Accept files for one IEGP workspace.",
    kind: "mechanical",
    llm_roles: [],
    upstream: [],
  },
  parse: {
    id: "parse",
    title: "Parse store",
    purpose: "PDF/PPTX via LlamaParse; DOCX/text via local structured parse.",
    kind: "mechanical",
    llm_roles: [],
    upstream: ["upload"],
  },
  inventory_extract: {
    id: "inventory_extract",
    title: "Tactic inventory",
    purpose: "Recall committed tactics from parse blocks (inventory-first on plans).",
    kind: "agentic",
    llm_roles: ["proposer", "critic", "reviser", "judge"],
    upstream: ["parse"],
  },
  need_extract: {
    id: "need_extract",
    title: "Evidence needs",
    purpose: "Recall evidence gaps/needs with verbatim provenance.",
    kind: "agentic",
    llm_roles: ["proposer", "critic", "reviser", "judge"],
    upstream: ["parse", "inventory_extract"],
  },
  merge_dedupe: {
    id: "merge_dedupe",
    title: "Merge & dedupe",
    purpose: "Unify candidates on study IDs and provenance overlap.",
    kind: "mechanical",
    llm_roles: [],
    upstream: ["inventory_extract", "need_extract"],
  },
  completeness_audit: {
    id: "completeness_audit",
    title: "Completeness audit",
    purpose: "Index vs inventory miss flags (recall gate).",
    kind: "mechanical",
    llm_roles: [],
    upstream: ["merge_dedupe"],
  },
  pair_generate: {
    id: "pair_generate",
    title: "Pair generator",
    purpose: "Candidate gap↔tactic pairs (deterministic + high-recall lexical).",
    kind: "mechanical",
    llm_roles: [],
    upstream: ["merge_dedupe"],
  },
  coverage_decide: {
    id: "coverage_decide",
    title: "Coverage decision",
    purpose: "Schema-locked pairwise coverage enums + quote IDs.",
    kind: "agentic",
    llm_roles: ["proposer", "judge"],
    upstream: ["pair_generate"],
  },
  coverage_critic: {
    id: "coverage_critic",
    title: "Coverage critic",
    purpose: "Second pass on low-confidence pairs.",
    kind: "agentic",
    llm_roles: ["critic"],
    upstream: ["coverage_decide"],
  },
  validation_gate: {
    id: "validation_gate",
    title: "Human validation",
    purpose: "Promote draft claims to validated ledger; mandatory edit rationale.",
    kind: "human_gate",
    llm_roles: [],
    upstream: ["coverage_decide", "coverage_critic"],
  },
  partial_split: {
    id: "partial_split",
    title: "Partial split",
    purpose: "Residual gap from partial coverage; parent preserved.",
    kind: "agentic",
    llm_roles: ["proposer", "critic", "reviser", "judge"],
    upstream: ["validation_gate"],
  },
  status_derive: {
    id: "status_derive",
    title: "Status engine",
    purpose: "Open / Partial / Addressed from validated joins + tactic lifecycle.",
    kind: "derived",
    llm_roles: [],
    upstream: ["validation_gate", "partial_split"],
  },
  prioritize: {
    id: "prioritize",
    title: "Prioritization",
    purpose: "H/M/L on validated open gaps + planning context.",
    kind: "agentic",
    llm_roles: ["proposer", "critic", "reviser", "judge"],
    upstream: ["status_derive"],
  },
  ideate: {
    id: "ideate",
    title: "Tactics ideation",
    purpose: "Net-new proposed tactics for high-priority open gaps.",
    kind: "agentic",
    llm_roles: ["proposer", "critic", "reviser", "judge"],
    upstream: ["prioritize"],
  },
  gantt_project: {
    id: "gantt_project",
    title: "Gantt projection",
    purpose: "Deterministic timeline from validated tactics — no invented studies.",
    kind: "presentation",
    llm_roles: [],
    upstream: ["status_derive", "prioritize", "ideate"],
  },
};

export const ACCURACY_KERNEL_CONTRACT = 1 as const;

export type Actor = { name: string; function: ActorFunction };

export type RunStep = {
  name: string;
  at: string;
  duration_ms: number | null;
  detail: string | null;
  data: unknown;
};

export type RunStatus = "running" | "ok" | "error" | "abandoned";

export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type CostEstimate = {
  provider_id: string;
  model: string;
  usage: TokenUsage;
  /** USD estimate from live price table */
  cost_usd: number;
  price_source: string;
};

export type ResolvedAccuracyRoute = {
  call_kind: CallKind;
  role: AgentRole | "none";
  provider_id: string;
  provider_label: string;
  model: string;
  auth: "oauth" | "api_key" | "none";
  connected: boolean;
  params: { temperature: number; max_tokens: number };
  fallbacks: string[];
  degraded: boolean;
  reason: string | null;
};

export type JsonCompletion = (args: {
  system: string;
  user: string;
  purpose: string;
  maxTokens?: number;
}) => Promise<{ raw: string; usage: TokenUsage }>;

export type RunHandle = {
  id: string;
  step<T>(name: string, fn: () => Promise<T> | T, detail?: string): Promise<T>;
  note(name: string, data?: unknown, detail?: string): void;
  steps(): RunStep[];
};

export type EvalScore = {
  name: string;
  value: number;
  target?: number;
  unit?: "ratio" | "count" | "ms" | "usd";
  detail?: string;
};

export type ModuleManifest = {
  id: string;
  call_kind: CallKind;
  version: string;
  title: string;
  summary: string;
  contract: typeof ACCURACY_KERNEL_CONTRACT;
  agentic: boolean;
};

export type AccuracyModuleContext = {
  org_id: string;
  workspace_id: string;
  actor: Actor;
  role: string;
  run: RunHandle;
  route: ResolvedAccuracyRoute;
  complete: JsonCompletion;
  /** Accumulated cost for this module run */
  noteCost: (cost: CostEstimate) => void;
};

export type ModuleResult<O> = {
  output: O;
  summary: string;
  evals?: EvalScore[];
};

export interface AccuracyModule<I, O> {
  manifest: ModuleManifest;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  run(input: I, ctx: AccuracyModuleContext): Promise<ModuleResult<O>>;
  migrations?: string[];
}

export type AnyAccuracyModule = AccuracyModule<unknown, unknown>;

export function callKindTitle(kind: CallKind): string {
  return `${kind} · ${CALL_KINDS_META[kind].title}`;
}
