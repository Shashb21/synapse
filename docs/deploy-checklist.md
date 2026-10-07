# Deploy checklist

Practical operator list for shipping Synapse (the customer IEGP app plus the owner console at `/admin`) to **Vercel + Postgres**. Details and the SSO redirect URI live in [`deployment-vercel.md`](./deployment-vercel.md); LLM provider keys in [`deployment-live.md`](./deployment-live.md). Copy env names from [`.env.example`](../.env.example) — never commit values.

What the deployment gives customers: SSO sign-in for seat holders only (no self sign-up), blank workspaces by default (demo data only when chosen), AI that the owner and each workspace owner can switch off, a timeline built by hand, and no PowerPoint export. Every uploaded file is parsed by the LLM routed to the parse stage; there is no separate parser service or parser key.

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
| `ALLOWED_EMAIL_DOMAINS` | Optional. Comma-separated domains; only verified emails on them may sign in with SSO (and on non-admin staff password sign-in). Per-customer domains live on each customer in **Admin → Customers** |
| `AZURE_TENANT_ID` | **Required with Microsoft sign-in.** Your directory id; `common`/`organizations` refused unless `MICROSOFT_ALLOW_MULTI_TENANT=1` |
| `ANTHROPIC_WORKSPACE_ID` | Org-scoped Anthropic API keys (not workspace-scoped) |
| `XAI_API_KEY` | xAI Grok, the default route. Set at least this one (or another provider's key) for live AI |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` | Claude (one-click alternate), OpenAI, Gemini, OpenRouter. A provider without its key is "not configured" and is skipped by routing. Server-only; the console shows only "Key set" / "No key" |
| `GOOGLE_IDP_*` / `MICROSOFT_IDP_*` / `GITHUB_IDP_*` | Customer sign-in (SSO, seat holders only; see §3a). **None set** = customers cannot sign in; only staff password accounts can |

- [ ] `SESSION_SECRET` set on **Production** (and Preview) — generate a fresh value per environment; rotating it signs everyone out of their workspace selection.
- [ ] `OWNER_EMAILS` lists the owner's IdP email (the owner must sign in with an account whose email the IdP verifies).
- [ ] Microsoft: `AZURE_TENANT_ID` pinned; `xms_edov` optional claim added to the ID token so verified emails are used (otherwise people are known by their Microsoft subject and email invites won't match).
- [ ] Optional: `ALLOWED_EMAIL_DOMAINS` restricts sign-in to your organisation's domains.
- [ ] At least one SSO provider configured for customers (§3a). There is no self sign-up.

AI is not an environment setting. After deploy, the owner turns the **master switch** ("AI for all workspaces") on or off in `/admin/control` with one click, and can switch each AI section (ingestion, extraction, mapping, split, prioritization, ideation) on or off there. Workspaces have no AI setting of their own. With AI off there is no upload or parsing and every step is done by hand.

### Admin account (email and password)

- [ ] Create the admin once the database is reachable, from a machine with the production `DATABASE_URL` in its environment (never commit it):

  ```bash
  npm run create-admin            # prompts: email, name, password + confirm (hidden)
  printf '%s\n' "$ADMIN_PASSWORD" | npm run create-admin -- --email you@example.com --name "You"   # CI / non-interactive
  ```

  The account is an admin (owner of `/admin`), email-verified, role Platform operator. Running it again for the same email **resets that admin's password**, clears any lockout and signs the account out everywhere. The password is never printed and is never accepted as a flag.
- [ ] Sign in at `/login` with it. **Admin → Users** (`/admin/users`) is for your own staff only: every password account is an admin or a Platform operator (temporary password shown once; reset passwords, change roles, disable/enable, unlock). Customers never get a password.

Password rules: at least 12 characters, not the account's email, not on the common-password list; stored as scrypt (N=16384, r=8, p=1, 16-byte salt) hashes. Sign-in says only "Email or password is incorrect." for a wrong password or an unknown email. Five failures in a row lock the account for 15 minutes. Disabling an account, resetting its password or changing its role ends its sessions at once. An admin cannot demote, un-admin or disable their own account. A password account that is neither an admin nor an operator (e.g. a self sign-up from before KAN-28) can no longer sign in, and its sessions stop working.

Password identity: an unverified account is `password:<account id>` — never matched against workspace invites or `OWNER_EMAILS`. Accounts an admin creates (and `create-admin`) are verified and match invites by email.

### 3a. Customers, seats and SSO

Customers sign in **only** with single sign-on, and only with a seat:

1. Configure an SSO provider (below). Its "Continue with …" button appears on `/login` once its client id is set.
2. In **Admin → Customers** (`/admin/customers`) create the customer with the seats they bought and, optionally, their email domains (only emails on those domains can hold a seat).
3. Assign seats by email (one, or paste a list). Assignment is all or nothing and is refused past the seats sold, with how many remain. An email holds a seat at one customer only. Seats can't be lowered below those assigned.
4. The person signs in with SSO. In the callback, after the provider verifies the email, Synapse creates a session only if that email holds a seat on an **active** customer; anyone else gets no session and `/login` says "Your organisation hasn't assigned you a Synapse seat. Ask your administrator." (`?error=no_seat`, nothing more).
5. A seat lets someone in; they still need a workspace invite (by that email) to see a workspace. With none, `/workspaces` tells them to ask their workspace owner.

Unassigning a seat, or deactivating the customer, signs those people out at once; every session lookup also re-checks the seat. `OWNER_EMAILS` and enabled, verified admin accounts (`create-admin`) bypass the seat check, with SSO or a password. The development-only demo sign-in is unaffected.

Configuring a provider (register the redirect URI `https://<vercel-host>/api/auth/callback`; see `src/modules/auth/idp.ts` for the scopes and how the verified email is read):

| Provider | Env | Notes |
| --- | --- | --- |
| Google | `GOOGLE_IDP_CLIENT_ID`, `GOOGLE_IDP_CLIENT_SECRET` | Google Cloud → APIs & Services → Credentials → OAuth client (Web). Scopes `openid email profile`. Only an email with `email_verified=true` is used |
| Microsoft Entra ID | `MICROSOFT_IDP_CLIENT_ID`, `MICROSOFT_IDP_CLIENT_SECRET`, `AZURE_TENANT_ID` | Entra → App registrations → New (Web redirect URI as above), add a client secret. `AZURE_TENANT_ID` pins sign-in to one directory; `common`/`organizations` are refused unless `MICROSOFT_ALLOW_MULTI_TENANT=1` (needed when customers use different directories). Add the `xms_edov` optional claim to the ID token, or no email is treated as verified and nobody matches a seat |
| GitHub | `GITHUB_IDP_CLIENT_ID`, `GITHUB_IDP_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps. Uses the account's primary **verified** email |

A seat is matched against the verified email exactly (lower-cased), so assign the address the provider reports (for Microsoft, the user's `email` attribute, not their UPN).

Identity rules: only a **verified** email reaches a session (Google `email_verified`, Microsoft `xms_edov`/`email_verified` — never `preferred_username` — and GitHub's primary verified address). Without one the person is `provider:subject`, which never matches an invite or `OWNER_EMAILS`. Demo sign-in is never available in production; in development it ignores a requested role/email (demo users are contributors) except under the test stub (`SYNAPSE_TEST_STUB_LLM=1`).

Never put API keys or PATs in the UI. `GH_TOKEN` is for this repo’s dual-forge push only — not a Vercel app secret.

## 4. SSO redirect URI

Register the production (and preview, if used) sign-in callback with each SSO provider before the first customer sign-in:

```text
https://<vercel-host>/api/auth/callback
```

Local: `http://localhost:43217/api/auth/callback`. LLM providers need no redirect URI: they use API keys only.

## 5. Deploy

- [ ] Import [Shashb21/synapse](https://github.com/Shashb21/synapse) (or `vercel link` + `vercel --prod`).
- [ ] Framework: Next.js. Root: repository root. Production branch: `main`.
- [ ] Env from §3 applied to **Production** before the first deploy.

## 6. Smoke after deploy

| URL | Expect |
| --- | --- |
| `/login` | SSO buttons first, then the staff email + password form; no demo option; no sign-up link |
| `/login?error=no_seat` | "Your organisation hasn't assigned you a Synapse seat. Ask your administrator." |
| `/admin/users` | After signing in as the `create-admin` account: the staff Users table |
| `/admin/customers` | Customers with seats used / total; assign and unassign seats |
| `/admin/control` | AI master switch; each LLM provider shows "Key set" or "No key" and its env var (Grok default); per-stage routing; no API-key fields |
| `/control`, `/pipeline`, `/runs`, `/admin/accuracy` | Redirect to the matching `/admin/...` page (owner only) |
| `/workspaces` | Create a workspace: **Start blank** (default) or **Start with demo data (Velmara)**; a demo workspace shows a **Demo** badge |
| `/` | Blank workspace: Upload (AI on) or Start (AI off) |
| `/timeline` | Every prioritized gap with its activities; create, date, drag and sequence by hand; PNG export; save as final (Medical Affairs only) |
| `/admin/accuracy` | Accuracy lab (owner only): workspace list; create / seed / archive / delete |
| `/admin/accuracy/routing` | Per call-kind routing + live price table |
| `/admin/accuracy/audit?workspace_id=…` | Event trail + estimated-spend rollup |
| `/admin/accuracy/runs?workspace_id=…` | Module runs; stale `running` rows can be swept |

Set a provider's API key (e.g. `XAI_API_KEY`) in the Vercel environment and redeploy if you need live AI; its card on `/admin/control` then reads "Key set". Upload a PDF or PPTX on `/sources` with AI on to confirm the parse stage's LLM parses it; with AI off, `/sources` is read only and nothing is uploaded or parsed.

## 7. Post-deploy hygiene

- [ ] Provision each existing organization before asking a non-operator to use it: an `operator` calls `POST /api/accuracy/organizations/<org_id>/grants` with `{ "subject": "<identity-provider-subject>" }`. The endpoint is idempotent, rejects unknown organizations, and is the only in-app path for granting existing-organization access. New workspaces grant their authenticated creator automatically.
- [ ] Archive or delete leftover gold-seed workspaces on `/admin/accuracy`.
- [ ] On `/admin/accuracy/runs`, **Sweep stale runs** (or wait — listing auto-abandons `running` rows older than 30 minutes).
- [ ] Check **Audit → Estimated spend** after a live extract so cost rollup is non-zero.

## Related

- [`deployment-vercel.md`](./deployment-vercel.md) — Vercel project + Postgres walkthrough
- [`deployment-live.md`](./deployment-live.md) — provider API keys and Grok routing
- [`accuracy-first-build.md`](./accuracy-first-build.md) — accuracy stack map
