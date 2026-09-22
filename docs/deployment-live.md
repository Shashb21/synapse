# Live OAuth and Grok routing

Synapse never exposes API-key fields in the UI. Operators configure credentials in the deployment environment.

## Grok (default route)

| Path | When to use |
| --- | --- |
| **xAI OAuth** | Set `XAI_OAUTH_CLIENT_ID` (and secret if required). Users connect **xAI · Grok** in the control panel. |
| **Cursor subscription** | Set `CURSOR_API_KEY` from [cursor.com/dashboard](https://cursor.com/dashboard) (API Keys). Grok runs through the Cursor Cloud Agents API and draws from the key owner’s Cursor plan. No `XAI_OAUTH_CLIENT_ID` is required. |

Other LLM providers (Claude, OpenAI, Gemini, OpenRouter) still use their OAuth flows from the control panel.

If neither xAI OAuth nor `CURSOR_API_KEY` is configured, agentic stages degrade to `deterministic-local` while keeping Grok-first routing in the control panel.

## Identity (app sign-in)

Set one or more identity provider client ids (separate from LLM OAuth):

| Provider | Variables |
| --- | --- |
| Google | `GOOGLE_IDP_CLIENT_ID`, `GOOGLE_IDP_CLIENT_SECRET` |
| Microsoft Entra ID | `MICROSOFT_IDP_CLIENT_ID`, `MICROSOFT_IDP_CLIENT_SECRET`, optional `AZURE_TENANT_ID` |
| GitHub | `GITHUB_IDP_CLIENT_ID`, `GITHUB_IDP_CLIENT_SECRET` |

With **none** of these set, the deployment stays in **demo mode** (typed-name gate). With any configured, users must OAuth sign-in on the control panel; demo sign-in is disabled.

## Eval gold and hillclimb

- Curated Velmara gold cases live in `src/modules/eval-gold/`.
- Per-prompt-version baselines are stored in `prompt_baselines` when eval or hillclimb sweeps run.
- Trigger a variant sweep from **Runs → Hillclimb loop** or `POST /api/modules/hillclimb` with `{ "stage": "S2" }`.
