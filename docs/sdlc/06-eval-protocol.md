# Eval protocol

Hill-climb (`runEvalSweep`) runs automatically when the engine seeds and after every document ingest. `/evals` and `/sdlc` are view-only.

## Failure modes (critique)

| Kind | Meaning | Cost |
| --- | --- | --- |
| wrong | Ungrounded, inverted, or fabricated | Highest — never brief |
| missed | Gold / source claim with no extracted counterpart | High — silent gap |
| partial | Double-barreled, generic, missing the operative noun | Medium — unusable in a VP briefing |
| new | Grounded extracted claim not in gold | Bonus if quote is real; queue for gold review |

## Metrics

- Precision uses full credit for exact pairs and half credit for partials.
- Recall is computed on `must_find` gold only.
- Composite = `0.34 F1 + 0.22 (1 − wrong) + 0.20 (1 − missed) + 0.14 (1 − partial) + 0.10 min(new, 0.25)`.

## Judge safety gate (REQ-EVA-010)

Promote only if:

1. Δ wrong-rate ≤ +0.05 vs champion
2. Δ composite ≥ +0.01
3. must-find recall does not drop more than 0.02

Otherwise **hold** or **regress**. Wrong is more expensive than missed.

## Hill-climb ladder

`v1.0-baseline` (bullets only) → `v1.1-atomic` → `v1.2-gap-sensitive` → `v1.3-cross-functional`.

The improver (proposer) maps high missed-rate to prose/table extraction, high partial-rate to atomic split, high wrong-rate to a grounding threshold.

## Gold hygiene

- One gold row = one atomic claim.
- `theme_ids[0]` is the primary decision object; additional IDs encode true multi-label membership.
- Grounded `new` findings become gold only after a human accept. Do not silently enlarge gold during a hill-climb run.
- Expanding gold is allowed when a human asks for coverage; every new row must ground in a seed block (≥ 0.28 similarity) and keep `must_find` honest.

Seed gold (`GOLD_INSIGHTS`) is a scenario pack, not a completeness proof:

| Family | What it stresses |
| --- | --- |
| Functions | All seven stakeholder functions, including HEOR tables and Regulatory prose |
| Classes | known / unknown / opportunity, including negation, conditionals, and “whether” gaps |
| Surfaces | bullets, paragraphs, cells, `table_cell`, chart, figure |
| Membership | multi-theme CIR, Unassigned/REMS residual, nice-to-have (`must_find: false`) |
| Cross-doc | same fact restated (WAC, ICER, IRA, REMS); tension (PDUFA date vs clock pause) |
| Hard extract | mashed “and both” / “and we”, small-n subgroups, named resistance, 340B/copay law |

Recall is scored on `must_find` only. Footnotes, single-KOL staffing, PREA paperwork, and China CTA sit in gold so critique can still label them missed — they do not fail the champion on their own.
