import { resetSeed } from "../src/lib/iegp/store";

async function main() {
  const state = await resetSeed();
  console.log(
    `Blank ${state.asset.name} workspace: ${state.needs.length} needs, ${state.gaps.length} gaps, ${state.tactics.length} tactics. Demo files are on /sources.`,
  );
  process.exit(0);
}

void main();
