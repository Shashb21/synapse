# Synapse IEGP

Digital **Integrated Evidence Generation Plan** for a pharmaceutical asset. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not overwrite the parent, human locks at every gate, evals against gold.

This is not a study tracker or a gap spreadsheet. It connects:

objectives → candidate evidence needs → extracted gaps + tactics → residual drafts → human accept/reject/modify → human priority → create/assign tactics → dimensional coverage → forward roadmap → stale-and-re-lock monitoring.

Demo asset is fictional **Velmara / velmaratinib** (2L EGFR-mutant NSCLC).

**Read first:** [`docs/problem-and-solution.md`](docs/problem-and-solution.md) and [`docs/iegp-model.md`](docs/iegp-model.md).

## Why this is not clustering or a tracker

- A stakeholder quote is a **candidate need**, not a validated gap.
- A tactic (or a publication) existing is not coverage. Coverage is ten dimensions plus an overall degree, human-locked.
- One registry can map to sequencing, HCRU and QoL without copying the protocol onto three cards.
- When coverage is partial, a **residual** is drafted; the original gap stays.
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

| Route | What |
| --- | --- |
| `/` | IEGP: review extracted gaps, human priority, High / Medium / Low, addressed with tactics |
| `/needs` | Candidate / accepted / rejected evidence needs |
| `/gaps` | Gap inventory |
| `/gaps/[id]` | Needs, dimensional tactic mappings, residual, status lock |
| `/tactics` | Tactic objects + human-authored proposal |
| `/residuals` | Residual statements and locked priority bands |
| `/roadmap` | Ongoing / planned / proposed only |
| `/sources` | Interviews, TLR, internal materials; ingest marks coverage stale |
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
