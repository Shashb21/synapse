# Accuracy-first development orchestration

**Branch:** `cursor/accuracy-app-ready-b7b5`  
**Coordinator:** parent Project agent + worker `bc-483e609a`  
**Policy:** No TypeSafe Jev; schema-locked OAuth LLMs; BeOne reference gold per pack.

## Workstreams (parallel agents)

| ID | Owner agent | Module / surface | Done when |
| --- | --- | --- | --- |
| W1-parse | bc-78d9b5d3 | `parse` → LlamaParse/local + `accuracy_parse_blocks` | **Done** — ingest + persist tests |
| W2-ui | bc-23d9b506 | `/accuracy/*`, API runs + routing | **Done** — shell, control, runs |
| W3-gold | bc-3d8d3e46 | `eval/reference-gold.ts` | **Done** — must_find + `accuracyEvalReferencePack` stub |
| W4-inventory | bc-68e82881 | `inventory_extract` prompts + schema | **Done** — stub cycle + schema tests |
| W5-coverage | bc-f773715f | `coverage_decide` + critic | **Done** — buildStateFromBlocks + 7 tests |
| W6-gantt | bc-dc2ce4ab | `gantt_project` (`gantt-project/`) | **Done** — 7 unit tests, validated tactics only |
| W7-need | bc-75c52bec | `need_extract` | **Done** — schema, stub cycle, recall helper |
| W8-e2e | bc-3acd373b | Playwright `e2e/accuracy/` | **Done** — shell nav + orchestration API smoke |
| W9-ui | bc-4fa2de7b | Ledger + Timeline save-final | **Done** — claims validate, Gantt save-final, shell nav |
| W10-recall | bc-483e609a | gold pack recall scoring | **Done** — scorePackRecall + oracleFromGold |
| W11-app | bc-483e609a | sources/coverage/plan + gold seed | **In progress** |

## Merge rules

1. One module per PR commit series; rebase on branch tip before push.
2. Run `npm test -- tests/accuracy` + `npm run typecheck` before push.
3. `./scripts/push-both.sh` after each integrated milestone.
4. Agents must not mix reference gold across packs.

## Human gates (not agent-automated)

- Validate ledger, edit rationale, save-final Gantt. (**UI shipped in W9-ui**; human still performs the gate.)

## Status log

| When | Event |
| --- | --- |
| 2026-09-23 | Four background agents launched (W1–W4) |
| 2026-09-23 | Ideation vs inventory semantics landed (`iegp-semantics.ts`) |
| 2026-09-23 | **W3-gold complete** — `reference-gold.ts`, `accuracyEvalReferencePack` stub, 3 tests |
| 2026-09-23 | **W6-gantt complete** — `src/accuracy/modules/gantt-project/`, 7 unit tests |
| 2026-09-23 | **W1–W5 integrated** — parse ingest, `/accuracy` UI, inventory, coverage decide (36 accuracy tests) |
| 2026-09-23 | **W7-need complete** — need_extract module, provenance gaps, `scoreGapIdRecall` |
| 2026-09-23 | **W8-e2e complete** — Playwright accuracy shell smoke |
| 2026-09-23 | **W9-ui complete** — `/accuracy/ledger`, `/accuracy/timeline`, validation-gate persistence, save-final Gantt APIs |
| 2026-09-23 | **W9-gold-fill** — Populated BGB 43 gaps + 36 tactics and Tisle G:1–G:21 from PPTX |
| 2026-09-23 | **W10-recall** — Pack recall scoring (`scorePackRecall`, oracle-from-gold) |
| 2026-09-23 | **W11-app** — Workspaces seed-from-gold, Sources/Coverage/Plan screens |
