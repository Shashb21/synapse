import { buildSeed } from "./seed";
import type { Asset, IegpState } from "./types";

const AT = "2026-09-17T00:00:00.000Z";

/**
 * The asset row id of a blank workspace. The schema needs an id; it is never
 * shown. Names, INN, indication and geography stay empty until the setup
 * wizard (saveProductSetup) fills them in.
 */
export const BLANK_ASSET_ID = "ASSET";

function emptyState(asset: Asset, detail: string): IegpState {
  return {
    asset,
    objectives: [],
    sources: [],
    blocks: [],
    needs: [],
    gaps: [],
    need_gap_links: [],
    tactics: [],
    coverages: [],
    mapping_suggestions: [],
    residual_gap_suggestions: [],
    residuals: [],
    priorities: [],
    roadmap: [],
    audit: [
      {
        id: "AUD-BLANK",
        at: AT,
        actor_name: "System",
        actor_function: "evidence_lead",
        entity_type: "plan",
        entity_id: asset.id,
        action: "blank",
        detail,
      },
    ],
    gold_needs: [],
    gold_coverages: [],
    gap_versions: [],
    breakout_groups: [],
    breakout_group_gaps: [],
    gap_suggestions: [],
  };
}

/**
 * A truly blank IEGP: an empty asset and nothing else. No objectives, key
 * decisions, sources, gaps or tactics. Everything comes from the person, via
 * the setup wizard and the stages.
 */
export function buildBlankWorkspace(): IegpState {
  return emptyState(
    {
      id: BLANK_ASSET_ID,
      name: "",
      inn: "",
      indication: "",
      geography: "",
      wizard_complete: false,
      tactics_unlocked: false,
      setup_complete: false,
      planning_context: {},
    },
    "Blank IEGP workspace. Nothing is filled in until someone enters it.",
  );
}

/**
 * Demo fixture for tests: the Velmara demo's asset and objectives (from the
 * seed) with setup not yet done, and no sources, gaps or tactics. It is demo
 * data, so it is only loaded on request (the "load_demo" action with
 * scope "setup"), never as a default.
 */
export function buildDemoSetupWorkspace(): IegpState {
  const seed = buildSeed();
  const state = emptyState(
    {
      ...seed.asset,
      wizard_complete: false,
      tactics_unlocked: false,
      setup_complete: false,
      planning_context: {},
    },
    "Demo setup (Velmara): the demo asset and objectives, with no sources, gaps or tactics.",
  );
  return { ...state, objectives: seed.objectives.map((objective) => ({ ...objective })) };
}
