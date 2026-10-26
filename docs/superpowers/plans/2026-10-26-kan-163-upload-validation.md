# KAN-163 Accuracy Upload Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject unsupported Accuracy uploads before saving a source, and make the picker accurately describe supported files.

**Architecture:** Introduce a small browser-safe Accuracy upload-format module shared by the upload route and form. Validate the filename extension before reading file bytes or calling `insertSourceFile`. Keep supported-file parsing and its retained-source error response unchanged.

**Tech Stack:** Next.js 16.3.8, TypeScript, React, Vitest, existing Postgres-backed route tests.

**Spec:** [KAN-163](https://synapse21.atlassian.net/browse/KAN-163). Its acceptance criteria are reproduced below; the fetched Jira issue remains authoritative.

## Global Constraints

- Legacy .ppt upload returns a clear validation error and creates no source.
- Picker/help text matches actual support.
- Supported PPTX, DOCX, XLSX, XLS, PDF, TXT and Markdown behavior remains.
- Direct API unsupported uploads are also rejected before persistence.
- Preserve the deliberate ability to retain supported sources when a genuine parser failure needs investigation.
- Add upload-route validation tests and a focused form/browser check.
- Preserve owner authorization, AI-off behavior, workspace validation, and the 40 MB upload limit.
- No dependencies, unrelated refactoring, live model calls, or changes to the separate IEGP upload contract.

## Diagnosis and Decisions

At baseline `4571850`, the form offers `.ppt`. The upload route resolves a parser policy that accepts any filename, inserts the source, and only then invokes parsing. Non-PDF extraction delegates to `parseLocalDocument`, which has no legacy PPT extractor. The parser error is caught and returned with HTTP 200 and `ok: true`.

The existing `src/lib/ingest/upload-formats.ts` belongs to the separate IEGP upload flow and refuses `.xls`; reusing it as-is would break this issue's explicit compatibility requirement. Keep Accuracy's validation beside its parse module in `src/accuracy/modules/parse/upload-formats.ts`. Do not change the parser-selection policy into upload validation: those responsibilities have different consumers.

Use a case-insensitive filename-extension allowlist (`.pptx,.docx,.xlsx,.xls,.pdf,.txt,.md`). MIME metadata cannot override an unsupported extension, since clients supply it. This is format eligibility validation, not proof that file contents are valid; malformed supported files continue through the existing parser-failure path. No new content-inspection system is needed.

For `.ppt`, return HTTP 400 with `ok: false` and conversion guidance: `Legacy .ppt files are not supported. Save the file as .pptx and upload it again.` Other unsupported names get a message listing supported extensions. Extensionless files are unsupported. Keep the existing AI-off response precedence.

## Review Focus

- Uppercase extensions are accepted; uppercase legacy PPT is rejected with conversion guidance.
- An unsupported extension with a supported MIME type is rejected without persistence.
- Supported `.xls` is preserved even though the separate IEGP upload helper rejects it.
- Parser failure for an eligible file still retains the source and returns `parse_error`.
- Picker acceptance, guidance, and the no-file message all describe the same formats.

### Task 1: Validate Accuracy formats and align the form

**Files:**
- Create: `src/accuracy/modules/parse/upload-formats.ts` — browser-safe format eligibility and shared picker/copy constants.
- Modify: `src/app/api/accuracy/sources/upload/route.ts` — reject ineligible filenames before bytes, checksum, or source insertion.
- Modify: `src/components/accuracy/source-upload-form.tsx` — shared accept value, supported-format help, PPT conversion guidance, consistent missing-file message.
- Modify: `tests/accuracy-source-upload.test.ts` — route persistence regressions.
- Create: `tests/accuracy-upload-formats.test.ts` — format helper and focused rendered-form checks using existing React rendering patterns.

**Interfaces:**
- Consumes: existing `insertSourceFile`, `runAccuracyModule`, and `SourceUploadForm` interfaces unchanged.
- Produces: `ACCURACY_UPLOAD_ACCEPT: string`, `ACCURACY_UPLOAD_FORMATS_LABEL: string`, and `accuracyUploadFormatError(filename: string): string | null` from the new format module. `null` means eligible; a string is the validation error.

- [ ] Read repository instructions and the installed Next.js route-handler and client-component documentation before editing code. Execute in an isolated feature worktree after approval; leave the dirty main checkout intact. Run the existing upload/parse tests to establish a baseline.
- [ ] Write failing helper and route tests: each supported extension is eligible, including uppercase; `.ppt`, `.PPT`, `.doc`, `.key`, `.exe`, and extensionless filenames return HTTP 400, `ok: false`, and leave the workspace source list unchanged. A `.ppt` with `application/pdf` must still be rejected. Assert conversion guidance for legacy PPT.
- [ ] Add regression coverage showing each supported extension reaches parsing, with one valid persisted success path per existing route-test patterns. Add a supported-file parser rejection and assert HTTP 200, `ok: true`, a retained source, and `parse_error`.
- [ ] Add a focused rendered-form check asserting the exact supported extension set without `.ppt`, visible `.ppt` to `.pptx` conversion guidance, and supported-format copy. Use real component rendering rather than assertions on source code.
- [ ] Run `npm test -- tests/accuracy-source-upload.test.ts tests/accuracy-upload-formats.test.ts` and record the expected failing assertions before implementation. Tests use Arrange / Act / Assert: prepare an upload, call the handler, then check the response and persisted sources.
- [ ] Implement the shared constants and helper, the route guard, and the form copy. Use the existing structured JSON validation response rather than throwing an exception for expected invalid input. Add documentation to the new module and public helper.
- [ ] Run `npm test -- tests/accuracy-source-upload.test.ts tests/accuracy-upload-formats.test.ts tests/llm-parse.test.ts tests/ai-switch.test.ts tests/kan-68-upload-formats.test.ts`; run ESLint on changed TypeScript files and `npm run typecheck`. Record commands, exit codes, and any baseline limitations. No live model calls.
- [ ] Self-review the complete diff. The controller handles commits and both-remote publication under workspace rules; workers do not publish. Generate a diff review package, obtain independent spec-compliance and quality verdicts, resolve findings through the skill's fix loop, then obtain the final whole-branch review.

## Completion

Report implementation, verification evidence, and limitations in Jira; transition KAN-163 to Done only after required checks and the comment succeed. Follow the workspace's next-issue selection and one-shot handoff procedure after Jira confirms Done. No merge or shared-branch publication without authorization.

## Plan Self-review

All acceptance criteria map to Task 1. One task keeps the shared helper, API guard, and form synchronized under one review gate. The tests explicitly cover all five Review Focus conditions. No existing user edits are part of this change.
