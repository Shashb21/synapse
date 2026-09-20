# Synapse IEGP

Digital **Integrated Evidence Generation Plan** for a pharmaceutical asset. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not overwrite the parent, human locks at every gate, evals against gold.

This is not a study tracker or a gap spreadsheet. It connects:

objectives → extracted gaps + tactics already mapped → **Gaps** (engine status, human validation, split/rewrite) → **Prioritize** → **Tactics** for open gaps.

Demo asset is fictional **Velmara / velmaratinib** (2L EGFR-mutant NSCLC). The app starts as a **blank workspace**. First visit is the **Upload** pane on `/`. After you enter Prioritize, new ingest stays on Upload and lands on **Gaps**. Demo files live in `public/demo-sources/`.

**Read first:** [`docs/problem-and-solution.md`](docs/problem-and-solution.md) and [`docs/iegp-model.md`](docs/iegp-model.md).

## Why this is not clustering or a tracker

- A stakeholder quote is a **candidate need**, not a validated gap.
- A tactic (or a publication) existing is not coverage. Coverage is ten dimensions plus an overall degree, human-locked.
- One registry can map to sequencing, HCRU and QoL without copying the protocol onto three cards.
- When coverage is partial, the engine shows **Partially Addressed**. That status cannot stay: split into an Addressed slice (with chosen mapped tactics) and an Open leftover, or rewrite the original. The original is retired into version history so children can trace it.
- Coverage ≠ priority. An 80%-covered HTA leftover can still be High.

## Run locally

Postgres is required.

```bash
docker compose up -d postgres
# or: local Postgres with user/password/db `synapse`
cp .env.example .env.local   # set DATABASE_URL
npm install
npm test
npm run dev
```

App: [http://127.0.0.1:43217](http://127.0.0.1:43217)

The first visit is **Upload** on `/`. Ingest a demo file. **Gaps** shows every mapped gap with computed Open / Partially Addressed / Addressed. Every gap lists the source(s) it was identified from under **View constituent needs** — if several documents raised the same gap, each source is listed. There is no accept/reject inbox. Partial must be split or rewritten. Then **Prioritize**, then **Tactics** for open gaps.

Gap status after mapping (not the Plan High / Medium / Low bands):

- **Open** — complete white space: no completed, ongoing, or planned tactics AND no published literature addressing this gap. Proposed tactics do not count as addressing.
- **Partially Addressed** — some evidence (completed / ongoing / planned tactics and/or published literature) that supports but does not fully close the gap. Click Partial to split (LEFT = Addressed + tactic, RIGHT = Open leftover) or rewrite the original as Open or Addressed. Partial cannot stay.
- **Addressed** — published literature and/or completed, ongoing, or planned tactics fully close the gap. The engine computes this when evidence is sufficient. A human override of Open or Addressed requires a reason and wins until cleared or marked stale on ingest/coverage refresh.

| Route | What |
| --- | --- |
| `/` | Sidebar places: Upload → Gaps → Prioritize → Tactics. Query `?place=` |
| `/evals` | View-only gold tape (needs + coverage; engine computes Addressed when evidence closes) |
| `/sdlc` | Spec tape |

No login. Locks record a typed name and function.

## Sharing (Origin + GitHub)

| Remote | URL | Role |
| --- | --- | --- |
| GitHub | [github.com/Shashb21/synapse](https://github.com/Shashb21/synapse) | Public share, CI |
| Origin | [cursor.com/codebase/shashank-code/synapse](https://cursor.com/codebase/shashank-code/synapse) | Cursor codebase |

```bash
./scripts/push-both.sh
```

## Tests

```bash
npm test          # engine, seed invariants, postgres store
npm run test:e2e  # Playwright against port 43217
```

Gap extraction (proposer / critic / judge) lives at `/extract-runs` and `POST /api/extract/gaps`. It consumes already-parsed markdown or JSON (JSON blocks preferred). Ready-made JSON test docs are in `public/demo-sources/json/` (`manifest.json` lists them). Dry-run is the default. Human wording edits and Exclude on Gaps feed gold and hill-climb the prompts. Live extract requires `ANTHROPIC_API_KEY`.

## Documentation

| Doc | What |
| --- | --- |
| [problem-and-solution.md](docs/problem-and-solution.md) | Problem statement and proposed IEGP |
| [iegp-model.md](docs/iegp-model.md) | Locked objects, gates, priority, refresh |
| [docs/sdlc/](docs/sdlc/) | Historical CIR/theme SDLC (lineage, not live SoR) |
