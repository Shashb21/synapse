# Synapse IEGP

Digital **Integrated Evidence Generation Plan** for a pharmaceutical asset. Synapse principles still apply: atomic records, joins instead of copies, residuals that do not overwrite the parent, human locks at every gate, evals against gold.

This is not a study tracker or a gap spreadsheet. It connects:

objectives → extracted gaps + tactics already mapped → **Gaps** (engine status, human validation, split/rewrite) → **Prioritize** → **Tactics** for open gaps → **Timeline**.

Every new workspace starts **blank**: no asset, sources, gaps or tactics, and the setup wizard asks for the plan's context. Choose **Start with demo data (Velmara)** when creating a workspace to get the fictional **Velmara / velmaratinib** (2L EGFR-mutant NSCLC) worked example instead: sources, gaps, tactics, validated bands and a dated timeline, marked with a **Demo** badge. A workspace owner can later **Load demo data** or **Reset to blank** from the workspace settings page (both replace everything in that workspace). Demo files live in `public/demo-sources/`.

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

App: [http://127.0.0.1:43217](http://127.0.0.1:43217) (local dev port; Vercel uses the platform default).

Developer shortcut: `npx tsx scripts/seed.ts` replaces the Default workspace's plan with the Velmara demo, and `npx tsx scripts/seed.ts --blank` empties it.

### Sign-in and the admin account

There is no self sign-up. Customers sign in on `/login` with their organisation's **single sign-on** (Google, Microsoft or GitHub, when configured), and only when their verified email holds a **seat** the owner assigned in **Admin → Customers** (`/admin/customers`); everyone else is refused. Email and password sign-in is for the owner's own staff, plus one test customer account (below). The login page offers no demo sign-in; a demo sign-in API remains for automated tests in development builds only. `/account` shows who you are and, for staff, changes your password. Setting up a provider: [`docs/deploy-checklist.md`](docs/deploy-checklist.md) §3a.

The admin account that opens the owner control panel (`/admin`) is created from the command line — nothing secret goes in config:

```bash
npm run create-admin
# prompts for email, name, and the password twice (hidden); the same command resets an admin's password
# non-interactive: printf '%s\n' "$ADMIN_PASSWORD" | npm run create-admin -- --email you@example.com --name "Your Name"
```

A test customer account for trying the customer side without SSO (KAN-59): a password account on a test-only email (default `tester@synapse.test`) holding the one seat of the **Synapse Test** customer. It signs in on `/login` like a customer and lands on the workspace picker; unassigning its seat in **Admin → Customers** signs it out at once. Only emails on test-only domains (`.test`, `.example`, `example.com`, …) can sign in this way; real customers stay SSO-only.

```bash
npm run create-test-customer
# prompts for the email (Enter for tester@synapse.test) and the password; run again to reset the password
```

It uses `DATABASE_URL` from the environment or `.env*` files. Sign in at `/login` with that email and password. Sell and assign customer seats at **Admin → Customers** (`/admin/customers`); manage your own staff's password accounts (admins and Platform operators only) at **Admin → Users** (`/admin/users`): create (a temporary password is shown once), reset passwords, change roles, verify, disable/enable and unlock.

Passwords: at least 12 characters, not your email, not a common password; stored only as scrypt hashes. Five wrong passwords in a row lock the account for 15 minutes (an admin can unlock it sooner).

**Deploy to Vercel:** [`docs/deploy-checklist.md`](docs/deploy-checklist.md) (operator list) and [`docs/deployment-vercel.md`](docs/deployment-vercel.md) — Postgres via Vercel Postgres / `DATABASE_URL`; LLM provider logins and routing in the owner console at `/admin/control`.

### AI on and off

The Synapse admin decides whether AI runs, in the owner console (`/admin/control`), for every customer at once (KAN-53):

- the **master switch** ("AI for all workspaces") turns all AI on or off;
- each **AI section** (ingestion, gap extraction, tactic extraction, mapping, partial split, prioritization, ideation) has its own switch, so one step can run by hand while the rest use AI.

Customers have no AI switch of their own and are not told when a section is off: the screens simply offer the manual path.

With AI off no model is called and nothing is uploaded or parsed: the first place is **Start**, where gaps and tactics are added by hand, and every later step works by hand. With AI on, every manual path is still there.

With AI on, the first visit is **Upload** on `/`. Upload a source (PDF, DOCX, PPTX, XLSX, .txt or .md, up to 3 MB) or paste its text; the LLM chosen for the parse stage parses every file type into blocks. Old .doc, .ppt and .xls files must be saved as the newer formats first. There is no separate parser service. **Gaps** shows every mapped gap with computed Open / Partially Addressed / Addressed. Every gap lists the source(s) it was identified from under **View constituent needs** — if several documents raised the same gap, each source is listed. There is no accept/reject inbox. Partial must be split or rewritten. Then **Prioritize**, then **Tactics** for open gaps.

Gap status after mapping (not the Plan High / Medium / Low bands):

- **Open** — complete white space: no completed, ongoing, or planned tactics AND no published literature addressing this gap. Proposed tactics do not count as addressing.
- **Partially Addressed** — some evidence (completed / ongoing / planned tactics and/or published literature) that supports but does not fully close the gap. Click Partial to split (LEFT = Addressed + tactic, RIGHT = Open leftover) or rewrite the original as Open or Addressed. Partial cannot stay.
- **Addressed** — published literature and/or completed, ongoing, or planned tactics fully close the gap. The engine computes this when evidence is sufficient. A human override of Open or Addressed requires a reason and wins until cleared or marked stale on ingest/coverage refresh.

Customer app:

| Route | What |
| --- | --- |
| `/` | Sidebar places: Upload (or Start with AI off) → Gaps → Prioritize → Tactics. Query `?place=` |
| `/timeline` | The IEGP timeline, built by hand: every prioritized gap with its activities beneath it; create, date, drag and sequence activities with no model, warnings for broken dependencies, detail on click, image (PNG) export, save as final (Medical Affairs) |
| `/ideation` | Tactic ideas for High-priority open gaps, AI-proposed or added by hand (Medium and Low gaps get tactics from the library or by hand on the gap) |
| `/needs`, `/residuals`, `/roadmap`, `/mappings` | Secondary lists: constituent needs, residual gaps, forward roadmap, gap × tactic mapping table |
| `/room`, `/room/audience`, `/presentation` | **Hidden for now** (KAN-52): redirect to the plan. The presenter console and audience window come back by setting `ROOM_ENABLED` in `src/lib/room/enabled.ts`. The timeline exports as a PNG image |
| `/breakouts` | **Hidden for now** (KAN-57): redirects to the plan. Comes back by setting `BREAKOUTS_ENABLED` in `src/lib/breakouts-enabled.ts` |
| `/setup` | Setup wizard for the plan's context |
| `/sources` | Upload and review sources and their parsed blocks (read only with AI off) |
| `/workspaces`, `/workspaces/[id]` | Your workspaces; settings (rename, members, load demo / reset to blank) |
| `/login`, `/account` | SSO sign-in for seat holders (plus staff email and password); your account and, for staff, your password |

`/matrix` is kept only as a redirect to Prioritize (`/?place=plan`) so old bookmarks work.

Owner console (owner only: `OWNER_EMAILS` or an admin/operator account). The old top-level URLs (`/control`, `/pipeline`, `/runs`, `/evals`, `/catalog`, `/sdlc`, `/docs`, `/accuracy/*`) redirect here:

| Route | What |
| --- | --- |
| `/admin/control` | AI master switch, LLM provider logins, per-stage model routing |
| `/admin/customers` | Customers, seats sold and assigned |
| `/admin/users` | Staff email and password accounts |
| `/admin/accuracy` | The accuracy lab (owner testing tool) |
| `/admin/pipeline`, `/admin/runs` | Run any stage or the chain; run traces and signals |
| `/admin/evals`, `/admin/catalog`, `/admin/modules` | Gold evals, registered modules and prompt variants, module versions |
| `/admin/sdlc`, `/admin/docs` | Specs in `docs/sdlc` |

## Modular stack

Every stage (S0 upload → S10 timeline) is an independent module behind a
versioned contract, with its own observability and evals. See
[`docs/modules.md`](docs/modules.md) for the boundaries and the upgrade steps.

LLM access is set up by the owner, never by an end user. Every provider uses one
server-side API key from the environment: `XAI_API_KEY` (xAI Grok, the default
route), `ANTHROPIC_API_KEY` (Anthropic Claude, the one-click alternate),
`OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`. There is no provider
login. **AI & routing** (`/admin/control`) shows each provider as "Key set" or
"No key" with the env var it reads, never the value, and sets per-stage routing.
A provider with no key is not configured: routing to it fails with a message
naming the env var, and the manual path stays available; nothing falls back to
rules. Copy `.env.example` to `.env.local` and fill in what you need; never commit
a credential.

To test the AI steps without paid credit, use the free Gemini tier: put a free
Google AI Studio key in `GEMINI_API_KEY`, set `GEMINI_MODELS=gemini-3.8-flash`, restart,
and choose **Route every stage to → Google · Gemini** in AI & routing. A free-tier
rate limit (HTTP 429) or "high demand" (HTTP 503) is waited out and retried a few times. A per-day quota is
reported to the owner and not retried.

Every edit, lock and audit row records the signed-in person.

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
npm test            # Vitest unit and integration suite (needs Postgres; DATABASE_URL)
npm run typecheck   # next typegen + tsc
npm run lint        # eslint
npm run test:e2e    # Playwright against port 43217
```

## Documentation

| Doc | What |
| --- | --- |
| [problem-and-solution.md](docs/problem-and-solution.md) | Problem statement and proposed IEGP |
| [iegp-model.md](docs/iegp-model.md) | Locked objects, gates, priority, refresh |
| [consultant-ux-spec.md](docs/consultant-ux-spec.md) | Consultant UX: nav IA, readiness strip, Gaps workbench, Prep \| Room |
| [presentation-and-breakouts.md](docs/presentation-and-breakouts.md) | Presentation view + multi-window breakout groups |
| [deploy-checklist.md](docs/deploy-checklist.md) | Operator checklist: env, admin account, SSO and seats, smoke tests |
| [modules.md](docs/modules.md) | Kernel, stages S0–S10 and module contracts |
| [sdlc/01-requirements.md](docs/sdlc/01-requirements.md) | Requirements (v2) and the [compliance check](docs/sdlc/requirements-compliance.md) |
| [docs/sdlc/](docs/sdlc/) | Architecture, process and flows. Files marked *Retired* describe the v1 insights engine and are kept for lineage |
