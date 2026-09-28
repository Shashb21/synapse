# Live OAuth and Grok routing

Synapse never exposes API-key fields in the UI. The owner connects each LLM provider from the owner console's **AI & routing** page (`/admin/control`) via OAuth (PKCE); customers never see it. The app ships **public OAuth client ids** for Grok, Claude, OpenAI, Gemini, and OpenRouter so **Log in** works without setting `*_OAUTH_CLIENT_ID` env vars. Operators may still override those ids (and secrets where required) in the deployment environment.

## Grok (default route) — UI path

1. Open **`/admin/control`** (owner console → AI & routing; `/control` redirects there).
2. In **LLM providers**, find **xAI · Grok** (marked **Default route**).
3. Click **Log in with xAI** and complete xAI’s OAuth consent in the browser.
4. Optional: use **Route every stage to** → **xAI · Grok** to apply Grok as the default on all stages (Claude remains the one-click alternate).

Agentic stages use Grok only after this login succeeds and routing points at `xai-grok`.

## Grok — operator OAuth client env (deployment)

Register an OAuth application with xAI (or your IdP console) and set redirect URI to your Synapse callback, typically:

`https://<your-host>/api/oauth/llm/callback?provider=xai-grok`

(local dev: `http://localhost:43217/api/oauth/llm/callback?provider=xai-grok`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `XAI_OAUTH_CLIENT_ID` | No (built-in public client) | Optional override for the PKCE flow |
| `XAI_OAUTH_CLIENT_SECRET` | If xAI issues one | Token exchange |
| `XAI_OAUTH_AUTHORIZE_URL` | No | Default `https://accounts.x.ai/oauth/authorize` |
| `XAI_OAUTH_TOKEN_URL` | No | Default `https://api.x.ai/oauth/token` |
| `XAI_OAUTH_SCOPES` | No | Default `api offline_access` |
| `XAI_BASE_URL` | No | Default `https://api.x.ai/v1` |
| `XAI_MODELS` | No | Comma-separated allowlist for the control panel |

Agentic stages **require** a connected LLM. If nothing is logged in on `/admin/control` and no server-side API key is set, runs stop with a clear message (customers are told to ask their administrator or carry on by hand; there is no deterministic / offline LLM fallback).

Optional `*_OAUTH_CLIENT_ID` overrides are documented in `.env.example`.

## Identity (app sign-in)

Customers sign in on **`/login`** with one of these providers, and only when their verified email holds a seat assigned in `/admin/customers`. There is no self sign-up. Staff sign in with email and password (`npm run create-admin`, then `/admin/users`). Setup detail: [`deploy-checklist.md`](./deploy-checklist.md) §3a.

| Provider | Variables |
| --- | --- |
| Google | `GOOGLE_IDP_CLIENT_ID`, `GOOGLE_IDP_CLIENT_SECRET` |
| Microsoft Entra ID | `MICROSOFT_IDP_CLIENT_ID`, `MICROSOFT_IDP_CLIENT_SECRET`, `AZURE_TENANT_ID` (required) |
| GitHub | `GITHUB_IDP_CLIENT_ID`, `GITHUB_IDP_CLIENT_SECRET` |

With **none** of these set, customers cannot sign in; only staff password accounts can (plus a demo sign-in in development, never in production).

## Eval gold and hillclimb (owner tool only)

- Curated Velmara gold: `src/modules/eval-gold/`
- Per-prompt-version baselines: `prompt_baselines` table
- Variant sweep: **`/admin/runs` → Hillclimb loop** or `POST /api/modules/hillclimb` with `{ "stage": "S2" }`
