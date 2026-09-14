# SDLC process — Origin, Cloud Agent, Grokbot

## Loop

1. **Requirements** (`01-requirements.md`) get IDs. No silent scope.
2. **Architecture / design** cite those IDs.
3. **TDD** (`04-tdd.md`) accepts tests before code. PR description lists REQ IDs touched.
4. **Implement** on the working branch. Keep CIR and `theme_links` the contract.
5. **Eval sweep** — automatic on seed load and every ingest (`runEvalSweep`). EVAL and SPEC are view-only tapes. Champion may move only through the safety gate.
6. **Regression** `npm test && npm run test:e2e`.
7. **Review** — Grokbot / Bugbot on the PR; humans accept gold expansions (new insights).
8. **Ship**.

## Origin

Origin is the source-of-truth git host and PR surface.

- Open PRs against `main` with REQ IDs in the title or body (`REQ-CLU-002`, …).
- CI (`.github/workflows/ci.yml`) runs unit tests on every push; e2e when browsers are available.
- `origin pr checks` is the merge gate. An empty check list locally still means: run `npm test` before you merge.

Use Origin when: opening/updating PRs, reading review threads, confirming CI.

## Cloud Agent

Cloud Agent is the right worker for **ingest/parser work and gold/prompt patches**, not for rewriting the theme catalog by vibe. Hill-climb runs in-process; do not add a Run button back to EVAL.

Suggested Cloud Agent jobs:

- After a prompt patch, ingest or reset so `runEvalSweep` lands on the tape; commit only if champion composite rises and REQ-EVA-010 holds.
- Add a gold insight when critique `kind=new` is human-accepted.
- Extend local parsers (a new OOXML quirk), with `tests/req-ing-parse.test.ts` updated first.

Do not let an agent invent theme names. Residuals **propose**; humans **name** on `/catalog`. Splits append a child; they do not delete the parent.

## Application flow

This file is the **engineering** loop. The product loop (ingest → CIR → catalog → graph → brief) is drawn in:

- [09-flow-high-level.md](./09-flow-high-level.md) — what a brand team sees
- [10-flow-technical.md](./10-flow-technical.md) — modules, APIs, and `EngineState`

## Grokbot (Bugbot-style review)

On every PR that touches `src/lib/extract`, `src/lib/eval`, `src/lib/cluster`, or gold:

- Fail review if a new extractor path has no REQ-ID test.
- Fail review if `theme_links` is bypassed (copying `statement` onto a theme, or assigning a single `theme_id` again).
- Flag gold edits that drop `must_find` without a judge rationale.
- Flag LlamaParse-only logic with no local fallback (REQ-ING-004).

## Local vs hosted LLM

v1 ships a deterministic proposer/critique/judge so the product works without keys. When `OPENAI_API_KEY`, `XAI_API_KEY`, or `ANTHROPIC_API_KEY` is later wired, the **same JSON contracts and gold set** score the LLM path. Do not fork the CIR schema per vendor.
