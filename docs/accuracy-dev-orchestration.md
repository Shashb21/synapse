# Accuracy-first development orchestration

**Branch:** `cursor/accuracy-first-modular-b7b5`  
**Coordinator:** parent Project agent + worker `bc-483e609a`  
**Policy:** No TypeSafe Jev; schema-locked OAuth LLMs; BeOne reference gold per pack.

## Workstreams (parallel agents)

| ID | Owner agent | Module / surface | Done when |
| --- | --- | --- | --- |
| W1-parse | bc-78d9b5d3 | `parse` → LlamaParse/local + `accuracy_parse_blocks` | Vitest + blocks persisted |
| W2-ui | bc-23d9b506 | `/accuracy/*`, API runs + routing | typecheck + pages render |
| W3-gold | bc-3d8d3e46 | `eval/reference-gold.ts` | **Done** — must_find + `accuracyEvalReferencePack` stub |
| W4-inventory | bc-68e82881 | `inventory_extract` prompts + schema | stub LLM test green |
| W5-coverage | (next) | `coverage_decide` + critic | Zod decision + pair tests |
| W6-gantt | (next) | `gantt_project` from validated tactics | no invented bars test |
| W7-need | (next) | `need_extract` | per-source gap recall eval |
| W8-e2e | (next) | Playwright `e2e/accuracy/` | upload reference pack path |

## Merge rules

1. One module per PR commit series; rebase on branch tip before push.
2. Run `npm test -- tests/accuracy` + `npm run typecheck` before push.
3. `./scripts/push-both.sh` after each integrated milestone.
4. Agents must not mix reference gold across packs.

## Human gates (not agent-automated)

- Validate ledger, edit rationale, save-final Gantt.

## Status log

| When | Event |
| --- | --- |
| 2026-09-23 | Four background agents launched (W1–W4) |
| 2026-09-23 | Ideation vs inventory semantics landed (`iegp-semantics.ts`) |
| 2026-09-23 | **W3-gold complete** ([Reference gold eval harness](bc-3d8d3e46-1846-51af-97ab-241685d52ed4)) — `reference-gold.ts`, `accuracyEvalReferencePack` stub, 3 tests |
