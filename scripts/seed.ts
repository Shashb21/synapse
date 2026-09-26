import { resetBlank, resetDemo } from "../src/lib/iegp/store";

/**
 * Replaces the Default workspace's plan. `--blank` empties it; otherwise it
 * loads the full Velmara demo (seed.ts). Demo data is never a default for new
 * workspaces; this script is how a developer asks for it.
 */
async function main() {
  const blank = process.argv.includes("--blank");
  const state = blank ? await resetBlank() : await resetDemo();
  console.log(
    blank
      ? "Blank workspace: no asset details, objectives, sources, gaps or tactics."
      : `Demo workspace (${state.asset.name}): ${state.sources.length} sources, ${state.gaps.length} gaps, ${state.tactics.length} tactics.`,
  );
  process.exit(0);
}

void main();
