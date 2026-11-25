# Velmara client demo workspace

A platform owner can enable **Client demo mode** for a workspace dedicated to the seven fictional Velmara documents. The customer walkthrough uses the Velmara fixture. Loading the Velmara sample plan in an ordinary workspace keeps that workspace on its configured live route.

## Setting up the workspace

1. Create a workspace for the presentation.
2. Under **Admin → Choose a workspace**, enable **Client demo mode** for that workspace. This replaces its contents with the Velmara starting point, including the asset, objectives and planning context.
3. Open the customer workspace. The demo bar shows that AI steps use recorded answers. **Download demo files** supplies the seven approved files and **Reset demo** restores the starting point for the workspace owner.

## Walkthrough

| Step | Where | Presenter action |
|---|---|---|
| Upload | Upload | Choose **Ingest this file** for each document, in pack order. |
| Evidence inventory | Gaps | Review the gaps and choose **Accept all as in demo**. The shortcut requests each partial split and keeps the gap open if the split judge returns no proposal. |
| Prioritization | Prioritization Matrix | Generate priority bands and choose **Accept all as in demo** to validate them and open ideation. |
| Ideation | Ideation | Choose **Generate ideas for these gaps**. Choose **Accept all as in demo**, review the list, then choose **Accept ideas**. The selected ideas and their decision history save together. If an idea has changed or the list includes overlapping proposals, reopen the list or review the ideas individually. |
| Timeline | Gantt Timeline | Rebuild from the displayed Velmara start date, **19 October 2026**, then choose **Accept all as in demo** for dependencies and date estimates. |

The compatibility manifest supports exact parsing and classification for all seven approved files. Current gap and tactic extraction send sectioned text with block IDs. The retained historical extraction replies apply to the earlier requests and cannot answer the current ones. The upload walkthrough stops at the first gap extraction. A full walkthrough requires approved recording entries for S2–S10.

A missed step shows recovery instructions and leaves existing checkpoints available. If a reset and the approved files still give a miss, contact the Synapse administrator for a fixture update.

## Matching and trace

The customer stage and ingestion entry points check the selected workspace and owner switch. The fixture matches stage, purpose, system prompt and user prompt. Only declared application ID positions receive corresponding slots. System instructions, file IDs, source text, quotes, ordering and identifier relationships stay exact. An incompatible request fails with `demo_replay_miss`, and a failed ingestion stage keeps its run trace and previous checkpoint.

Replay appears as **Recorded Velmara demo** in stage results and as `demo-replay` with model `recorded`, fixture `velmara-client-demo` and zero provider cost in the call trace. Upload progress reports recorded Velmara steps already completed. Completed uploads show **Includes recorded Velmara steps** when any stage used replay. The default pause is 1.2–2.8 seconds and `SYNAPSE_DEMO_REPLAY_DELAY_MS` overrides it. Client demo upload accepts only the approved file texts. Demo stages exclude worked examples and learning capture. Incoming-source comparison is outside the recorded workflow.

## Refreshing the fixture

The historical October 2026 run contains 354 Claude calls in `src/lib/demo/recording.json`. `src/lib/demo/recording-replay.json` binds compatible replies to current requests and pins reused historical replies by digest. The seventh file has a curated parse repair for 18 verbatim bullet markers required by the current source-coverage checks. The current S2 and S3 demo prompts use block handles based on each document's block order. Extraction checks the quote in its source section before saving the workspace block ID. A new recording must use these prompts to replay after a reset.

A new recording uses a dedicated workspace with approved fictional data, an authorized provider route, a fresh recording UUID and UTC start and end times.

1. Enable demo mode and reset the dedicated workspace. Configure the stage routes for the recording.
2. Generate a fresh UUID and start the development server with `SYNAPSE_DEMO_RECORD=1` and `SYNAPSE_DEMO_RECORDING_ID=<recording_uuid>`. Customer walkthrough requests then use the configured live route and store that UUID on clean Velmara calls. Production uses replay.
3. Note the UTC start, walk the approved sequence, and note the UTC end after the last stage finishes. Keep the workspace dedicated to one recording during this interval.
4. Run `DATABASE_URL=… npx tsx scripts/export-demo-recording.ts <workspace_id> <recording_uuid> <started_at_UTC> <ended_at_UTC>`. Use timestamps such as `2026-11-25T08:00:00Z`. The start is inclusive and the end is exclusive. The exporter refuses rows from another recording and requires every row in the interval to be a successful, marked Velmara call with a usable initial JSON reply and no worked examples. Repeated requests are accepted only when their parsed replies agree after exact identifier rebinding.
5. Switch the server back to replay, reset the workspace and verify the full walkthrough with fresh IDs. Restore routing before committing the refreshed manifest.

The approved files live in `src/lib/demo/client-pack/`. Run `node scripts/build-client-demo-pack.mjs` after an approved edit to that pack. The short `DEMO_PACK` is used by tests, the harness and gold evaluations.
