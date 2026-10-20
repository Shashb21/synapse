// Exports a client-demo recording run into src/lib/demo/recording.json (KAN-138).
//
// 1. Turn on client demo mode for a workspace (Admin → Choose a workspace).
// 2. Start the dev server with SYNAPSE_DEMO_RECORD=1, so that workspace calls the real model.
// 3. Walk the demo once in that workspace: ingest the seven documents, run each AI step.
// 4. npx tsx scripts/export-demo-recording.ts <workspace_id>
//
// Only calls whose reply parses as JSON are kept (a retried reply is kept once, as
// the answer). Prompts never carry other plans' worked examples in demo mode; the
// export refuses a run that has them, so no other workspace's text is ever committed.
import { writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { recordedCallFrom, type Recording } from "@/lib/demo/replay";
import { WORKED_EXAMPLES_FRAMING } from "@/modules/kernel/decision-examples";

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error("Usage: npx tsx scripts/export-demo-recording.ts <workspace_id>");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL to the database the recording run used.");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  const rows = await sql<{ stage: string | null; purpose: string; system_prompt: string; user_prompt: string; reply: string; created_at: string; provider_id: string }[]>`
    select stage, purpose, system_prompt, user_prompt, reply, created_at, provider_id
    from public.llm_calls
    where workspace_id = ${workspaceId} and status = 'ok' and reply is not null and provider_id <> 'demo-replay'
    order by created_at asc`;
  await sql.end();

  const leaked = rows.find((row) => `${row.system_prompt}\n${row.user_prompt}`.includes(WORKED_EXAMPLES_FRAMING));
  if (leaked) {
    console.error(`Refusing: a ${leaked.purpose} prompt carries worked examples from other plans. Record in a demo-mode workspace.`);
    process.exit(1);
  }

  const kept = new Map<string, ReturnType<typeof recordedCallFrom>>();
  let dropped = 0;
  for (const row of rows) {
    try {
      extractJsonObject(row.reply);
    } catch {
      dropped += 1;
      continue;
    }
    const call = recordedCallFrom(row);
    // The same call made again (a retry, or the step run twice) keeps its latest answer.
    kept.set(`${call.stage}|${call.purpose}|${call.user_hash}`, call);
  }

  const recording: Recording = { recorded_at: new Date().toISOString(), calls: [...kept.values()] };
  const out = path.join(process.cwd(), "src/lib/demo/recording.json");
  writeFileSync(out, `${JSON.stringify(recording)}\n`);
  const providers = [...new Set(rows.map((row) => row.provider_id))].join(", ");
  console.log(`Wrote ${recording.calls.length} recorded calls to ${out} (${dropped} replies that were not JSON dropped; recorded with ${providers}).`);
}

void main();
