# KAN-185 saved Gantt integrity implementation report

Issue: https://synapse21.atlassian.net/browse/KAN-185
Branch: `kan-185-saved-gantt`
Worktree: `/private/tmp/synapse-kan185`
Baseline: `4571850`

## Result and approach

The timeline page and GET Gantt API now share `readWorkspaceGantt`. When a saved plan exists, its activities, labels, counts, version, hash and audit reference come from that one frozen record. The current live projection is returned separately for editing and the next save. Legacy snapshots without labels use tactic IDs; they never borrow renamed live labels. Existing legacy hash calculation is unchanged.

The board defaults to the saved snapshot and offers an explicitly unsaved live view. Changing views switches bars, details, export data and metadata together. Live exports have draft filenames and no saved version/hash/audit reference. Saved exports remain available when the live projection is empty. Schedule editing is available in the live view and labelled unsaved.

After saving, the complete returned snapshot replaces the prior bars, labels and metadata in one state update. This prevents a new hash from appearing over old bars while a server refresh is delayed. A workspace/server-plan key resets local state when navigation or refreshed plan props change. Incomplete save responses retain the prior coherent view and show an error.

SVG exports now receive the selected catalog, including frozen labels and XML escaping. PNG uses that same SVG markup. No schema change, dependency, storage rewrite or unrelated UI redesign was introduced. Authorization and existing API/page error surfaces are preserved.

## Verification evidence

Tests use Arrange / Act / Assert: establish a frozen plan and edited live data, perform a read/save/export, then check that the returned content and metadata remain paired. Database verification also checks v1 by ID after saving v2, and verifies plan history order.

Final focused command:

```sh
DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55485/synapse_test npx vitest run tests/accuracy-gantt-read.test.ts tests/accuracy-gantt-board.test.ts tests/accuracy-gantt-save-final.test.ts tests/accuracy-gantt-export-svg.test.ts tests/accuracy-gantt-activity-detail.test.ts tests/accuracy-gantt-project.test.ts
```

Exit **0**, **6 files / 38 tests passed**, duration 6.94 seconds. Log: `/private/tmp/kan185-focused-final.log`. Coverage includes API/page consistency, no saved plan, missing legacy labels/hash, removed live tactics, auth/error responses, saved/live exports, delayed refresh, changed workspace/plan props, save errors/incomplete responses, and frozen database persistence after v2.

`npm run typecheck`: exit **0**. Log: `/private/tmp/kan185-typecheck-final.log`. The first final check caught a test-only TypeScript overload mismatch in the canvas observation wrapper; changing the wrapper to accept an image plus a variable number of coordinates fixed it, and the complete command passed afterward.

Targeted ESLint over every changed TypeScript file: exit **0**, no output. Log: `/private/tmp/kan185-lint-final.log`.

Full `npm run lint`: exit **0**, **0 errors / 19 warnings** outside the changed TypeScript files. Log: `/private/tmp/kan185-lint-full-final.log`.

`npm run lint`: exit **0**, no errors and 19 warnings outside the changed TypeScript files. Log: `/private/tmp/kan185-lint-full-final.log`.

`git diff --check`: exit **0**.

Full `npm test` was started against the isolated `synapse_test` database on port 55485. It has not completed as of this report and is **not claimed passing**. Log: `/private/tmp/kan185-vitest-full.log`. At inspection, its two completed files passed (18 pipeline tests and 5 SVG tests); the worker remained active in KAN-100 benchmark CLI artifact I/O. The controller must recover the eventual exit/result before reporting full-suite success.

## Browser limitation

The focused browser regression was extended to save v1, edit the live title/dates, reopen the saved chart, inspect frozen details, download SVG, observe the actual SVG supplied to PNG canvas rendering, switch to the unsaved view, save v2, reload and export again. This browser acceptance flow is **not verified passing locally**.

A clean rerun used a fresh worktree `.next` cache, no concurrent type generation, webpack, port 43225 and a separate `synapse_e2e` database on port 55485:

```sh
E2E_PORT=43225 E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55485/synapse_e2e npx playwright test --config playwright.kan185.config.ts e2e/accuracy/accuracy-gantt-save-final.spec.ts
```

The temporary `playwright.kan185.config.ts` used this content and was removed after capturing reproduction instructions:

```ts
import config from "./playwright.config";
export default {
  ...config,
  webServer: {
    ...config.webServer,
    command: "npx next dev --webpack --hostname 127.0.0.1 --port 43225",
  },
};
```

Exit **1**, setup **1 passed**, browser tests **2 failed** in 35.4 seconds. Log: `/private/tmp/kan185-browser-clean.log`. The existing click-detail flow received `Invalid or unexpected token` and `ChunkLoadError` for generated `/_next/static/chunks/app/layout.js`, preventing client event handlers from mounting. The following test failed while parsing the seeded tactic response: the server reported **`Manifest file is empty` for `/api/accuracy/claims`** and returned HTML. These failures persisted after clearing only this worktree's generated cache. Generated-script/layout fixes are outside KAN-185 and were not attempted. Screenshot/video/error-context artifacts remain in this worktree's ignored `test-results` directory.

Component tests independently verify the selected SVG is supplied to PNG conversion, that filenames match the selected version, and that the save response updates bars/hash together. They do not replace a successful real-browser download check. A clean CI browser run is still required.

## Modified files and remaining work

- `src/accuracy/modules/gantt-project/save-final.ts`: shared frozen/live read model.
- `src/accuracy/modules/gantt-project/export-svg.ts`: selected labels and XML escaping.
- `src/app/api/accuracy/gantt/route.ts`: shared read model.
- `src/app/admin/accuracy/timeline/page.tsx`: same read model and separate live props.
- `src/components/accuracy/accuracy-gantt-board.tsx`: coherent view selection, save state, exports and unsaved editors.
- `tests/accuracy-gantt-read.test.ts`: API/page/legacy/auth/error regression tests.
- `tests/accuracy-gantt-board.test.ts`: component/export/state regression tests.
- `tests/accuracy-gantt-save-final.test.ts`: immutable v1/v2 database regression.
- `tests/accuracy-gantt-export-svg.test.ts`: label/fallback/XML regression.
- `e2e/accuracy/accuracy-gantt-save-final.spec.ts`: saved/live SVG/PNG browser flow.
- `docs/superpowers/plans/2026-10-27-kan-185-saved-gantt.md`: implementation plan.
- This report.

The implementation is ready for controller review, with the browser and full-suite limitations above. No commit, push, Jira comment or Done transition was made by this worker. The controller owns review, both-remote publication and Jira lifecycle completion.

## Review follow-up: readable full export labels

The first review found that the newly selected full statement still used the old ID-sized label column: a statement at x=8 overlapped a bar beginning at x=160 at the same vertical position. The exporter now wraps the full selected label above its own bar and grows each row with the number of label lines. Wrapping prefers word boundaries and splits unbroken words by Unicode code point without truncation. A conservative one-em width budget (one font-size unit per code point) leaves horizontal room for wide glyphs. Frozen catalog selection, legacy ID fallback, XML escaping and shared SVG/PNG input are preserved.

The regression uses Arrange / Act / Assert: create an earliest-starting long sentence and a 200-character unbroken label, export both, then check complete text, horizontal bounds, vertical separation from bars and the preceding row, and sufficient overall image height.

Observed RED, before changing the exporter:

```sh
npx vitest run tests/accuracy-gantt-export-svg.test.ts
```

Exit **1**, **5 passed / 1 failed**. The layout regression `keeps complete wrapped statements above their own bars and below the preceding row` failed with `expected 0 to be greater than 1`: no label lines were positioned above the first bar. The initial captured run is in `/private/tmp/kan185-layout-red.log`; the same failure was rerun and observed during the review follow-up. Historical RED output for the original saved/live implementation was not recovered, so no claim is made about its initial failing run.

Observed GREEN after the layout fix:

```sh
npx vitest run tests/accuracy-gantt-export-svg.test.ts tests/accuracy-gantt-board.test.ts
```

Exit **0**, **2 files / 12 tests passed**, duration 3.08 seconds. Log: `/private/tmp/kan185-layout-green.log`.

```sh
npx eslint src/accuracy/modules/gantt-project/export-svg.ts tests/accuracy-gantt-export-svg.test.ts
git diff --check
```

Both exit **0**, no output.

Standalone render verification:

```sh
node --import /private/tmp/synapse-kan185/node_modules/tsx/dist/loader.mjs /private/tmp/kan185-render-export.ts
```

Exit **0**. This temporary script exports a long sentence, a 200-character unbroken label and an XML-sensitive frozen label, renders the SVG in Chromium, and checks actual `getBBox()` text/bar rectangles. All **6 label lines** stay inside the 960px width and intersect **none of the 3 bars**; the image grows to **960 × 244**. It then runs the existing production `svgMarkupToPngBlob` converter in that browser and writes its **1920 × 488** PNG. The PNG was visually inspected: complete labels are readable above separate bars. This standalone render avoids the previously reported Next.js page/chunk failure and does not certify the full application browser acceptance flow.

Artifacts:

- `/private/tmp/kan185-layout-after.svg`
- `/private/tmp/kan185-layout-after.png`
- `/private/tmp/kan185-layout-render.json` (browser geometry)
- `/private/tmp/kan185-render-export.ts` (reproduction script)

The initial direct `tsx` command was blocked by sandbox IPC permissions. Running Node with the tsx import loader avoided that IPC requirement; Chromium itself required the approved unsandboxed local launch. One temporary-script run exposed a tsx-generated `__name` helper missing in the browser evaluation context; adding that helper to the verification harness resolved it. These were verification-harness failures, and no production change was made for them.

The separately running full suite was left untouched. Its eventual result remains the controller's responsibility to collect and reconcile with the earlier status above.

## Browser acceptance follow-up (2026-10-28)

The published browser regression failed because its test data reused `2027-01-01` as a supposedly new live date. The scheduler correctly moves the dependent Congress activity after the pivotal study's July readout, so its frozen end date is already `2027-01-01`. Rejecting that date anywhere in the saved SVG was therefore an invalid assertion. The regression now uses distinct live dates (`2028-01-11`, `2028-06-13`, `2028-07-17`) and first asserts that none occurs anywhere in the complete saved v1 snapshot. It checks the original saved activity dates, confirms the edited dates in live API data, excludes them from the saved SVG, checks the actual SVG supplied to PNG rendering, and requires them in the unsaved and v2 SVG exports.

The first local rerun passed the saved/live/export regression but exposed a separate test reliability issue in the existing click-detail flow: its temporary `Saved v1 as final` message had cleared after the server refresh, while the persistent saved version, hash and audit link were present. That assertion now waits for persistent `latest plan v1 (final)` content; the existing hash and audit assertions remain.

Final focused browser command:

```sh
E2E_PORT=43225 E2E_DATABASE_URL=postgres://synapse:synapse@127.0.0.1:55485/synapse_e2e npx playwright test --config=/private/tmp/kan185-playwright.config.ts e2e/accuracy/accuracy-gantt-save-final.spec.ts --project=chromium --reporter=line
```

Exit **0**, **3 passed** (authentication setup plus both browser tests), duration **19.3 seconds**. Screenshots and videos are in this worktree's ignored `test-results` directory. The temporary configuration imports the repository configuration, sets absolute test/output paths and starts `next dev --webpack` on port 43225. It is outside the repository. The default Turbopack startup rejects this worktree's `node_modules` symlink because it points outside the project root; webpack supports that existing dependency arrangement. This successful application browser run supersedes the earlier local browser limitation for the two focused tests, but does not establish a full-browser-suite result for the revised head.

Additional fresh verification:

```sh
npx tsc --noEmit --incremental false
npx eslint e2e/accuracy/accuracy-gantt-save-final.spec.ts
git diff --check
```

All exit **0**, with no diagnostics. Only the browser test and this report changed in this follow-up; no application code, dependency or permanent configuration change was needed. No commit or push was made by the implementer.

Controller reconciliation: the original full `npm test` run completed with **205 files passed / 1 skipped; 1,960 tests passed / 10 skipped**, duration 1093.27 seconds (log `/private/tmp/kan185-vitest-full.log`). GitHub push and PR unit jobs plus typecheck/lint passed on `6e28218`. Push browser run `40604513122` finished with **273 passed / 9 skipped / 1 failed**; its sole failure was the date-collision assertion corrected above. Full CI must be collected again for the revised commit before marking the Jira issue Done.
