# TDD plan

Cycle: **review spec → accept → write failing/lock test → implement → pass**. Tests are named with the requirement ID they lock (REQ-REG-001).

## Accepted tests

| Test ID | REQ | Spec | Location |
| --- | --- | --- | --- |
| TDD-CLU-01 | REQ-CLU-002 | Aetna formulary + RWE links Access **and** Evidence | `tests/req-clu-themes.test.ts` |
| TDD-CLU-02 | REQ-CLU-003 | Two themes, one CIR row | same |
| TDD-CLU-03 | REQ-CLU-004 | NX-441 does not land in Access | same |
| TDD-CLU-04 | REQ-CLU-005 | Unmatched → residual | same |
| TDD-CLU-05 | REQ-CLU-007/008 | Emerge and split proposals | `tests/req-clu-catalog.test.ts` |
| TDD-GRF-01 | REQ-GRF-001/002 | Blends and revealed bridges | `tests/req-grf-graph.test.ts` |
| TDD-EXT-01 | REQ-EXT-001 | Atomic split of double-barreled bullet | `tests/req-ext-eval.test.ts` |
| TDD-KNO-01 | REQ-KNO-002/003 | Unknown vs opportunity cues | same |
| TDD-EXT-02 | REQ-EXT-004 | CIR schema parse | same |
| TDD-EVA-01 | REQ-EVA-009 | Champion beats v1.0-baseline | same |
| TDD-EVA-02 | REQ-EVA-002–005 | Metrics expose partial/wrong/missed/new | same |
| TDD-ING-01 | REQ-ING-001/002/003 | PPTX/DOCX/XLSX → blocks | `tests/req-ing-parse.test.ts` |
| TDD-E2E-01 | REQ-KNO-004 | Briefing three panes | `e2e/briefing.spec.ts` |
| TDD-E2E-02 | REQ-CLU-002 | Theme page linkage | same |
| TDD-E2E-03 | REQ-EVA-009 | View-only eval tape (automatic hill-climb) | same |
| TDD-E2E-04 | REQ-OPS-003 | View-only spec tape | same |
| TDD-E2E-05 | REQ-CLU-005 | Insights tab + Unassigned | same |
| TDD-E2E-06 | REQ-GRF-001 | Graph revelations | same |

## Commands

```bash
npm test          # vitest — must pass before merge
npm run test:e2e  # playwright against the dev server
npm run ci
```

A failing eval composite vs the committed champion is a **regress** (REQ-EVA-010), not a flake. Do not “fix” it by loosening gold.
