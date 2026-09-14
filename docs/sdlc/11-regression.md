# Regression matrix

Lock table for REQ-REG-001 / REQ-REG-002 / REQ-REG-004. Every **Must** requirement maps to a named test. User-flow IDs (REQ-UX-*) are the screens a brand analyst actually walks.

Commands:

```bash
npm test          # vitest — requirement IDs in the test name
npm run test:e2e  # Playwright against the running app (port 43217)
npm run ci        # unit + e2e
```

CI (`.github/workflows/ci.yml`) runs `npm test` and `tsc` on every push. Playwright is the local / agent regression spine until Origin images include browsers (REQ-REG-003 Should).

Do **not** click Catalog Accept/Reject or Ingest Reset inside parallel e2e: they mutate `engine-state.json` and race other files. Accept/reject and ingest-pipeline are locked in unit tests. E2E walks the screens.

A failing eval composite vs the committed champion is a **regress** (REQ-EVA-010), not a flake. Do not loosen gold to green the tape.

## User flow → tests

| Flow | REQ | Unit | E2E |
| --- | --- | --- | --- |
| Monitor: themes, situation, class counts, Unassigned last | REQ-UX-001, REQ-KNO-004 | `tests/req-kno-theme-brief.test.ts` | `e2e/user-flow.spec.ts`, `e2e/briefing.spec.ts` TDD-E2E-01 |
| Theme drill-in: CIR, source, cross-theme | REQ-UX-002, REQ-CLU-002 | `tests/req-clu-themes.test.ts` | both e2e files TDD-E2E-02 |
| Insights list + Unassigned + class filter | REQ-UX-003, REQ-CLU-005 | `tests/req-clu-themes.test.ts` | both e2e files TDD-E2E-05 |
| Catalog emerge/split copy, proposals, Accept UI | REQ-UX-004, REQ-CLU-007/008 | `tests/req-clu-catalog.test.ts` | both e2e files TDD-E2E-07 |
| Graph network + revelations | REQ-UX-005, REQ-GRF-001/002 | `tests/req-grf-graph.test.ts` | both e2e files TDD-E2E-06 |
| Ingest sources + upload control | REQ-UX-006, REQ-ING-005 | `tests/req-lock.test.ts` | `e2e/user-flow.spec.ts` |
| Source page CIR | REQ-UX-007 | — (join is CIR `source_document_id`) | `e2e/user-flow.spec.ts` |
| Eval tape view-only, automatic hill-climb | REQ-UX-008, REQ-EVA-009, REQ-OPS-001 | `tests/req-ext-eval.test.ts` | TDD-E2E-03 |
| Spec tape + flow diagrams | REQ-UX-008, REQ-OPS-003, REQ-REG-004 | — | TDD-E2E-04 |

## Engine Must REQ → tests

| ID | Test |
| --- | --- |
| REQ-ING-001/002/003 | `tests/req-ing-parse.test.ts` TDD-ING-01 |
| REQ-ING-004 | `tests/req-ing-llama-claude.test.ts` |
| REQ-ING-005 | `tests/req-lock.test.ts` |
| REQ-EXT-001 | `tests/req-ext-eval.test.ts` TDD-EXT-01 |
| REQ-EXT-002 | `tests/req-ext-eval.test.ts` grounding |
| REQ-EXT-003 | `tests/req-lock.test.ts` |
| REQ-EXT-004 | `tests/req-ext-eval.test.ts` TDD-EXT-02 |
| REQ-EXT-005 | `tests/req-lock.test.ts` |
| REQ-CLU-001 | `tests/req-lock.test.ts` |
| REQ-CLU-002/003/004/005 | `tests/req-clu-themes.test.ts` |
| REQ-CLU-006 | `tests/req-lock.test.ts` |
| REQ-CLU-007/008 | `tests/req-clu-catalog.test.ts` TDD-CLU-05 |
| REQ-KNO-001/002/003 | `tests/req-lock.test.ts`, `tests/req-ext-eval.test.ts` TDD-KNO-01 |
| REQ-KNO-004 | `tests/req-kno-theme-brief.test.ts` |
| REQ-GRF-001/002 | `tests/req-grf-graph.test.ts` |
| REQ-EVA-001 | `tests/req-lock.test.ts`, `tests/req-eva-gold.test.ts` TDD-EVA-03, `docs/sdlc/12-gold-set.md` |
| REQ-EVA-002–005 | `tests/req-ext-eval.test.ts` TDD-EVA-02 |
| REQ-EVA-006/007/008/010 | `tests/req-lock.test.ts` |
| REQ-EVA-009 | `tests/req-ext-eval.test.ts` TDD-EVA-01 |
| REQ-REG-001 | this matrix + test titles contain `REQ-` |
| REQ-OPS-001 | ingest re-runs sweep in `req-ext-eval.test.ts` |

## Should (not blocking v1)

| ID | Status |
| --- | --- |
| REQ-REG-003 | Unit + tsc on Origin CI. Playwright when browsers are on the image. |
| REQ-OPS-002 | Grokbot on PRs when the repo is connected. |

## Manual pass (agent / human)

Walk `/` → theme → source → Insights (Unassigned, Unknown) → Catalog → Graph → Ingest → Eval → Spec (Flow process, Flow technical). Confirm empty/error copy still exists (Unassigned empty, ingest no file, spec view-only). Do not Accept a catalog proposal unless you reset afterward.
