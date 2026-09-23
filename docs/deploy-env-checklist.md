# Deploy / env checklist (accuracy stack)

Operator checklist before shipping Synapse with the accuracy-first modules. **Never commit secrets.** Use `.env.example` as the source of variable names; set values in Vercel / your host only.

Companion docs: [deployment-vercel.md](./deployment-vercel.md), [deployment-live.md](./deployment-live.md).

## Required

| Variable | Purpose | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Postgres for accuracy + legacy IEGP tables | Pooled URL in production; schema applies on first request |

## Document parsing (LlamaParse)

| Variable | Required | Purpose |
| --- | --- | --- |
| `LLAMA_CLOUD_API_KEY` | Yes for PDF/PPTX parse | LlamaCloud service key (not an end-user OAuth path) |
| `LLAMA_PARSE_TIER` | No | `cost_effective` \| `agentic` (default) \| `agentic_plus` |

Without `LLAMA_CLOUD_API_KEY`, PDF/PPTX ingest falls back or fails depending on route; text/DOCX local paths still work.

## LLM — Grok (xAI) default route

Prefer **OAuth from `/control`**. Optional server API key unlocks runs when no OAuth session exists.

| Variable | Required | Purpose |
| --- | --- | --- |
| `XAI_OAUTH_CLIENT_ID` | No (public client shipped) | Override PKCE client |
| `XAI_OAUTH_CLIENT_SECRET` | If xAI issues one | Token exchange |
| `XAI_API_KEY` | No | Server-side fallback when OAuth session missing |
| `XAI_BASE_URL` / `XAI_MODELS` | No | Defaults in `.env.example` |

Redirect URI (prod): `https://<host>/api/oauth/llm/callback?provider=xai-grok`

## LLM — Anthropic (Claude) alternate

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_OAUTH_CLIENT_ID` | For Claude login | Control-panel OAuth |
| `ANTHROPIC_API_KEY` | No | Server-side fallback |
| `ANTHROPIC_WORKSPACE_ID` | **When the Claude key is org-scoped** | Sent as Anthropic workspace header; omit for workspace-scoped keys |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODELS` | No | Defaults in `.env.example` |

If extract / coverage assist returns workspace-scope errors, set `ANTHROPIC_WORKSPACE_ID` to the Anthropic console workspace id that owns the key.

## Optional providers & identity

| Area | Variables |
| --- | --- |
| OpenAI | `OPENAI_OAUTH_*`, `OPENAI_API_KEY` |
| Gemini | `GOOGLE_OAUTH_*`, `GOOGLE_CLOUD_PROJECT` |
| OpenRouter | `OPENROUTER_OAUTH_CLIENT_ID` (optional; PKCE can be client-less) |
| App sign-in | `GOOGLE_IDP_*`, `MICROSOFT_IDP_*`, `GITHUB_IDP_*` — omit all → demo typed-name gate |

## Smoke after deploy

1. `DATABASE_URL` connected; open `/accuracy` and create or seed a workspace.
2. `LLAMA_CLOUD_API_KEY` set → upload a PDF on Sources.
3. `/control` → Log in with xAI (Grok) and/or Claude; run one accuracy module → **Runs** shows cost / tokens when estimates exist.
4. If using org-scoped Anthropic keys, confirm `ANTHROPIC_WORKSPACE_ID` and re-try extract.

## Dual forge

Published commits must land on both Cursor Origin and `github.com/Shashb21/synapse` (`./scripts/push-both.sh`). Never commit `GH_TOKEN`.
