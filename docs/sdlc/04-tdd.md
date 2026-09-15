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
| TDD-EVA-03 | REQ-EVA-001 | Gold scenario pack (functions, surfaces, grounding) | `tests/req-eva-gold.test.ts`, inventory `docs/sdlc/12-gold-set.md` |
| TDD-ING-01 | REQ-ING-001/002/003 | PPTX/DOCX/XLSX → blocks | `tests/req-ing-parse.test.ts` |
| TDD-LOCK-01 | REQ-ING-005, EXT-003/005, CLU-001/006, KNO-001, EVA-001/006/007/008/010 | Remaining Must locks | `tests/req-lock.test.ts` |
| TDD-E2E-01 | REQ-KNO-004 / UX-001 | Monitor themes | `e2e/briefing.spec.ts` |
| TDD-E2E-02 | REQ-CLU-002 / UX-002 | Theme page linkage | same |
| TDD-E2E-03 | REQ-EVA-009 / UX-008 | View-only eval tape | same |
| TDD-E2E-04 | REQ-OPS-003 / UX-008 | View-only spec tape + flows | same |
| TDD-EVA-04 | REQ-UX-008 | Spec mermaid blocks parse on mermaid 12 | `tests/req-docs-mermaid.test.ts` |
| TDD-E2E-05 | REQ-CLU-005 / UX-003 | Insights tab + Unassigned | same |
| TDD-E2E-06 | REQ-GRF-001 / UX-005 | Graph revelations | same |
| TDD-E2E-07 | REQ-CLU-007 / UX-004 | Catalog emerge/split | same |
| TDD-E2E-08 | REQ-REG-002 / UX-001–008 | Complete user flow | `e2e/user-flow.spec.ts` |

## Commands

```bash
npm test          # vitest — must pass before merge
npm run test:e2e  # playwright against the dev server
npm run ci
```

Coverage matrix: [`11-regression.md`](./11-regression.md) (REQ-REG-004).

A failing eval composite vs the committed champion is a **regress** (REQ-EVA-010), not a flake. Do not “fix” it by loosening gold.
