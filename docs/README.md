# Documentation

Start here:

1. **[Problem statement and proposed solution](problem-and-solution.md)** — why IEGP, what Synapse refuses, what v1 ships.
2. **[IEGP model](iegp-model.md)** — locked objects, gates, priority on the matrix, timeline, refresh.
3. **[Modules](modules.md)** — kernel, stages S0–S10 and their module ids, cross-cutting concerns.

The pack under [`sdlc/`](sdlc/) holds the live [requirements (v2)](sdlc/01-requirements.md) and their [compliance check](sdlc/requirements-compliance.md), [architecture](sdlc/02-architecture.md), [process](sdlc/05-process.md), the [business](sdlc/09-flow-high-level.md) and [technical](sdlc/10-flow-technical.md) flows, and **[testing](sdlc/13-testing.md)** (Vitest, Playwright, the LLM stub, CI, gold). Pages there marked *Retired* describe the earlier insights engine (CIR / themes) and are kept for lineage only.

- **[Deploy checklist](deploy-checklist.md)** — Vercel + Postgres operator list (env, smoke, workspace hygiene)
- **[Deploy on Vercel](deployment-vercel.md)** — project, Postgres, provider keys, SSO redirect
- **[Consultant UX spec](consultant-ux-spec.md)** — nav IA, readiness strip, Gaps workbench, Prep \| Room, phased delivery
- **[Presentation view and breakout groups](presentation-and-breakouts.md)** — Room presenter view over the real pages, multi-window breakout facilitation (both switched off in the app for now)
