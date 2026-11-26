// Run this after a fresh, approved fictional Velmara walkthrough in record mode.
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { buildDemoRecording, recordingInterval, type DemoRecordingRow } from "@/lib/demo/recording-export";

async function main() {
  const [, , workspaceId, recordingId, start, end] = process.argv;
  const url = process.env.DATABASE_URL;
  if (!workspaceId || !recordingId || !start || !end || !url) {
    throw new Error("Usage: DATABASE_URL=… npx tsx scripts/export-demo-recording.ts <workspace_id> <recording_uuid> <started_at_UTC> <ended_at_UTC>");
  }
  const interval = recordingInterval(workspaceId, recordingId, start, end);
  const sql = postgres(url, { max: 1 });
  try {
    const [workspace] = await sql<{ demo_mode: boolean }[]>`
      select demo_mode from public.workspaces where id = ${workspaceId}`;
    if (!workspace?.demo_mode) throw new Error("Select the owner-enabled Velmara demo workspace used for recording.");

    const rows = await sql<DemoRecordingRow[]>`
      select stage, purpose, system_prompt, user_prompt, reply, provider_id, demo_fixture,
        demo_recording_id, attempt, workspace_id, created_at, status
      from public.llm_calls
      where workspace_id = ${workspaceId} and created_at >= ${interval.startedAt}
        and created_at < ${interval.endedAt}
      order by created_at, id`;
    const recording = buildDemoRecording(rows, interval, new Date().toISOString());
    const out = path.join(process.cwd(), "src/lib/demo/recording-replay.json");
    const pending = `${out}.${process.pid}.tmp`;
    writeFileSync(pending, `${JSON.stringify(recording)}\n`, { flag: "wx" });
    renameSync(pending, out);
    console.log(`Wrote ${recording.calls.length} exact Velmara calls to ${out}.`);
  } finally {
    await sql.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
