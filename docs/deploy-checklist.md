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
| `SESSION_SECRET` | **Always.** ≥ 32 random chars (`openssl rand -base64 48`). Signs the workspace cookie; a production server refuses to start without it |
| `OWNER_EMAILS` | Platform owner(s), comma-separated. Matched only against an IdP-**verified** email |
| `ALLOWED_EMAIL_DOMAINS` | Optional. Comma-separated domains; only verified emails on them may sign in (also enforced on `/signup` and on non-admin password sign-in) |
| `ALLOW_SIGNUP` | Optional. Self sign-up on `/signup` is open by default; `0` closes it (people then get accounts from an admin) |
| `AZURE_TENANT_ID` | **Required with Microsoft sign-in.** Your directory id; `common`/`organizations` refused unless `MICROSOFT_ALLOW_MULTI_TENANT=1` |
| `LLAMA_CLOUD_API_KEY` | PDF/PPTX parse via LlamaParse. Missing → Sources upload gate |
| `LLAMA_PARSE_TIER` | Optional; default `agentic` |
| `ANTHROPIC_WORKSPACE_ID` | Org-scoped Anthropic API keys (not workspace-scoped) |
| `XAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Server-side fallback when no OAuth session is connected |
| `XAI_OAUTH_CLIENT_ID` (+ secret if issued) | Grok login on `/control` (public client ships if unset) |
| Other `*_OAUTH_CLIENT_ID` | Claude / OpenAI / Gemini / OpenRouter overrides |
| `GOOGLE_IDP_*` / `MICROSOFT_IDP_*` / `GITHUB_IDP_*` | App sign-in. **None set** = demo typed-name gate |

- [ ] `SESSION_SECRET` set on **Production** (and Preview) — generate a fresh value per environment; rotating it signs everyone out of their workspace selection.
- [ ] `OWNER_EMAILS` lists the owner's IdP email (the owner must sign in with an account whose email the IdP verifies).
- [ ] Microsoft: `AZURE_TENANT_ID` pinned; `xms_edov` optional claim added to the ID token so verified emails are used (otherwise people are known by their Microsoft subject and email invites won't match).
- [ ] Optional: `ALLOWED_EMAIL_DOMAINS` restricts sign-in to your organisation's domains.
- [ ] Decide on self sign-up: leave `ALLOW_SIGNUP` unset (open) or set `ALLOW_SIGNUP=0`.

### Admin account (email and password)

- [ ] Create the admin once the database is reachable, from a machine with the production `DATABASE_URL` in its environment (never commit it):

  ```bash
  npm run create-admin            # prompts: email, name, password + confirm (hidden)
  printf '%s\n' "$ADMIN_PASSWORD" | npm run create-admin -- --email you@example.com --name "You"   # CI / non-interactive
  ```

  The account is an admin (owner of `/admin`), email-verified, role Platform operator. Running it again for the same email **resets that admin's password**, clears any lockout and signs the account out everywhere. The password is never printed and is never accepted as a flag.
- [ ] Sign in at `/login` with it and open **Admin → Users** (`/admin/users`) to create everyone else (temporary password shown once), reset passwords, verify self sign-ups, change roles, disable/enable and unlock accounts.

Password rules: at least 12 characters, not the account's email, not on the common-password list; stored as scrypt (N=16384, r=8, p=1, 16-byte salt) hashes. Sign-in says only "Email or password is incorrect." for a wrong password or an unknown email. Five failures in a row lock the account for 15 minutes. Disabling an account, resetting its password or changing its role ends its sessions at once. An admin cannot demote, un-admin or disable their own account.

Password identity: a self sign-up's email is **unverified**, so until an admin verifies it the person is `password:<account id>` — never matched against workspace invites or `OWNER_EMAILS`. Accounts an admin creates (and `create-admin`) are verified and match invites by email.

Identity rules: only a **verified** email reaches a session (Google `email_verified`, Microsoft `xms_edov`/`email_verified` — never `preferred_username` — and GitHub's primary verified address). Without one the person is `provider:subject`, which never matches an invite or `OWNER_EMAILS`. Demo sign-in is never available in production; in development it ignores a requested role/email (demo users are contributors) except under the test stub (`SYNAPSE_TEST_STUB_LLM=1`).

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
| `/login` | Email + password form first; SSO buttons when configured; no demo option |
| `/signup` | Sign-up form (or the "closed" message with `ALLOW_SIGNUP=0`) |
| `/admin/users` | After signing in as the `create-admin` account: the Users table |
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
