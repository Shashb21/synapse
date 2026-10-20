# Client demo workspace (KAN-138)

A workspace an admin puts in **client demo mode** runs the whole Synapse walkthrough on seven fictional Velmara documents. Every AI step replays a recorded Claude run instead of calling a model. It costs nothing, gives the same result every time, and works on the deployed site. Normal workspaces always use real AI, including workspaces that loaded the Velmara demo data.

## Setting one up

1. Create a workspace (for example "Client demo").
2. Admin → Choose a workspace → tick **Client demo mode** on that row.
   - Turning it on replaces the workspace's contents with the demo starting point: the Velmara asset, objectives and planning context, setup done, and no sources.
   - Turning it off only clears the flag; the contents stay.
3. Every page of the workspace now shows the demo bar: "Client demo mode: AI steps replay a recorded run".

## Running a demo

| Step | Where | What the presenter does |
|---|---|---|
| Upload | Upload | **Ingest this file** on each of the seven documents. Each takes about a minute, with the usual progress steps. |
| Evidence inventory | Gaps | Review the gaps; **Accept all as in demo** confirms them, splitting each Partially Addressed gap as the AI proposes, or keeping it Open where no split holds up. |
| Prioritization | Prioritization Matrix | The AI places the Open gaps when the page opens; **Accept all as in demo** validates every suggested band and opens tactic ideation. |
| Ideation | Ideation | **Generate ideas for these gaps**, then **Accept all as in demo**. |
| Timeline | Gantt Timeline | **Rebuild from validated state**, then **Accept all as in demo** (dependencies and date estimates). |

- **Reset demo** (owner only, in the demo bar) puts the workspace back to the starting point before the next client.
- **Download demo files** gives `velmara-demo-files.zip`: the seven documents, for the presenter or to share with the client.

The presenter can make decisions by hand instead of using Accept all. Decisions that differ from the recording change later prompts; the replay then answers with the closest recorded call. If a step was never recorded, it says so in plain words.

## What demo mode changes

- **AI:** `resolveRoute` gives the workspace the `demo-replay` route, and `tracedCompletion` answers from `src/lib/demo/recording.json` after a 1.2–2.8 s pause (`SYNAPSE_DEMO_REPLAY_DELAY_MS` overrides it). Calls are logged in `llm_calls` as provider `demo-replay`, at $0.
  - **Matching:** a call is matched by stage, purpose and prompt. The prompt is compared with ids replaced by placeholders: an exact fingerprint first, else the closest word overlap.
  - **Ids:** recorded ids are mapped onto this run's ids by what the prompt says each one is (its anchor), so a different listing order cannot swap two gaps.
- **Uploads:** only the seven client documents are accepted, matched by their text. Anything else is refused before it is stored, and no model is called.
- **Learning:** the workspace shows no other plans' worked examples, and its decisions are not recorded as learning examples (no lesson calls).

## Recording a new run

Re-record when the documents or a stage's prompts change enough that the replay stops matching.

1. Turn on demo mode for a scratch workspace, and route every stage to the model you want recorded. Use `set_default_provider`, then set the agentic stages with no fallbacks.
2. Start the dev server with `SYNAPSE_DEMO_RECORD=1`. The demo-mode workspace then calls the real model. This is refused in production.
3. Walk the demo once exactly as in the table above, using **Accept all as in demo** at every step.
4. Export the calls: `DATABASE_URL=… npx tsx scripts/export-demo-recording.ts <workspace_id>`. The script refuses a run whose prompts carry another workspace's worked examples.
5. Restore the routing and commit `recording.json`.

The October 2026 recording used Claude Sonnet 5.5: 354 calls, $23.98 one-off. The documents live in `src/lib/demo/client-pack/*.txt`; after editing them, run `node scripts/build-client-demo-pack.mjs`. The short `DEMO_PACK` used by tests, the harness and gold evals is separate.
