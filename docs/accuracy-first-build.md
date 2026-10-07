# Accuracy-first modular build (strangle path)

Branch: `cursor/accuracy-first-modular-b7b5`

## Decisions (Shashank, Sep 2026)

| Topic | Choice |
| --- | --- |
| Integration | **A — strangle**: new `src/accuracy/*` stack; legacy S0–S10 remains until parity |
| Visual reference | User uploads under `reference/`; final output = **interactive Gantt** |
| Coverage decisions | **Schema-locked LLMs** (server API keys) (no TypeSafe Jev) |
| Tenancy | **Multi-tenant** (org → workspace; **one IEGP per workspace**) |
| Routing | **Per call kind + per agent role** (proposer / critic / reviser / judge) |
| Cost | **Live price table** + token estimates per LLM step; provider calls return no billing |
| Extraction depth | Default **1 propose + 1 checklist critic + 1 revise**; hillclimb adds rounds |
| Gold | Per-source gold in `reference/<slug>/gold/` — never mix across sources |
| Module delivery | Independent modules + unit tests; combine via kernel registry |
| Parse | Originally PDF/PPTX → LlamaParse. **Now:** text is extracted locally for every file type and the routed LLM decides blocks, kinds and headings; LlamaParse is disabled (`src/accuracy/modules/parse/parse-policy.ts`) |

## Code map

| Path | Role |
| --- | --- |
| `src/accuracy/kernel/` | Call-kind contracts, run loop, routing, cost, observability |
| `src/accuracy/store/` | Multi-tenant Postgres schema, parse store, claim store |
| `src/accuracy/modules/*/` | One folder per module (manifest + schema + run + tests) |
| `src/app/accuracy/` | New UI routes (v2 shell) |
| `reference/` | User reference uploads + per-source gold |

Architecture spec (Project store): `accuracy-first-architecture.md`.
