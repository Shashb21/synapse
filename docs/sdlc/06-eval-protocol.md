# Eval protocol

This is the full write-up of how extraction is scored, how misses / partials / wrongs are caught, how the champion moves, and how good the prompt actually is. The gold **inventory** (every `GOLD-xxx` row) is [12-gold-set.md](./12-gold-set.md). Live numbers are the `/evals` tape after seed or ingest. This file is the contract; the tape is the latest run.

Hill-climb (`runEvalSweep` in `src/lib/pipeline.ts`) runs automatically when the engine seeds and after every document ingest. `/evals` and `/sdlc` are view-only. There is no Run button (REQ-UX-008, REQ-OPS-001).

## What evals guarantee (and what they do not)

Evals **measure** extract quality against a versioned gold set and **block promotion** when quality gets worse. They do not prove that a new brand deck will extract cleanly.

| We do | We do not |
| --- | --- |
| Pair every extract to gold or mark it new/wrong | Guarantee zero misses in the wild |
| Score recall on `must_find` gold | Treat nice-to-have footnotes as launch blockers |
| Refuse a champion that hallucinates more | Score the live Claude prompt on this ladder |
| Keep a tape so a regress is visible | Replace a human gold review for `new` findings |

Wrong is more expensive than missed. Missed is more expensive than partial. Grounded `new` is a bonus, then capped, so a firehose of extras cannot win.

## Three-model loop

```
seed / ingest
    └─ runEvalSweep(documents)
         for each prompt version v1.0 → v1.3
           proposer  → CIR[]          (local strategy for that version)
           critique  → pairs + missed (partial / wrong / missed / new)
           metrics   → P, R, F1, rates, composite
           judge     → promote | hold | regress  (vs current champion)
           improver  → next version + prompt_patch (diagnostic, not auto-applied)
         pickChampion (highest composite, then lowest wrong-rate)
```

| Role | Code | Job |
| --- | --- | --- |
| Proposer | `src/lib/extract/proposer.ts` | Extract CIR. Local strategies implement the prompt versions. |
| Critique | `src/lib/eval/critique.ts` | Pair extract ↔ gold; label defects. |
| Judge | `src/lib/eval/judge.ts` `judgeCandidate` | Safety gate + composite delta. |
| Improver | `src/lib/eval/judge.ts` `proposeImprovement` | Read rates; recommend the next constraint pack. |
| Live Claude | `src/lib/extract/claude-proposer.ts` | Production extract when `ANTHROPIC_API_KEY` is set. **Not on the ladder.** |

The LLM prompts in `src/lib/extract/prompts.ts` are the **spec** the local strategies approximate. Eval scores the strategies, not Claude. Improving Claude does not move the champion until there is an eval path that extracts with Claude and scores the same gold.

## Pairing (critique)

Lexical, not an LLM-as-judge. `statementSimilarity` = `0.55 · Jaccard(tokens) + 0.45 · Jaccard(keyphrases)` (`src/lib/text.ts`).

Each extracted CIR is greedily assigned to the unused gold row with the highest similarity:

| Pair | Threshold | Kind |
| --- | --- | --- |
| similarity ≥ **0.58** | exact | counts as a full true positive |
| similarity ≥ **0.32** | partial | half credit; usually mashed or missing an entity |
| else, grounded in any source block ≥ **0.28** | new | real claim, not in gold yet |
| else | wrong | ungrounded / fabricated |
| gold with no pair | missed | silent gap |

One extract cannot claim two gold rows. That is why two gold statements must not be lexical aliases of each other (`tests/req-eva-gold.test.ts`).

Classification (known / unknown / opportunity) is **not** scored. Theme membership is **not** scored. Evals score **statement recovery**.

## Metrics

```
precision = (exact + 0.5 · partial) / extracted_count
recall    = must_find_paired / must_find_count     // nice-to-have misses do not tank R
F1        = harmonic mean of P and R

composite = 0.34·F1
          + 0.22·(1 − wrong_rate)
          + 0.20·(1 − missed_rate)     // missed_rate uses all gold, not only must_find
          + 0.14·(1 − partial_rate)
          + 0.10·min(new_rate, 0.25)
```

`wrong_rate` / `partial_rate` / `new_rate` are fractions of **extracted**. `missed_rate` is missed / **all gold**.

## Judge safety gate (REQ-EVA-010)

Promote only if **all** hold versus the current champion:

1. Δ wrong-rate ≤ **+0.05**
2. Δ composite ≥ **+0.01**
3. must-find recall does not drop more than **0.02**

Otherwise **hold** or **regress**. A later version that finds more stuff by inventing entities cannot become champion.

`pickChampion` after the sweep: highest composite, tie-break lowest wrong-rate. That is why v1.3 can **tie** v1.2 and still lose — the earlier champion is kept when composite does not rise.

## Hill-climb ladder

Each version is a **constraint pack** on the same CIR contract, not a rewrite of the product.

| Version | Strategy | Surfaces | Extra rules | Typical failure it exists to fix |
| --- | --- | --- | --- | --- |
| v1.0-baseline | `bullet-only` | bullets | no split | — (lossy start) |
| v1.1-atomic | `claim-split` | bullets | split on `.` / `;` / `and both` / `and we` | partial mashed claims |
| v1.2-gap-sensitive | `gap-scan` | bullets, paragraphs, cells, tables, charts, figures | gap headings → unknown | missed prose / tables / “what we don’t know” |
| v1.3-cross-functional | `full` | same as v1.2 | heading carry on short CNS bullets; near-dup drop | residual short bullets without heading |

On the current Velmara gold, v1.2 and v1.3 **tie**. Champion is **v1.2-gap-sensitive**. v1.3 is held (no composite lift). Design still calls v1.3 the *intended* full pipeline; the tape is the authority.

## How it gets better

After each run the improver reads the rates (`proposeImprovement`):

| Signal | Threshold | Patch |
| --- | --- | --- |
| high **wrong** | wrong_rate > 0.08 | require evidence quotes; drop ungrounded entities |
| high **partial** | partial_rate > 0.12 | split harder (`and both`, semicolons, independent clauses) |
| high **missed** | missed_rate > 0.18 | scan prose, tables, Open questions / Unknowns / Gaps |
| high **new** | new_rate > 0.10 | gold review — **do not suppress** |

The next version only ships if the judge promotes it. That is the only automatic “it got better.” Human work that actually moves the needle:

1. Expand gold when a `new` finding is real ([12-gold-set.md](./12-gold-set.md) hygiene).
2. Split a source bullet the extractor still mashes (the GOLD-018 case).
3. Put Claude on the same ladder (new eval path, same gold, same gate).
4. Fix `atomize` traps (`Dr. Hale` splits on the period — GOLD-070).

Do **not** loosen gold to green the tape (REQ-EVA-010). A failing composite vs the committed champion is a regress.

## How good is the extraction prompt

`PROPOSER_SYSTEM_PROMPT` (`src/lib/extract/prompts.ts`) is a strong **contract**: atomic CIR, verbatim quote, no hallucination, typed classification, heading carry, skip boilerplate. Critique / judge / improver prompts match the metrics above.

Caveats, in order of importance:

1. **Eval does not score that prompt.** The ladder scores local strategies. Claude (`v1.4-claude`) is live extract only.
2. Pairing is **lexical**. A good paraphrase of the same claim can look like miss or new.
3. Gold is **this demo**. High seed scores do not prove a new brand deck.
4. Claude JSON parse failure falls back to local extract (`claude-parse-failed`).
5. Two `must_find` rows are still missed on champion (see gold doc). The prompt is not “done.”

On Velmara gold after the 90-row expansion (re-read `/evals` for the live tape): champion composite ~**0.888**, P ~**0.99**, must-find R ~**0.975**, wrong **0**, partial **0**, missed **3** (two must-find + one nice-to-have). Precise on this corpus; not complete in the wild.

## Seed snapshot (re-check the tape)

| Version | Composite | F1 | P | R | Partial | Wrong | Missed | New | Extracted | Judge |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1.0-baseline | 0.585 | 0.500 | 0.966 | 0.338 | 2 | 0 | 61 | 0 | 29 | hold |
| v1.1-atomic | 0.617 | 0.545 | 1.000 | 0.375 | 0 | 0 | 58 | 0 | 32 | promote |
| v1.2-gap-sensitive | **0.888** | **0.982** | **0.989** | **0.975** | **0** | **0** | **3** | 1 | 88 | promote |
| v1.3-cross-functional | 0.888 | 0.982 | 0.989 | 0.975 | 0 | 0 | 3 | 1 | 88 | hold |

Gold count **90** (`must_find` **80**). If the UI shows 41, the persisted engine state is stale — reset the seed corpus on Ingest (or `POST /api/reset`).

## Code map

| Concern | File |
| --- | --- |
| Gold + seed docs | `src/lib/seed/corpus.ts` `GOLD_INSIGHTS`, `SEED_DOCUMENTS` |
| Pairing + metrics | `src/lib/eval/critique.ts` |
| Judge + improver | `src/lib/eval/judge.ts` |
| Local extract | `src/lib/extract/proposer.ts` |
| Prompts | `src/lib/extract/prompts.ts` |
| Sweep | `src/lib/pipeline.ts` `runEvalSweep` |
| Tests | `tests/req-ext-eval.test.ts`, `tests/req-eva-gold.test.ts`, `tests/req-lock.test.ts` |

## Gold hygiene

Full rules and the row-by-row inventory: [12-gold-set.md](./12-gold-set.md).

- One gold row = one atomic claim.
- `theme_ids[0]` is the primary decision object; extra IDs are true multi-label membership.
- Grounded `new` findings become gold only after a human accept. The sweep must not silently enlarge gold.
- Expanding gold is allowed when a human asks; every new row must ground in its own source document (≥ 0.28) and keep `must_find` honest.
