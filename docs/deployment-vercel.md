# Deploy Synapse on Vercel

Production stack: **Next.js 16** on Vercel + **Postgres** (`DATABASE_URL`). LLM access is **OAuth-only** from `/control` — no API keys in the UI.

## Prerequisites

- GitHub repo: [Shashb21/synapse](https://github.com/Shashb21/synapse)
- Branch for this release: `cursor/mvp-gaps-live-routing-9593` (or `main` after merge)
- xAI (and other) **OAuth apps** registered with production redirect URIs (client ids/secrets in Vercel env — never in git)

## 1. Postgres (required)

The app uses Drizzle + `postgres` (see `src/lib/iegp/db.ts`). Local dev uses Docker Compose (`docker-compose.yml`); **production needs a hosted Postgres URL**.

**Recommended on Vercel:** [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres) (Neon under the hood).

1. Vercel dashboard → your project → **Storage** → **Create Database** → **Postgres**.
2. Connect it to the project. Vercel adds variables such as `POSTGRES_URL` / `POSTGRES_PRISMA_URL`.
3. In **Project → Settings → Environment Variables**, set:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | Copy **Pooled** connection string from the Vercel Postgres store (or `POSTGRES_URL` if that is the pooled URL Vercel provides). |

Apply to **Production**, **Preview**, and **Development** if you use Vercel previews.

**Alternative:** Any Neon / RDS / self-hosted Postgres with a standard `postgres://…` URL and TLS (`sslmode=require` for cloud hosts). The client enables SSL automatically for non-localhost hosts.

Schema is created on first request (`ensureSchema` / platform DDL).

## 2. Create the Vercel project

### Option A — Vercel dashboard (simplest)

1. [https://vercel.com/new](https://vercel.com/new) → Import **Shashb21/synapse**.
2. **Framework preset:** Next.js (auto-detected; `vercel.json` pins `npm run build`).
3. **Root directory:** repository root.
4. **Production branch:** `main` or `cursor/mvp-gaps-live-routing-9593` for a preview production cut.
5. Add `DATABASE_URL` (step 1) before the first deploy.
6. Deploy.

### Option B — Vercel CLI

```bash
npm i -g vercel@latest   # or: npx vercel@latest
vercel login
cd /path/to/synapse
git checkout cursor/mvp-gaps-live-routing-9593
vercel link                  # pick team + create/link project
vercel env add DATABASE_URL  # paste pooled Postgres URL (Production)
# Optional OAuth client vars (see .env.example) — one at a time:
# vercel env add XAI_OAUTH_CLIENT_ID
# vercel env add XAI_OAUTH_CLIENT_SECRET
vercel --prod
```

CLI prints the production URL (e.g. `https://synapse-….vercel.app`).

## 3. Environment variables

Set in **Vercel → Project → Settings → Environment Variables**. Use `.env.example` as the checklist. **Do not commit values.**

| Variable | Required for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Hosted Postgres (see §1) |
| `XAI_OAUTH_CLIENT_ID` | Grok login | OAuth **client** id (operator) |
| `XAI_OAUTH_CLIENT_SECRET` | Grok login | If xAI issues one |
| `ANTHROPIC_OAUTH_CLIENT_ID` | Claude login | One-click alternate |
| `OPENAI_OAUTH_CLIENT_ID` | OpenAI login | |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Gemini | |
| `OPENROUTER_OAUTH_CLIENT_ID` | OpenRouter | Optional (PKCE can be client-less) |
| `GOOGLE_IDP_*` / `MICROSOFT_IDP_*` / `GITHUB_IDP_*` | App sign-in | Omit for demo mode (typed-name gate) |

Optional overrides: `XAI_OAUTH_*_URL`, `XAI_BASE_URL`, `XAI_MODELS` — defaults in `.env.example`.

## 4. OAuth redirect URIs (production)

Register these in each provider’s console using your **live Vercel host** (`https://<project>.vercel.app` or custom domain).

**Grok (xAI) — required for default route:**

```text
https://<vercel-host>/api/oauth/llm/callback?provider=xai-grok
```

**Other LLM providers (same pattern):**

```text
https://<vercel-host>/api/oauth/llm/callback?provider=anthropic-claude
https://<vercel-host>/api/oauth/llm/callback?provider=openai
https://<vercel-host>/api/oauth/llm/callback?provider=google-gemini
https://<vercel-host>/api/oauth/llm/callback?provider=openrouter
```

**App identity (if configured):**

```text
https://<vercel-host>/api/auth/callback
```

The control panel builds `redirect_uri` from the incoming request origin, so preview deployments need matching redirect URIs per preview host **or** use a stable production domain only.

## 5. Smoke test after deploy

Open:

| URL | Expect |
| --- | --- |
| `/` | Upload / IEGP home |
| `/control` | Control panel — five OAuth providers, Grok default, no API-key fields |
| `/timeline` | Gantt surface |
| `/matrix` | Prioritization matrix |

Connect Grok on `/control` after `XAI_OAUTH_CLIENT_ID` is set and xAI redirect URI matches.

## 6. Build notes

- **Node:** CI uses 22; `package.json` `engines` requests Node ≥ 22.
- **Port:** Vercel sets `PORT` automatically; local dev uses `43217` via `npm run dev` only.
- **No custom server** — standard Next.js App Router output.
