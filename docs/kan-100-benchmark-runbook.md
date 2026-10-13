# KAN-100 isolated benchmark CLI

KAN-106 supplies explicit `prepare`, `run` and `review` commands around the restart-safe batch. Account verification, vendor-specific BeOne processing permission and the actual resolved baseline snapshot remain pending. Passing synthetic tests does not establish readiness for live scoring.

Use `benchmarkConfigSchema` and `BenchmarkConfig` from `src/accuracy/eval/benchmark/contracts.ts`; invoke `checkPreflight(config, envNames)` from `preflight.ts`. Pass environment names only. The returned `{ ready, blockers, estimatedTotalUsd }` contains no credentials. Validation failures return generic errors without echoing supplied values. No module loads `.env`, reads settings from a database, resolves a production route or calls a provider.

Prepare an isolated process without database credentials. Do not use normal Vitest setup for these checks: it attempts database writes. The tracked `vitest.kan100.config.ts` uses node, no setupFiles and only synthetic benchmark tests; it never supplies DATABASE_URL.

Before execution, obtain a controller-supplied snapshot of actual persisted settings and resolved runtime routes, including parameters and fallback state. `BaselineRouteSnapshot` reuses the existing Accuracy route contract; `baselineSnapshot` identifies the privately saved snapshot. Set each route's requested and actual model from verified setup, freeze settings/prompts/schema hashes, and retain the full snapshot alongside later batch artifacts. A failed requested model remains a failure; any fallback result belongs to a separately labelled configuration.

Verify Extract 2.5 support in the actual account, fixed schema and citations through a synthetic text pilot. Verify the lowest-cost tier that passes setup, and record dated conservative prices from current vendor documentation. Do not silently use latest. Each of baseline and Extract needs exactly one route for need extraction, tactic inventory and completeness audit. Vendor authorization evidence is required per route before processing any BeOne original or derived text. An account check is not document-processing permission.

For a nonsynthetic experiment, require exactly the two real packs `beone-bgb-58067-prmt5i` and `beone-tislelizumab-iegp`; one-deck, extra-pack and mixed real/synthetic plans do not constitute the agreed experiment. All-synthetic fixtures may use other pack identities and counts. Freeze each complete parsed source separately, preserving block identity and boundaries. Record pack ID, hash, block count and actual text-token size. Primary `blockCap` is null; inputs beyond 80 blocks are supported. Gold stays evaluator-only, reviewed and versioned. Missing gold text remains a parsing loss in the overall denominator. A separately capped comparison or original-file pilot must have a separate label; original-file work requires evidence that text input was unsuitable.

Store artifacts only in `data/runtime/benchmark/<batchId>` with a simple alphanumeric/hyphen/underscore batch ID. Before any source-derived save, verify the exact JSON, CSV and report paths with `git check-ignore --no-index`, ensure none is tracked, and establish private filesystem access. Record the check in `storage.exclusionEvidence`; the pure preflight trusts this caller-supplied attestation and does not run Git itself. Never write credentials into config, reports or artifacts.

Budget fields describe initial full-experiment readiness: `spentUsd` includes already incurred charges, `setupUsd`/`tuningUsd` are additional reserves, and `budget.calls` always covers the entire initial experiment, including all stages, decks, three repetitions and the permitted retry allowance per call. `sizeBasisHash` is the comma-joined source hashes in source order. Use actual text-token size and output bounds, not slide counts. Keep the ceiling at or below US$10. Unknown costs are null, pending costs set `pendingCost`, and either blocks readiness. Admission compares the unrounded total with the ceiling; `estimatedTotalUsd` is only a conservative display rounded upward to nine decimal places. Caller must verify pricing freshness and that per-call bounds cover actual provider billing, including output and audit inputs.

Run `checkPreflight` before starting the experiment with the full initial call plan. It cannot validate a resumed or depleted plan. The later batch executor must independently update incurred charges and remaining setup/tuning/call reserves, account for pending or unknown charges, and enforce the whole-experiment ceiling before every paid attempt (including retries). It must stop or mark incomplete when remaining budget cannot safely cover the next attempt and outstanding obligations. Passing initial preflight does not authorize subsequent calls without that per-attempt enforcement.

Retry only a temporary connection/service failure once within budget. Never retry a completed low-recall result. Preserve every attempt, raw output, citations, usage (unknown when unavailable), failure, actual model, elapsed extraction/audit/total timings and known charges. Run the same frozen audit after extraction scoring; warnings never count as recovery. Human judgments own matches, additions and disputed quotes. Report recall, citation validity and intersection separately, with duplicates, unsupported findings, additions, parsing losses and concrete omissions. Unreviewed metrics are provisional. Corrections require a new reference version and rescoring every configuration. There is no recall or speed adoption gate.

Batch execution persists source/reference/code identities, settings and prompts, run/attempt IDs, timestamps, raw outputs, judgments, metrics, costs and completion state as private JSON/CSV/readable report. It preserves artifacts and marks incomplete if authorization, review, citations, repetitions or budget prevents completion. Preflight does not certify completion or authorize deployment.

## Commands and private inputs

Use installed `tsx`; no new dependencies are needed. Run commands from the workspace root. Every JSON input must be explicitly selected, Git-excluded, inside this workspace, a regular file with mode 600, and reached without symlinks. Use separate mode-700 directories for editable batch artifacts and operator approvals/checkpoint. The CLI verifies actual Git exclusion rather than trusting config booleans. It never loads `.env`, resolves DB settings, or reads unselected credential values. Database environment **names** block every command before file/credential processing.

```sh
npm run test:kan100 -- tests/kan100-cli.test.ts
npm run test:kan100 -- tests/kan100-cli.test.ts -t 'synthetic smoke'
npm run typecheck:kan100

# Local preparation needs no credentials. These are example private paths.
env -i PATH="$PATH" npm run benchmark:kan100 -- prepare \
  --config data/runtime/benchmark/operator-inputs/config.json \
  --sources data/runtime/benchmark/operator-inputs/sources.json
```

Use the complete strict `BenchmarkConfig` schema in `contracts.ts`. Preparation accepts explicitly pending metadata; it cannot certify any real route or price. It saves the original config separately and writes `prepared-config.json` with measured hashes/block counts, `goldReviewed:false` and unknown inputTokens. No source text or confidential example belongs in a tracked template.

The private sources JSON shape is:

```json
{
  "parserVersion": "operator-supplied-parser-version",
  "frozenAt": "2026-10-13T12:00:00Z",
  "entries": [{
    "packId": "synthetic-example",
    "filename": "synthetic.txt",
    "sourceFile": "data/runtime/benchmark/operator-inputs/synthetic.txt",
    "legacyGold": {
      "needsFile": "data/runtime/benchmark/operator-inputs/legacy-needs.json",
      "tacticsFile": "data/runtime/benchmark/operator-inputs/legacy-tactics.json"
    }
  }]
}
```

Choose either `legacyGold` or `goldFile` per entry; `goldFile` follows `FreezeReferencePackInput['gold']`. Explicitly copy legacy JSON to verified private input storage with mode 600; originals in `reference/` remain untouched. Select actual PPTX paths using `reference/manifest.json`; do not combine packs. Preparation parses locally and keeps all blocks without an 80-block cap. `gold-candidates.json` retains every original legacy row, including narrative statements and source cues. Unlinked candidates remain unresolved: the CLI never invents semantic decomposition, parsing-loss classifications or approval. `packs.json` has pending gold; legacy candidates are separate from evaluator ground truth.

Preparation refuses to overwrite existing preparation/batch evidence. Use a new batch ID/directory for a new preparation. `prepare.json` includes block counts, parsed slide counts, XML slide counts and hashes without text. Local text parsing does not OCR images/charts, extract notes, certify atomic semantics or guarantee presentation relationship order; blank/image-only slides may have no blocks. All locally parsed text is retained, but semantic completeness needs human checking and explicit losses in gold.

## Importing human gold before a batch

A human creates a private gold JSON with `{frozenAt, gold:{packId:{needs,tactics,needsReview,tacticsReview}}}`. Items use `FrozenGoldItem`: statement, explicit block links, original reference details and confirmed parsing losses. Both approved stage reviews require reviewer/version/time; the CLI checks these using `freezeReferencePack`, verifies original file bytes, and reuses the already frozen blocks without parsing or provider extraction.

```sh
npm run benchmark:kan100 -- review \
  --config data/runtime/benchmark/example/prepared-config.json \
  --packs data/runtime/benchmark/example/packs.json \
  --sources data/runtime/benchmark/operator-inputs/sources.json \
  --gold data/runtime/benchmark/operator-inputs/human-gold.json \
  --approvals data/runtime/benchmark/operator-inputs/approved-digests.json
```

Start with an explicit empty approvals array. The first import stages `staged-gold-packs.json` and `gold-review-requests.json` and returns blocked. A human inspects the exact request contents and writes their SHA-256 digests to the separate operator file. Repeat the same command to save `approved-packs.json` and `approved-config.json`; original packs and prior gold remain preserved. Imported reviewer/signature strings never approve themselves. Local gold import refuses to change an existing batch; use authenticated reference correction below for saved runs.

## Running and resuming

Run only from an isolated process containing explicitly selected provider credentials and no DB environment names. The CLI loads those values only after readiness and gold-authenticity checks. Supply a private runtime JSON with these explicit fields:

- `baselines`: `need_extract` and `inventory_extract`, each `{snapshot,shallowCycle,baseUrl}`. Snapshot contains actual exported `call_kind`, `role:"proposer"`, `provider_id`, `model`, `params:{temperature,max_tokens}`, empty fallbacks, degraded false and reason. Headers are not accepted; credentials stay in selected environment values. `config.baselineSnapshot` is `artifactDigest(baselines)`.
- `auditBaseUrl` and `auditSettings:{temperature,max_tokens}`. Both audit routes must share provider/model/version/tier/settings, with the frozen audit process hash. Supported official endpoints: xAI `/v1`, OpenAI `/v1`, OpenRouter `/api/v1`, Anthropic origin, Gemini `/v1beta`. No proxy/default endpoint is chosen.
- `projectId`, `maxPolls` (1–100, lifetime limit), and `pricing:{asOf,source,baselineMaxUsd,extractJobMaxUsd,uploadMaxUsd,auditMaxUsd,inputUsdPerMillion,outputUsdPerMillion}`. Dated bounds must cover each operation, possible shallow revisions, all audit chunks, retries and setup/tuning. Bounds/rates are never invented or defaulted.
- Optional explicit `overheadCharges:{setupUsd,tuningUsd}` to reconcile known charges; null retains reserve. Optional `referenceCorrection:{rationale,reviewerId,reviewedAt}` for approved reference changes.

```sh
npm run benchmark:kan100 -- run \
  --config data/runtime/benchmark/operator-inputs/ready-config.json \
  --packs data/runtime/benchmark/example/approved-packs.json \
  --runtime data/runtime/benchmark/operator-inputs/resolved-runtime.json \
  --checkpoint data/runtime/benchmark/operator-inputs/trusted-checkpoint.json \
  --approvals data/runtime/benchmark/operator-inputs/approved-digests.json
```

The checkpoint file can be absent for a fresh batch, but its private parent must already exist. `onCheckpoint` atomically writes and fsyncs the trusted latest digest outside batch artifacts before each HTTP action. Subsequent `run` invocations resume existing jobs through the batch contract; never copy a digest from editable manifest JSON to bypass authentication. A stale exclusive `.lock` requires an operator to confirm the recorded process is dead before removing only that lock. Preserve checkpoints and potentially charged attempts.

Native live transport makes one HTTP attempt at a time; batch owns bounded polling/retry/pricing. Audit transport honors batch's timeout signal, saves provider-reported usage and actual responding model, and supplies all selected credentials for redaction. Unknown usage/cost stays unknown. Before any real paid call, verify official provider protocols/prices, actual account/version/citations and provider-specific document-processing permission, freeze the resolved baseline, obtain authentic reviewed gold and complete cost sizing. No such real run has been authorized or performed here.

## Reviewing saved runs and correcting references

`decisions.json` maps every run ID to `BatchHumanReview:{extraction:HumanJudgments,audit:AuditHumanRecords}`; use the exported scoring identity and saved findings. Import explicit item-level decisions, including omissions, matches/duplicates/additions/specificity and audit flags. No inferred signature authentication occurs.

```sh
npm run benchmark:kan100 -- review \
  --config data/runtime/benchmark/operator-inputs/ready-config.json \
  --packs data/runtime/benchmark/example/approved-packs.json \
  --runtime data/runtime/benchmark/operator-inputs/resolved-runtime.json \
  --checkpoint data/runtime/benchmark/operator-inputs/trusted-checkpoint.json \
  --approvals data/runtime/benchmark/operator-inputs/approved-digests.json \
  --decisions data/runtime/benchmark/operator-inputs/decisions.json
```

Saved-run review requires completed saved extraction/audits/billing and a verified trusted checkpoint. It does not load credentials and supplies throwing transports, so rescoring cannot trigger extraction, audit or billing polls. Incomplete execution must resume via `run`. `review-requests.json` stages exact contents for inspection; append separately human-approved digests to the operator allowlist and rerun review. Scores remain provisional until exact contents are approved. Review flags never add extraction recall.

A reference correction supplies a new reference version and approved packs, explicit correction evidence in runtime, and fresh judgments for every saved run. The batch stages an approval request binding prior and next full contents; after separate approval it preserves prior evidence and rescores the whole matrix. Execution settings/sources stay frozen. Correction requests are retained even when their approval initially blocks the command.

CLI returns sanitized JSON and exits 0 for successful local preparation or a fully reviewed completed batch, 2 for blocked/incomplete, and 1 for malformed input/I/O. An initial synthetic smoke intentionally returns incomplete review; the test authenticates synthetic decisions separately and checks no added calls. Preparation success is not experiment completion. Saved outputs include `manifest.json`, `interim.json`, JSON review requests, digest-named resolved runtime exports, CSV analysis tables, private interim report and `final.json` only when eligible. Failures preserve private `blocked.json` where verified storage is available.

## Current local evidence

Private `data/runtime/benchmark/kan106-local-reference/prepare.json` records the actual local PPTX preparation: PRMT5i 3,005 blocks / 57 XML and parsed slides; Tislelizumab 5,080 blocks / 91 XML and parsed slides. The manifest lists 59 Tislelizumab slides; this discrepancy requires inspection, not silent truncation. These are parser counts, not semantic ground-truth approval. Complete source text and original narrative candidates remain excluded private artifacts. No real HTTP extraction, account pilot or paid audit occurred; gold, actual baseline/settings, authorization, token sizing and current prices remain blocked.

## Readable final analysis: what, why, verification

`renderBenchmarkReport({result,packs,ceilingUsd,evidenceKind?,blockers?})` in `src/accuracy/eval/benchmark/report.ts` returns `{status,blockers,markdown}` without I/O or semantic inference. Batch and CLI save the readable analysis to the existing private `interim-report.md` after execution/review, including incomplete results. During interrupted execution the checkpoint report remains a short incomplete summary; `manifest.json` retains detailed attempts. No production endpoint, database or deployment is involved.

The report shows each deck/stage/configuration/repetition with explicit recall numerators, denominators and percentages, citation validity and the content/citation intersection. It retains parsing losses in overall gold recall, source-linked omissions, additional/duplicate/unsupported/specificity examples, human rationale, recurring misses and repeat ranges. Each stage's advisory comparison gives observed mean recall, citation intersection and extraction/audit time; it does not impose an adoption threshold. Original block IDs, locations, text and quotes stay in private storage. Audit verdicts and human flag judgments remain separate from extraction credit. Attempt failures, requested/responding identities, costs, reservations and timings remain inspectable alongside JSON/CSV.

Optional explicit runtime JSON fields `reportEvidenceKind:"live"|"synthetic"` and `reportBlockers:string[]` are frozen with runtime settings. Set synthetic for controlled responses; the CLI always forces synthetic when a test fetch is supplied. Omission of provenance means unverified empirical evidence. A live label is an operator attestation, not a substitute for source completeness, provider protocol checks, authorization, authenticated review or real paid outputs. Preserve exact external blockers (including the Tislelizumab 59-manifest/91-XML discrepancy) until a human resolves them. Batch JSON status describes software eligibility; report status additionally requires live provenance and absence of supplied empirical blockers. A synthetic completed JSON matrix therefore still yields an empirically incomplete report.

Verify with timeout-bounded synchronous commands, without `.env` loading or database test setup:

```sh
/private/tmp/kan96-timeout 120s npm run test:kan100 -- tests/kan100-report.test.ts
/private/tmp/kan96-timeout 300s npm run test:kan100
/private/tmp/kan96-timeout 120s npm run typecheck:kan100
/private/tmp/kan96-timeout 120s npm run typecheck
/private/tmp/kan96-timeout 120s node_modules/.bin/eslint src/accuracy/eval/benchmark/report.ts tests/kan100-report.test.ts
```

The timeout utility is a local harness path, not a repository dependency; use an available equivalent that terminates the process group on other hosts. Inspect private `interim-report.md` against `runs.csv`, `findings.csv`, `attempts.csv`, `jobs.csv`, `interim.json` and the authoritative manifest. Check all 24 run identities, three repeats per deck/stage/configuration, source/reference/settings hashes and actual responses, final authenticated extraction/audit judgments, and whole-experiment billing including setup/tuning/retry reservations. Run `git check-ignore --quiet -- <artifact-path>` before retaining source-derived artifacts. Never copy their contents into tracked documentation.

Actual setup remains pending: approve atomic versioned gold and all source links/losses; inspect original slides/images/notes and resolve the 59/91 slide discrepancy without changing the manifest silently; export actual baseline settings; document provider-specific processing authorization; verify real account/version/tier/citation protocols; measure input tokens and validate dated prices within US$10; execute the full live two-pack matrix; authenticate every final semantic/audit judgment and reconcile all billing. Local preparation and passing synthetic tests fulfill software verification only. KAN-100 remains empirically incomplete and human adoption remains undecided. See [all 40 story evidence mappings](kan-100-story-evidence.md).
