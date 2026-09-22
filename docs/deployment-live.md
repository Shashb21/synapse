# Live OAuth and Grok routing

Synapse never exposes API-key fields in the UI. Users connect each LLM provider from the **control panel** via OAuth (PKCE). The app ships **public OAuth client ids** for Grok, Claude, OpenAI, Gemini, and OpenRouter so **Log in** works without setting `*_OAUTH_CLIENT_ID` env vars. Operators may still override those ids (and secrets where required) in the deployment environment.

## Grok (default route) — UI path

1. Open **`/control`** (Control panel in the app shell).
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

Agentic stages **require** a connected LLM. If nothing is logged in on `/control`, runs block with a message to connect a provider (there is no deterministic / offline LLM fallback).

Optional `*_OAUTH_CLIENT_ID` overrides are documented in `.env.example`.

## Identity (app sign-in)

Same **`/control`** page → **Who is acting** → OAuth buttons when configured:

| Provider | Variables |
| --- | --- |
| Google | `GOOGLE_IDP_CLIENT_ID`, `GOOGLE_IDP_CLIENT_SECRET` |
| Microsoft Entra ID | `MICROSOFT_IDP_CLIENT_ID`, `MICROSOFT_IDP_CLIENT_SECRET`, optional `AZURE_TENANT_ID` |
| GitHub | `GITHUB_IDP_CLIENT_ID`, `GITHUB_IDP_CLIENT_SECRET` |

With **none** of these set, the deployment stays in **demo mode** (typed-name gate). With any configured, users must OAuth sign-in; demo sign-in is disabled.

## Eval gold and hillclimb

- Curated Velmara gold: `src/modules/eval-gold/`
- Per-prompt-version baselines: `prompt_baselines` table
- Variant sweep: **Runs → Hillclimb loop** or `POST /api/modules/hillclimb` with `{ "stage": "S2" }`
