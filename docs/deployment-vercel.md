# Deploy Synapse on Vercel

Production stack: **Next.js 16** on Vercel + **Postgres** (`DATABASE_URL`). LLM access is one server-side API key per provider, set in the Vercel environment (`XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`). There is no provider login; the owner console (`/admin/control`) shows only whether each key is set.

**Operator checklist:** [`deploy-checklist.md`](./deploy-checklist.md) (env, smoke, post-deploy hygiene).

## Prerequisites

- GitHub repo: [Shashb21/synapse](https://github.com/Shashb21/synapse)
- Branch for production: `main`
- An API key for at least one LLM provider (xAI for the default route), kept in Vercel env — never in git

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

**Alternative:** Any Neon / RDS / self-hosted Postgres with a standard `postgres://…` URL and TLS (`sslmode=require` for cloud hosts). The client enables TLS for non-localhost hosts and verifies the server certificate (`sslmode=require` and `verify-full` verify too; `verify-ca` skips only the host-name check). For a private CA such as RDS, set `DATABASE_CA_CERT` to the CA bundle's PEM text.

Schema is created on first request (`ensureSchema` / platform DDL).

## 2. Create the Vercel project

### Option A — Vercel dashboard (simplest)

1. [https://vercel.com/new](https://vercel.com/new) → Import **Shashb21/synapse**.
2. **Framework preset:** Next.js (auto-detected; `vercel.json` pins `npm run build`).
3. **Root directory:** repository root.
4. **Production branch:** `main`.
5. Add `DATABASE_URL` (step 1) before the first deploy.
6. Deploy.

### Option B — Vercel CLI

```bash
npm i -g vercel@latest   # or: npx vercel@latest
vercel login
cd /path/to/synapse
git checkout main
vercel link                  # pick team + create/link project
vercel env add DATABASE_URL  # paste pooled Postgres URL (Production)
# LLM provider keys (see .env.example) — one at a time:
# vercel env add XAI_API_KEY
# vercel env add ANTHROPIC_API_KEY
vercel --prod
```

CLI prints the production URL (e.g. `https://synapse-….vercel.app`).

## 3. Environment variables

Set in **Vercel → Project → Settings → Environment Variables**. Use `.env.example` as the checklist. **Do not commit values.**

| Variable | Required for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Hosted Postgres (see §1) |
| `DATABASE_CA_CERT` | Private-CA Postgres | PEM text of the CA that signed the database certificate (RDS, self-hosted). Not needed for Neon / Vercel Postgres |
| `DATABASE_SSL_VERIFY` | Never, ideally | `false` keeps TLS but skips the certificate check. Last resort: it lets anyone on the path impersonate the database |
| `SYNAPSE_LLM_TIMEOUT_MS` | Optional | Provider call time limit, default 120000. A timeout shows as "provider unavailable" |
| `SYNAPSE_JSON_BODY_MAX_BYTES` | Optional | Largest JSON API request, default 5 MB (413 above it) |
| `SYNAPSE_MAX_PARSE_UNITS` / `SYNAPSE_MAX_PARSE_CALLS` | Optional | Per-document parse limits, default 2000 sections / 50 model calls |
| `SYNAPSE_MAX_WORKSPACES_PER_USER` | Optional | Workspaces one person may create, default 20 |
| `SESSION_SECRET` | **Yes** | ≥ 32 random characters (`openssl rand -base64 48`). Signs the workspace-selection cookie (bound to the session, expires with it). The production server refuses to start without it — there is no fallback in production |
| `OWNER_EMAILS` | Owner console | Comma-separated platform-owner emails. Only an identity provider's **verified** email matches |
| `ALLOWED_EMAIL_DOMAINS` | Optional | Comma-separated domains (exact match). When set, only verified emails on these domains may sign in |
| `AZURE_TENANT_ID` | Microsoft sign-in | Your Entra ID directory id. `common` / `organizations` / `consumers` are refused unless `MICROSOFT_ALLOW_MULTI_TENANT=1` |
| `MICROSOFT_ALLOW_MULTI_TENANT` | Optional | `1` deliberately allows the multi-tenant endpoint. Not recommended |
| `ANTHROPIC_WORKSPACE_ID` | Org-scoped Claude keys | Required when the Anthropic key is org-scoped |
| `XAI_API_KEY` | Grok (default route) | Server-only; the console shows only "Key set" / "No key" |
| `ANTHROPIC_API_KEY` | Claude (one-click alternate) | Server-only |
| `OPENAI_API_KEY` | OpenAI | Server-only |
| `GEMINI_API_KEY` | Gemini | Server-only |
| `OPENROUTER_API_KEY` | OpenRouter | Server-only |
| `GOOGLE_IDP_*` / `MICROSOFT_IDP_*` / `GITHUB_IDP_*` | Customer sign-in | SSO for seat holders only (seats in `/admin/customers`). With none set, customers cannot sign in; staff use password accounts (`npm run create-admin`, `/admin/users`) |

```bash
vercel env add SESSION_SECRET   # paste the output of: openssl rand -base64 48
vercel env add OWNER_EMAILS
```

**Sign-in identity.** Only a verified email reaches a session: Google needs `email_verified=true`; Microsoft uses `email` only when the ID token carries `xms_edov` (add it under *Token configuration → optional claims*) or `email_verified`, never `preferred_username`; GitHub uses the primary verified address from `/user/emails`. Without a verified email the person is known as `provider:subject`, which never matches a workspace invite or `OWNER_EMAILS`. Demo sign-in is off in production.

Optional overrides: `*_BASE_URL`, `*_MODELS` (e.g. `XAI_BASE_URL`, `ANTHROPIC_MODELS`) — defaults in `.env.example`. A provider without its key is not configured, and routing to it fails with a message naming the env var.

## 4. SSO redirect URI (production)

Register the sign-in callback with each SSO provider using your **live Vercel host** (`https://<project>.vercel.app` or custom domain):

```text
https://<vercel-host>/api/auth/callback
```

Sign-in builds `redirect_uri` from the incoming request origin, so preview deployments need a matching redirect URI per preview host **or** use a stable production domain only. LLM providers need no redirect URI: they use API keys only.

## 5. Smoke test after deploy

Open:

| URL | Expect |
| --- | --- |
| `/login` | SSO buttons, then the staff email + password form; no sign-up link |
| `/` | Upload (AI on) or Start (AI off) in the open workspace |
| `/admin/control` | AI master switch; five providers, each "Key set" or "No key" with its env var, Grok default, no API-key fields |
| `/admin/customers`, `/admin/users` | Customers and seats; staff password accounts |
| `/admin/accuracy` | Accuracy lab workspaces (create, seed, archive, delete) |
| `/admin/accuracy/routing` | Per call-kind routing + live price table |
| `/admin/accuracy/audit?workspace_id=…` | Event trail + estimated-spend rollup |
| `/timeline` | Hand-built IEGP timeline |

The full list is in [`deploy-checklist.md`](./deploy-checklist.md) §6. After setting `XAI_API_KEY` and redeploying, **xAI · Grok** on `/admin/control` reads "Key set".

## 6. Build notes

- **Node:** CI uses 22; `package.json` `engines` requests Node ≥ 22.
- **Port:** Vercel sets `PORT` automatically; local dev uses `43217` via `npm run dev` only.
- **No custom server** — standard Next.js App Router output.
- **Hygiene:** listing `/accuracy/runs` auto-abandons `running` rows older than 30 minutes; operators can also POST `/api/accuracy/hygiene` (`sweep_stale_runs`, `archive_workspace`, `delete_workspace`).
