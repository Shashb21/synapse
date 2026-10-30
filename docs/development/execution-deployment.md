# Development execution worker deployment

KAN-202 uses GitHub Actions scheduled HTTPS delivery to the deployed Node route. No browser, local process or `waitUntil` continuation is required. The checked-in workflow is `.github/workflows/development-worker.yml`; no Vercel cron configuration is needed. This change does not deploy, create secrets or send provider requests.

Configure these application environment variables on the intended deployment:

| Variable | Required value/purpose |
| --- | --- |
| `SYNAPSE_DEVELOPMENT_DELIVERY` | `github_actions`; set only after configuring and verifying delivery below. |
| `CRON_SECRET` | A dedicated random bearer secret of at least 24 characters. Keep it server-side. |
| `SYNAPSE_DEVELOPMENT_CODE_ID` | Immutable deployment/release identity, required unless the deployment provides `VERCEL_GIT_COMMIT_SHA`. Never reuse an identity after changing executable stage/prompt code. |
| `SYNAPSE_LLM_TIMEOUT_MS` | Optional; defaults to `120000`, must be positive and at most `120000` for Development delivery. |
| `DATABASE_URL` and provider API keys | Existing server database/provider configuration. The frozen role routes must have credentials before execution creation and again at actual dispatch. |

Configure these GitHub repository Actions secrets:

| Secret | Value |
| --- | --- |
| `DEVELOPMENT_WORKER_URL` | Full deployed HTTPS endpoint, exactly `https://your-host/api/internal/development-worker`, with no query or trailing slash. |
| `DEVELOPMENT_WORKER_SECRET` | Same value as the deployment's `CRON_SECRET`. |

The endpoint is `POST /api/internal/development-worker`, Node runtime, `maxDuration = 180`. The proxy opens this exact path so scheduler delivery does not need customer cookies; the handler itself requires `Authorization: Bearer <CRON_SECRET>` using a constant-time comparison. Nearby/descendant paths retain the ordinary workspace gate. Missing/wrong/short secrets return 401; unavailable delivery settings return 503. Body/query secrets do not authenticate. Responses use `Cache-Control: no-store` and expose progress only, never private manifests or source text. Owner endpoints retain ordinary owner authentication.

The workflow runs approximately every five minutes and supports manual `workflow_dispatch`. Scheduled GitHub workflows run from the repository default branch and may be delayed by GitHub; ensure this workflow exists there and Actions scheduling is enabled before declaring production availability. Each job makes at most eight sequential bounded endpoint deliveries, stopping when no execution is claimable. A job lasts at most 30 minutes; each `curl` waits at most 190 seconds, makes no HTTP retry, and requires a successful HTTPS response. Concurrency allows only one job at a time. Database claims remain the authoritative protection when external deliveries overlap, time out or repeat. Eight quanta may leave work for the next schedule, especially Standard mode with multiple roles; there is no five-minute completion SLA.

Application `delivery.available` verifies application configuration only; it cannot verify GitHub repository secrets, workflow enablement or network reachability. Fail closed by leaving `SYNAPSE_DEVELOPMENT_DELIVERY` unset until the operator has configured those dependencies and verified an empty-queue manual dispatch. Missing GitHub secrets safely skip the job without delivering work. A configured but unavailable GitHub service leaves accepted work queued until delivery resumes.

Verify deployment without provider spend by keeping the execution queue empty, manually dispatching the workflow and checking for `No claimable Development work.`. Its authorized endpoint response should be `{ "processed": false }`. Test an absent/wrong Authorization header and expect 401. Confirm the owner history endpoint reports `delivery.available: true` only after the application settings are ready. Do not create a live execution merely to test transport. Infrastructure administrators must confirm the host supports the exported 180-second route duration; this implementation does not upgrade a hosting plan or provision infrastructure.

An execution freezes its code identity. Redeploying changed code with a new identity stops older pending computations safely instead of mixing old replies and new code. Interrupted sends and lost receipt writes need owner inspection; starting a fresh attempt may create an additional provider charge. Retain old history and receipts when investigating. No recovery action automatically resets a dispatched call to queued.
