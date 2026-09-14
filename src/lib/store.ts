import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptProposal,
  rejectProposal,
  proposeCatalogChanges,
} from "@/lib/cluster/catalog-evolution";
import { buildSeedState, ingestParsedDocument, seedCatalog } from "@/lib/pipeline";
import { engineStateSchema, type EngineState, type ParsedDocument } from "@/lib/schema";

const RUNTIME_DIR = path.join(process.cwd(), "data", "runtime");
const STATE_PATH = path.join(RUNTIME_DIR, "engine-state.json");

let cache: EngineState | null = null;

async function persist(state: EngineState) {
  try {
    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Vercel / read-only: keep in-memory only.
  }
}

function hydrate(state: EngineState): EngineState {
  const catalog = state.catalog.length > 0 ? state.catalog : seedCatalog();
  return {
    ...state,
    catalog,
    catalog_proposals: proposeCatalogChanges(
      state.insights,
      catalog,
      state.catalog_proposals,
    ),
  };
}

export async function getState(): Promise<EngineState> {
  if (cache) return cache;
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    cache = hydrate(engineStateSchema.parse(JSON.parse(raw)));
    return cache;
  } catch {
    cache = buildSeedState();
    await persist(cache);
    return cache;
  }
}

export async function resetState(): Promise<EngineState> {
  cache = buildSeedState();
  await persist(cache);
  return cache;
}

export async function addDocument(document: ParsedDocument): Promise<EngineState> {
  const current = await getState();
  cache = await ingestParsedDocument(current, document);
  await persist(cache);
  return cache;
}

export async function decideCatalogProposal(
  proposalId: string,
  decision: "accepted" | "rejected",
): Promise<EngineState> {
  const current = await getState();
  cache =
    decision === "accepted"
      ? acceptProposal(current, proposalId)
      : rejectProposal(current, proposalId);
  await persist(cache);
  return cache;
}

export type DashboardView = ReturnType<typeof dashboardView>;

export function dashboardView(state: EngineState) {
  const known = state.insights.filter((i) => i.classification === "known");
  const unknown = state.insights.filter((i) => i.classification === "unknown");
  const opportunities = state.insights.filter(
    (i) => i.classification === "opportunity",
  );
  const functions = [...new Set(state.documents.map((d) => d.stakeholder_function))];
  const coverageByFunction = functions.map((fn) => ({
    function: fn,
    documents: state.documents.filter((d) => d.stakeholder_function === fn).length,
    insights: state.insights.filter((i) => i.stakeholder_function === fn).length,
  }));
  const multiSource = state.insights.filter(
    (i) => i.knowledge_state.evidence_strength !== "single_source",
  ).length;
  const latest = state.eval_runs[state.eval_runs.length - 1];
  const championRun = state.eval_runs.find(
    (r) => r.prompt_version === state.champion_prompt_version,
  );
  return {
    asset: state.asset,
    champion_prompt_version: state.champion_prompt_version,
    kpis: {
      documents: state.documents.length,
      insights: state.insights.length,
      themes: state.themes.length,
      known: known.length,
      unknown: unknown.length,
      opportunities: opportunities.length,
      multi_source_rate:
        state.insights.length === 0
          ? 0
          : Math.round((multiSource / state.insights.length) * 100),
      multi_theme: state.insights.filter((i) => i.theme_ids.length > 1).length,
      gold: state.gold.length,
      champion_composite: championRun?.metrics.composite ?? 0,
      catalog_proposals: state.catalog_proposals.filter((p) => p.status === "proposed")
        .length,
      catalog_size: state.catalog.filter((c) => c.id !== "THEME-RESIDUAL").length,
    },
    known,
    unknown,
    opportunities,
    themes: state.themes,
    documents: state.documents.map((d) => ({
      id: d.id,
      filename: d.filename,
      title: d.title,
      stakeholder_function: d.stakeholder_function,
      parser: d.parser,
      ingested_at: d.ingested_at,
      blocks: d.blocks.length,
    })),
    coverageByFunction,
    latest_eval: latest ?? null,
    eval_runs: state.eval_runs,
  };
}
