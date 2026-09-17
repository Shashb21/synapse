import { resetSeed } from "../src/lib/iegp/store";

async function main() {
  const state = await resetSeed();
  console.log(
    `Seeded ${state.asset.name}: ${state.needs.length} needs, ${state.gaps.length} gaps, ${state.tactics.length} tactics`,
  );
  process.exit(0);
}

void main();
