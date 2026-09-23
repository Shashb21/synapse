# Deploy checklist

Practical operator list for shipping Synapse (legacy IEGP + `/accuracy` stack) to **Vercel + Postgres**. Details and OAuth redirect URIs live in [`deployment-vercel.md`](./deployment-vercel.md) and [`deployment-live.md`](./deployment-live.md). Copy env names from [`.env.example`](../.env.example) — never commit values.

This is a checklist. Copy env names from [`.env.example`](../.env.example) — never commit values.

PDF/PPTX uploads on `/accuracy/sources` are **gated in-app** until `LLAMA_CLOUD_API_KEY` is set (message in the Sources form; the key is never an end-user field). DOCX/text/XLSX still parse locally. Live extract OAuth is a separate gate.

## 1. Code and CI

- [ ] Merge the release to `main` (or pin Production branch to the release cut).
- [ ] CI green: unit tests (`npm test`) and typecheck (`npm run typecheck`).
- [ ] Node **22** locally and on Vercel (`package.json` `engines`).
- [ ] `npm run build` succeeds (Vercel uses this via `vercel.json`).

## 2. Postgres

- [ ] Hosted Postgres (Vercel Postgres / Neon / RDS) with TLS.
- [ ] `DATABASE_URL` = **pooled** connection string on Production (and Preview if you use it).
- [ ] First request creates schema (`ensureSchema` + accuracy DDL). No separate migrate job.

## 3. Environment variables

Set in **Vercel → Project → Settings → Environment Variables**. Documented names only.

| Variable | When you need it |
| --- | --- |
| `DATABASE_URL` | **Always** |
| `LLAMA_CLOUD_API_KEY` | PDF/PPTX parse via LlamaParse. Missing → Sources upload gate |
| `LLAMA_PARSE_TIER` | Optional; default `agentic` |
| `ANTHROPIC_WORKSPACE_ID` | Org-scoped Anthropic API keys (not workspace-scoped) |
| `XAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Server-side fallback when no OAuth session is connected |
| `XAI_OAUTH_CLIENT_ID` (+ secret if issued) | Grok login on `/control` (public client ships if unset) |
| Other `*_OAUTH_CLIENT_ID` | Claude / OpenAI / Gemini / OpenRouter overrides |
| `GOOGLE_IDP_*` / `MICROSOFT_IDP_*` / `GITHUB_IDP_*` | App sign-in. **None set** = demo typed-name gate |

Never put API keys or PATs in the UI. `GH_TOKEN` is for this repo’s dual-forge push only — not a Vercel app secret.

## 4. OAuth redirect URIs

Register production (and preview, if used) callbacks before the first live login:

```text
https://<vercel-host>/api/oauth/llm/callback?provider=xai-grok
https://<vercel-host>/api/oauth/llm/callback?provider=anthropic-claude
https://<vercel-host>/api/oauth/llm/callback?provider=openai
https://<vercel-host>/api/oauth/llm/callback?provider=google-gemini
https://<vercel-host>/api/oauth/llm/callback?provider=openrouter
https://<vercel-host>/api/auth/callback
```

Local: `http://localhost:43217` with the same paths.

## 5. Deploy

- [ ] Import [Shashb21/synapse](https://github.com/Shashb21/synapse) (or `vercel link` + `vercel --prod`).
- [ ] Framework: Next.js. Root: repository root. Production branch: `main`.
- [ ] Env from §3 applied to **Production** before the first deploy.

## 6. Smoke after deploy

| URL | Expect |
| --- | --- |
| `/` | Legacy Upload / IEGP home |
| `/control` | LLM OAuth providers; Grok default; no API-key fields |
| `/accuracy` | Workspace list; create / seed / archive / delete |
| `/accuracy/control` | Per call-kind routing + live price table |
| `/accuracy/audit?workspace_id=…` | Event trail + estimated-spend rollup |
| `/accuracy/runs?workspace_id=…` | Module runs; stale `running` rows can be swept |
| `/timeline` | Legacy Gantt |
| `/accuracy/timeline?workspace_id=…` | Accuracy Gantt |

Connect Grok on `/control` if you need a live extract. Confirm LlamaParse with a PDF/PPTX on `/accuracy/sources` when `LLAMA_CLOUD_API_KEY` is set. Without the key, that page blocks PDF/PPTX and still accepts DOCX/text.

## 7. Post-deploy hygiene

- [ ] Archive or delete leftover gold-seed workspaces on `/accuracy`.
- [ ] On `/accuracy/runs`, **Sweep stale runs** (or wait — listing auto-abandons `running` rows older than 30 minutes).
- [ ] Check **Audit → Estimated spend** after a live extract so cost rollup is non-zero.

## Related

- [`deployment-vercel.md`](./deployment-vercel.md) — Vercel project + Postgres walkthrough
- [`deployment-live.md`](./deployment-live.md) — OAuth / Grok routing
- [`accuracy-first-build.md`](./accuracy-first-build.md) — accuracy stack map
