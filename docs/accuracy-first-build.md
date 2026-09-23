# Accuracy-first modular build (strangle path)

Branch: `cursor/accuracy-first-modular-b7b5`

## Decisions (Shashank, Sep 2026)

| Topic | Choice |
| --- | --- |
| Integration | **A — strangle**: new `src/accuracy/*` stack; legacy S0–S10 remains until parity |
| Visual reference | User uploads under `reference/`; final output = **interactive Gantt** |
| Coverage decisions | Schema-locked LLM (**no Jev** for now) |
| Tenancy | **Multi-tenant** (org → workspace; **one IEGP per workspace**) |
| Routing | **Per call kind + per agent role** (proposer / critic / reviser / judge) |
| Cost | **Live price table** + token estimates per LLM step; OAuth providers (no API-key billing API) |
| Extraction depth | Default **1 propose + 1 checklist critic + 1 revise**; hillclimb adds rounds |
| Gold | Per-source gold in `reference/<slug>/gold/` — never mix across sources |
| Module delivery | Independent modules + unit tests; combine via kernel registry |
| Parse | PDF/PPTX → **LlamaParse**; DOCX/text/etc → local (+ LLM assist in parse module when needed) |

## Code map

| Path | Role |
| --- | --- |
| `src/accuracy/kernel/` | Call-kind contracts, run loop, routing, cost, observability |
| `src/accuracy/store/` | Multi-tenant Postgres schema, parse store, claim store |
| `src/accuracy/modules/*/` | One folder per module (manifest + schema + run + tests) |
| `src/app/accuracy/` | New UI routes (v2 shell) |
| `reference/` | User reference uploads + per-source gold |

Architecture spec (Project store): `accuracy-first-architecture.md`.
