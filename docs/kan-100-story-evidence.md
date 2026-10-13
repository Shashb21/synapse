# KAN-100: all 40 parent stories, software and empirical evidence

This mapping covers the numbered stories in `docs/superpowers/specs/2026-10-13-kan100-extraction-benchmark-spec.md`. Paths below are relative to `src/accuracy/eval/benchmark/` and `tests/`. Every automated check uses synthetic inputs; passing it establishes implemented behavior, not live model performance. **No real scored run or final authenticated semantic/audit judgment exists. Parent empirical completion remains open.** Private local preparation lives at `data/runtime/benchmark/kan106-local-reference/` and must never be published.

| Story | Concrete implemented artifact / behavior check | Unfulfilled empirical evidence |
| --- | --- | --- |
| 1 Isolation | `preflight.ts`, `artifacts.ts`, CLI explicit inputs; `kan100-cli.test.ts`: rejects DB names before credential reads | Verify isolated operator process before live execution |
| 2 Human deployment decision | `report.ts` human adoption statement; `kan100-report.test.ts`: synthetic matrix distinct from empirical evidence; batch has no deployment interface | Human decision after experiment, no automatic switch |
| 3 Actual baseline | `extract.ts` snapshots, `batch.ts` baseline digest; `kan100-extract.test.ts`: honors snapshot/settings and labels substitution | Actual baseline export and responding-model verification pending |
| 4 Fixed low-cost Extract | `contracts.ts`, `preflight.ts`, `extract.ts`; `kan100-extract.test.ts`: verified lowest suitable fixed tier; wrong version blocked | Account/version 2.5/tier pilot pending |
| 5 Separate stages | `batch.ts` matrix, `report.ts` independent stage sections; report variation test and batch complete-matrix test | Live need/tactic evidence pending |
| 6 Complete decks | `inputs.ts`, `extract.ts`; inputs preserves complete blocks and extraction uploads >80 blocks | Images/charts/notes/order human review; Tislelizumab manifest 59 vs XML 91 unresolved |
| 7 Separate packs | `inputs.ts`, `preflight.ts`; inputs foreign pack rejection and preflight both-agreed-decks test | Approve independent gold for both real decks |
| 8 Frozen parsing | `inputs.ts` hashes/freeze; inputs detaches/freezes and content-change hashes; batch changed-source rejection | Authentic frozen complete input approval pending |
| 9 Block boundaries | `inputs.ts`, `extract.ts`, report source anchors; inputs identity test and extract citation mismatch cases | Human verifies original block/source attribution |
| 10 Reviewed versioned gold | `inputs.ts`, CLI gold import; inputs version-bound review and CLI exact digest approval tests | Actual reviewed atomic gold pending |
| 11 Semantic matches | `scoring.ts` explicit signed meanings; `kan100-scoring.test.ts`: no inference from IDs | Final human item matches pending |
| 12 Faithful paraphrases | `scoring.ts`; scoring explicit paraphrase-once test; report recovered example | Actual paraphrase adjudications pending |
| 13 Distinct needs | `scoring.ts`; broad special-populations test | Review distinct real populations/questions |
| 14 Specificity examples | `report.ts`; report source-linked specificity test; scoring older/renal broad-summary test | Actual concrete specificity failures not yet measured |
| 15 Duplicate credit | `scoring.ts`, report duplicate examples; scoring counts once | Human duplicate judgments on real outputs pending |
| 16 Valid additions | `scoring.ts`, report addition examples; scoring supported addition evidence test | Actual supported additions/ref corrections pending |
| 17 Fair reference correction | `batch.ts` retained history and whole-matrix rescore; batch authenticates corrected reference without paid reruns | Human authenticated correction evidence if needed |
| 18 Exact omissions | `report.ts` per-run statements/links and repeat misses; report examples/variation tests | Actual omission judgments pending |
| 19 Unsupported findings | `scoring.ts`, report unsupported examples; scoring separate additions/unsupported test | Real unsupported findings adjudication pending |
| 20 Literal quote support | `extract.ts`, `scoring.ts` original block quote validator; extract citation mismatch and scoring wrong-block tests | Real citations and disputed quotes pending |
| 21 Three independent metrics | `scoring.ts`, `report.ts` count/denominator tables; report happy test and scoring quote-independence test | Real content/citation/intersection scores pending |
| 22 Parsing losses | `inputs.ts`, `scoring.ts`, report loss reason/location; inputs denominator and report example tests | Confirm actual missing source content and loss classifications |
| 23 Final human judgments | `batch.ts` exact-content digest approvals; batch unauthenticated review test and CLI review import smoke | Every real semantic/audit approval pending |
| 24 Provisional labels | `report.ts`; report missing/provisional blocker test | No final actual scores yet |
| 25 Three repetitions | `batch.ts` 24-run matrix; batch matrix test and report exact missing-repeat/variation test | Full live 24-run execution pending |
| 26 Frozen settings | `batch.ts` execution/runtime digests; batch changed configuration rejection | Freeze actual prompts/settings/version before live calls |
| 27 Separate tuning | `batch.ts` rejects changed scored configuration and accounts tuning overhead; batch config rejection and setup/tuning reserve tests | Tuning comparison is not implemented as a separate analysis cohort; use separately labelled batch, preserve evidence and whole-budget accounting |
| 28 Audit separated | `audit.ts`, `batch.ts`, report audit sections; batch invalid audit/substitution never inflates recall | Live same-process audits pending |
| 29 Audit usefulness | `audit.ts` human genuine/missed/incorrect flags, report separate verdicts; report audit fixture and batch audit tests | Real flag adjudication pending |
| 30 Inspect raw evidence | `batch.ts`, `artifacts.ts` manifest/history/attempts; batch persisted complete matrix test | Actual raw responses/metadata/judgments absent |
| 31 JSON/CSV | `batch.ts` interim/final JSON plus four CSVs; batch complete artifacts and safe CSV test | Real export evidence absent |
| 32 Private exclusion | `artifacts.ts`, CLI verified exclusion/600 files/700 directories; batch ownership/exclusion and symlink tests | Recheck actual output exclusion before every retention/publication |
| 33 Provider authorization | `preflight.ts`, `extract.ts`; CLI missing authorization blocks before credentials | Documented BeOne provider-specific authorization absent |
| 34 Whole US$10 ceiling | `preflight.ts`, `batch.ts` reservations/ledger; preflight fractional excess and batch bound/unknown/overhead tests | Actual token sizing, dated prices and reconciled charges absent |
| 35 Timings | `extract.ts`, `batch.ts`, report extraction/audit/whole elapsed; batch persisted attempts test and report table test | Live timings absent; synthetic timings not performance evidence |
| 36 Failures/actual identity | `extract.ts`, batch attempts, report requested/responding identity; extract fallback/unverified tests and report failure test | Real account/protocol/response verification pending |
| 37 Bounded retry | `batch.ts` one shared temporary retry; batch retry/no-low-recall and shared audit retry tests | Real reliability measurements pending; no paid retries performed |
| 38 Incomplete preserved | `batch.ts`, CLI blocked artifacts, `report.ts`; CLI missing prerequisites and report exact blockers tests | Authorization/gold/matrix/review/protocol/budget blockers remain |
| 39 Advisory stage tradeoffs | `report.ts` observed stage recall/intersection/timing comparisons plus source examples; report stage variation and no threshold test | Actual stage conclusions/human adoption pending |
| 40 Reference-only scope | `report.ts` reference-deck scope; report completed-live-contract test uses synthetic fixture only | No unseen-document generalization evidence or claim |

Verify software with `npm run test:kan100`, `npm run typecheck:kan100`, scoped ESLint and the repository `npm run typecheck` (record baseline failures separately). The live contract test fabricates data to test reporting eligibility; it is not a real benchmark. Follow `docs/kan-100-benchmark-runbook.md` for private setup, authentic approval, readiness, execution and report inspection. Controller owns whole-branch review, PR/merge and publication; software merge does not complete the empirical parent.
