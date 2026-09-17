import { resetSeed } from "../src/lib/iegp/store";

async function main() {
  const state = await resetSeed();
  console.log(
    `Blank ${state.asset.name} workspace: wizard ${state.asset.wizard_complete ? "complete" : "open"}. Demo files ingest on first visit.`,
  );
  process.exit(0);
}

void main();
