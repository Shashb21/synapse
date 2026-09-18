# Synapse IEGP

Digital **Integrated Evidence Generation Plan** for a pharmaceutical asset. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not overwrite the parent, human locks at every gate, evals against gold.

This is not a study tracker or a gap spreadsheet. It connects:

objectives → candidate evidence needs → extracted gaps + tactics → **one Review step** with inner tabs (**Gaps** / **Tactics**) → living plan (sidebar: Upload, Review, Mappings, Library, Plan).

Demo asset is fictional **Velmara / velmaratinib** (2L EGFR-mutant NSCLC). The app starts as a **blank workspace**. First visit is the **Upload** pane on `/`. After you enter the plan, new ingest stays on Upload and drops into Review. Demo files live in `public/demo-sources/`.

**Read first:** [`docs/problem-and-solution.md`](docs/problem-and-solution.md) and [`docs/iegp-model.md`](docs/iegp-model.md).

## Why this is not clustering or a tracker

- A stakeholder quote is a **candidate need**, not a validated gap.
- A tactic (or a publication) existing is not coverage. Coverage is ten dimensions plus an overall degree, human-locked.
- One registry can map to sequencing, HCRU and QoL without copying the protocol onto three cards.
- When coverage is partial, leftover is **suggested as a new Open gap**; the original gap stays (atomic records) and the covered portion can be locked **Addressed** by a human.
- Coverage ≠ priority. An 80%-covered HTA residual can still be Critical.

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

The first visit is **Upload** on `/`. Ingest a demo file. Review is one validation step with inner tabs: **Gaps** (candidates, residual evidence needs, Create gap) and **Tactics** (candidates, Create tactic). Then map or assign tactics, classify Open / Partially Addressed / Addressed, and enter the plan. Reset returns the blank slate.

Gap status after mapping (not the Plan High / Medium / Low bands):

- **Open** — complete white space: no completed, ongoing, or planned tactics AND no published literature addressing this gap. Proposed tactics do not count as addressing.
- **Partially Addressed** — some evidence (completed / ongoing / planned tactics and/or published literature) that supports but does not fully close the gap. The remainder is a residual evidence need that can split into a new Open gap; the covered part becomes Addressed.
- **Addressed** — published literature and/or completed, ongoing, or planned tactics fully close the gap. Humans lock this; the engine never writes it.

| Route | What |
| --- | --- |
| `/` | Sidebar places: Upload, Review (`?tab=gaps\|tactics`), Mappings, Library, Plan (H/M/L priority bands + Addressed status). Query `?place=` |
| `/evals` | View-only gold tape (needs + coverage; engine cannot auto-close) |
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

## Documentation

| Doc | What |
| --- | --- |
| [problem-and-solution.md](docs/problem-and-solution.md) | Problem statement and proposed IEGP |
| [iegp-model.md](docs/iegp-model.md) | Locked objects, gates, priority, refresh |
| [docs/sdlc/](docs/sdlc/) | Historical CIR/theme SDLC (lineage, not live SoR) |
