# KAN-201 verification and review record

Scope: owner-only saved experiment setup. Working branch: `feat/kan-201-development-setup`; baseline: `8bb57235a99ee4e7ea362af7b4db6d1fe12002e0`; PR target: `KAN-200`, as required by the ticket. No merge is part of this invocation.

## Local verification

- `DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55501/synapse_test npx vitest run tests/kan-201-development.test.ts`: **18 passed**, independently rerun by controller after backend review.
- `E2E_REUSE=1 E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55501/synapse_e2e E2E_PORT=43501 npx playwright test e2e/features/development-setup.spec.ts e2e/admin/owner-console.spec.ts --reporter=line`: **30 passed** after task review fixes.
- Following the final reopen-recovery fix, `E2E_REUSE=1 E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55501/synapse_e2e E2E_PORT=43501 npx playwright test e2e/features/development-setup.spec.ts --reporter=line`: **8 passed**, including setup and the new recovery scenario. The unchanged owner-console tests were not repeated.
- Changed-file ESLint and `npx tsc --noEmit`: **exit 0** after the final fix.
- Controller `npx next typegen` and `npx tsc --noEmit --incremental false`: **exit 0** before the final narrow UI fix; implementer repeated TypeScript afterward.
- `npx eslint . --max-warnings=-1`: **exit 0**, with 16 existing warnings and no errors.
- `git diff --check`: **exit 0**.

Tests use disposable local PostgreSQL databases, a stubbed completion boundary and explicitly disabled paid-provider credentials. The dedicated browser server uses webpack because Turbopack rejects this isolated checkout's external `node_modules` symlink. Screenshots at desktop and mobile widths were visually reviewed; browser checks found no horizontal overflow.

The attempted full local `npx vitest run` is **not a pass**. The existing `learning-browser-server.test.ts` fixture failed at Turbopack startup because its dependency symlink resolves outside the project root. After further tests passed, the run stopped producing progress and the controller terminated its scoped workers after about seven minutes. The fixture and Next configuration are unchanged. Fresh-checkout CI remains the required full-suite proof.

## Independent review

Task 1 passed requirement and quality review after fixes for normalized saved reference records and reproducible parsed-content hashes. Task 2 passed requirement and quality review after clearing hidden pending files on draft creation and retaining a successfully created draft when optional source discovery fails. Regression tests failed before each fix and passed afterward.

A fresh whole-change reviewer passed requirement compliance and quality/security review, with no authorization, isolation, immutable-snapshot or concurrent-write blocker. Its minor finding about source-discovery failures hiding reopened drafts was addressed in one final fix wave. Scoped final re-review passed requirement compliance and quality/regression review with no remaining findings.

## Material limits

- Browser proof covers private uploads and source-list recovery; populated workspace-source copying is covered by API integration rather than this focused browser suite.
- Historical customer parses do not retain model/prompt identity; snapshots preserve known provenance and record unavailable fields as null.
- Concurrent preparations can parse before one loses the atomic revision comparison. Persisted state remains protected; durable execution reservations belong to later execution work.
- AI-parsed gold references remain provisional. Stubbed PDF tests establish validation and persistence behavior, not live model extraction quality.
- This ticket adds setup only. Generation and evaluation execution remain later slices.
