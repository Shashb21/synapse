# Live LLM keys and Grok routing

Every LLM provider authenticates with one **server-side API key** from the environment (`.env.local` locally, your host's environment settings in production). There is no provider login, and no field in the UI ever takes or shows a key. The owner console's **AI & routing** page (`/admin/control`) shows each provider as **Key set** or **No key**, with the env var it reads; customers never see it.

| Provider | Env var | Sent as |
| --- | --- | --- |
| xAI · Grok (default route) | `XAI_API_KEY` | `Authorization: Bearer` |
| Anthropic · Claude (one-click alternate) | `ANTHROPIC_API_KEY` | `x-api-key` + `anthropic-version` |
| OpenAI · ChatGPT | `OPENAI_API_KEY` | `Authorization: Bearer` |
| Google · Gemini | `GEMINI_API_KEY` | `x-goog-api-key` |
| OpenRouter | `OPENROUTER_API_KEY` | `Authorization: Bearer` |

A provider without its key is **not configured**: routing skips it, and if nothing in a stage's chain has a key the run stops with a message naming the env var to set (customers are told to ask their administrator or carry on by hand; there is no deterministic / offline LLM fallback). Keys are read when a call is made; restart or redeploy after changing one.

## Grok (default route)

1. Set `XAI_API_KEY` in the server environment and restart (or redeploy).
2. Open **`/admin/control`** (owner console → AI & routing; `/control` redirects there). **xAI · Grok** (marked **Default route**) reads **Key set**.
3. Optional: use **Route every stage to** → **xAI · Grok** to apply Grok on all stages (Claude remains the one-click alternate).

| Variable | Required | Purpose |
| --- | --- | --- |
| `XAI_API_KEY` | Yes, for Grok | The key |
| `XAI_BASE_URL` | No | Default `https://api.x.ai/v1` |
| `XAI_MODELS` | No | Comma-separated allowlist for the control panel; the first is the default |

Each provider has the same `*_MODELS` override (`ANTHROPIC_MODELS` defaults to `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001`). A stored route whose model a provider no longer lists runs on that provider's default model, and the routing panel shows the model actually used. An org-scoped Anthropic key also needs `ANTHROPIC_WORKSPACE_ID`. All names are in `.env.example`.

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
