# KAN-37 Mixed Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically produce an inspectable, immutable gap/tactic selection with version-bound links and whole-set checks before final human review.

**Architecture:** Attach immutable assemblies to existing KAN-36 item versions; resolve lineage in the workspace transaction. Extend the existing coverage call to carry selected content and retain assembly-local outcomes rather than modify live coverage joins. Reuse current judged extraction outputs as the initial automatic selection; the assembly store also accepts selections across recorded snapshots for exact mixed reconstruction.

**Tech Stack:** TypeScript, Next.js 16.3.5, Drizzle/Postgres, Zod, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-kan37-mixed-assembly-design.md`, Jira KAN-37, with the user's clarification that human review follows complete extraction and linking.

## Global Constraints

- The agents complete gap extraction, tactic extraction, selection of generated versions, and gap-to-tactic linking before the human review step.
- Human version selection is not a prerequisite for generation or linking.
- Human addition/removal reasons must be nonempty after trimming and are enforced at KAN-39's change boundary.
- KAN-38 owns authenticated approval, rejection, warning overrides, and downstream consumption.
- Creating or inspecting an assembly must not itself change claim eligibility, validation, selected claim payloads, or production pass depth.
- Gold answers remain evaluator-only.
- An uncovered gap is an explicit result; do not invent a link merely to make every gap appear covered.
- Existing records are never edited in place.
- Clients cannot provide replacement payloads, actor identities, source files, run identifiers, or snapshot identifiers as authoritative generation lineage.
- Cross-workspace combinations are rejected.
- Match existing ledger styling and preserve accessibility; read installed Next.js guides before route/component changes.
- Workers do not spawn agents, merge, push, publish, or modify Jira. The controller owns git and Jira lifecycle.
- Use repository Vitest tests for TypeScript; Python pytest requirements do not apply to TypeScript.

## Review Focus

- Old raw drafts may have no generated ID or invalid fields: preserve exact content and report structural failures (Task 1).
- Canonical identities may change during publication: resolve under the existing workspace lock and preserve original origins (Task 2).
- Same claim IDs do not prove that coverage used the chosen version: bind full payloads and version IDs in stored call inputs (Tasks 1, 3).
- Extraction retries/resume must not generate duplicate assemblies/calls, skip linking, or feed unapproved mixed content into legacy readers (Tasks 2, 3).
- Empty/uncovered/stub outcomes must not be presented as successful substantive coverage or measured accuracy (Tasks 1, 3, 4).

## Shared record interfaces

Task 1 owns `src/accuracy/domain/assembly.ts` and exports:

```ts
type AssemblySelection = { item_version_id: string; reason: string };
type ResolvedAssemblyItem = ItemVersion & {
  claim_type: "gap" | "tactic";
  canonical_claim_id: string;
  reason: string;
};
type AssemblyMapping = { gap_version_id: string; tactic_version_id: string };
type AssemblyCoverage = AssemblyMapping & {
  run_id: string;
  input: Record<string, unknown>;
  output: unknown;
  mode: "llm" | "stub";
};
type AssemblyCheckReport = {
  checker_version: string;
  status: "passed" | "blocked";
  findings: Array<{ code: string; severity: "blocking" | "advisory";
    item_version_ids: string[]; message: string }>;
};
type Assembly = {
  id: string; workspace_id: string; created_at: string;
  actor: Actor; fingerprint: string; source_file_ids: string[];
  items: ResolvedAssemblyItem[]; mappings: AssemblyMapping[];
  coverage: AssemblyCoverage[]; linking_complete: boolean;
  output: { gaps: Record<string, unknown>[]; tactics: Record<string, unknown>[] };
  checks: AssemblyCheckReport;
};
```

Export `AssemblyError(code: "invalid_input" | "not_found" | "conflict", message: string)`.
Export `checkAssembly(args: { items: ResolvedAssemblyItem[]; source_file_ids: string[]; blocks: ParseBlock[]; mappings: AssemblyMapping[]; coverage: AssemblyCoverage[]; linking_complete: boolean }): AssemblyCheckReport`.
Export `assemblyFingerprint(args: Pick<Assembly, "source_file_ids" | "items" | "mappings" | "coverage" | "linking_complete">): string` using canonical JSON and SHA-256. Include order, reasons, exact origins/content/reference context; exclude assembly ID/time so retry identity can be compared.

Task 2 exports from `src/accuracy/store/assembly-store.ts`:

```ts
readAssembly(workspace_id: string, assembly_id: string): Promise<Assembly | null>;
listAssemblies(workspace_id: string): Promise<Assembly[]>;
resolveAssemblyItems(workspace_id: string, selections: AssemblySelection[]): Promise<ResolvedAssemblyItem[]>;
createAssembly(args: { workspace_id: string; actor: Actor;
  source_file_ids: string[]; selections: AssemblySelection[];
  mappings: AssemblyMapping[]; coverage_run_ids: string[];
  linking_complete: boolean; generation_key?: string }): Promise<Assembly>;
```

Creation resolves coverage input/output/mode from successful stored workspace runs, never browser-supplied payloads. The optional server-owned generation key identifies one immutable extraction publication; same key + same content returns the retained assembly, different content is a conflict. Changed selections without that key create a new identity. Do not expose generation keys or linking_complete as client creation fields.

Task 3 exports from `src/accuracy/kernel/assembly-generation.ts`:

```ts
generateExtractionAssembly(args: { workspace_id: string; org_id: string;
  actor: Actor; source_file_ids: string[]; extraction_run_ids: string[];
  generation_key: string }): Promise<Assembly>;
```

### Task 1: Pure immutable content and whole-set checks

**Files:**
- Create: `src/accuracy/domain/assembly.ts`
- Test: `tests/accuracy-assembly.test.ts`
- Reuse: `src/accuracy/domain/item-history.ts`, `src/accuracy/store/quote-validator.ts`, extraction and coverage schemas.

**Interfaces:** Produce every domain type/function in Shared record interfaces; consume existing `ItemVersion`, `Actor`, `ParseBlock`, `generatedItemFingerprint`.

- [ ] Write meaningful tests first for: valid gap/tactic set; exact V0/V2 payload preservation including ID-less raw versions; fingerprints change on selected version/order/reason/source/reference change but ignore object key order; legitimate empty complete set; missing required fields/quote/unknown block/wrong source; duplicate canonical entry/fingerprint/generated IDs/normalized statement/name/external IDs; invalid/duplicate mapping endpoints; stale or unbound coverage input; unknown evidence quote block; incomplete linking; stub coverage is visibly advisory, not proof of actual coverage.
- [ ] Run `npm test -- tests/accuracy-assembly.test.ts` and retain expected RED failure evidence.
- [ ] Implement pure checks without I/O. Reuse extraction field validators: inject a temporary ID only into the schema validation view for ID-less raw items; never mutate returned stored payload. Preserve existing quote normalization. Pair IDs must use exact selected version IDs; coverage input carries `selected_versions: { gap_version_id, tactic_version_id, gap_payload, tactic_payload }`. Check both version and full payload equality, input/output pair IDs, allowed evidence, confidence schema and supported content. Coverage output `not_relevant` does not create a supported mapping; every full/partial/limited decision must correspond to a mapping and vice versa. Linking completion requires one recorded decision per gap/tactic pair; no pairs is legitimately complete. Source support is deterministic, not measured recall.
- [ ] Run focused tests, self-review, and report RED/GREEN commands/results and changed files. Do not commit; controller commits after evidence.

### Task 2: Scoped origin resolution and immutable persistence

**Files:**
- Create: `src/accuracy/store/assembly-store.ts`
- Modify: `src/accuracy/store/schema.ts`, `src/accuracy/store/tenant.ts`
- Test: `tests/accuracy-assembly-store.test.ts`

**Interfaces:** Consume Task 1 domain; produce store functions in Shared record interfaces.

- [ ] Write database tests first: create/read mixed alternatives with reasons and original run/snapshot identities; new selection/reason => new immutable ID; scoped not-found for foreign version/source/run; source/run/snapshot/index/content origin tampering rejected; final-only origin allowed; exact coverage calls resolved by server; mutable claim/coverage changes never rewrite saved output; retry key reuses exact identity but rejects changed content; transaction rollback and concurrent canonical identity changes; deleteWorkspace cleans assembly references before versions/runs; history-only alternatives stay excluded from all current claim readers.
- [ ] Run `npm test -- tests/accuracy-assembly-store.test.ts` and retain RED evidence.
- [ ] Add Drizzle tables and matching DDL. A focused immutable header plus ordered selected-version rows is sufficient; immutable mappings/coverage/check snapshots may live in header JSON. Enforce workspace+generation_key uniqueness for non-null keys and foreign keys on selected versions/header. Avoid unrelated schema rewrites. Resolve source, claim type, canonical claim, successful extraction run and actual snapshot/final-output origins; validate against original item_index and exact persisted payload. Match existing final-origin semantics. Do not trust caller-provided resolved objects. Use `withAccuracyTransaction` and the existing workspace advisory-lock namespace. Database reads by ID always scope workspace. Check body finding failures are retained; malformed/untrusted origins reject. No existing claim payload/status/validation writes.
- [ ] Run focused store tests plus `tests/accuracy-item-history-store.test.ts`; report covering commands/results, cleanup and concurrency evidence. Do not commit.

### Task 3: Automatic selection/linking and authenticated inspection API

**Files:**
- Create: `src/accuracy/kernel/assembly-generation.ts`, `src/app/api/accuracy/assemblies/route.ts`
- Modify: `src/accuracy/modules/coverage-decide/decide.ts`, `src/accuracy/modules/coverage-decide/module.ts`
- Modify: `src/app/api/accuracy/extract/route.ts`, `src/accuracy/experiments/extraction-pipeline.ts` only at publication/resume boundaries required for generation.
- Test: `tests/accuracy-assembly-generation.test.ts`, `tests/accuracy-assembly-api.test.ts`; existing extraction, omission-resume, experiment and coverage tests.

**Interfaces:** Consume Tasks 1/2; produce `generateExtractionAssembly` signature above. Extend `CoverageDecideInput`/its Zod schema with optional server `selected_versions: { gap_version_id: string; tactic_version_id: string; gap_payload: Record<string, unknown>; tactic_payload: Record<string, unknown> }`. Preserve current claim-pair inputs without this field. Populate existing `buildStateFromBlocks` labels from exact selected payloads; include version identifiers in prompt state or notes without exposing gold.

- [ ] Read installed Next.js route-handler guide. Write tests first for automatic judged-version selection across successful extraction runs, actual final-only origin, V0/V2 mixed inputs handled by store, complete gaps/tactics/linking without human action, exact selected content in coverage calls, all pairs including not_relevant outcomes, stub visibly advisory, retries/resume reuse calls and assembly, failed coverage leaves no complete assembly, empty sets valid, experiment workspace isolation and no live coverage join writes. Preserve legacy judged-output downstream behavior and never consume mixed assembly there. Test signed-out read 401, foreign workspace 404, strict extra/duplicate query fields 400, unknown assembly 404, viewer authorized reads, safe generic/logged 500.
- [ ] Run new focused tests and retain RED evidence.
- [ ] Select current judge outputs by persisted exact payload and run origin; reuse recorded judgment to prefer its iteration among identical snapshot matches, otherwise an existing final-only version, otherwise a deterministic matching origin. Record server agent reason identifying judged selection and actual origin. No new LLM selection model or extra human prompt. Resolve all requested runs/workspace/sources and include legitimately empty extraction results. Use workspace-scoped generation key tied to batch ID; deterministic reserved coverage run IDs per generation+selected pair and stored successful input/output allow safe retry. Failed/in-progress/changed reserved inputs must not masquerade as successful prior results. Run pairwise coverage with exact version/payload/evidence input through `runAccuracyModule`, retaining mode. Persist only assembly-local positive mappings and all checked pair outcomes. No human gate before linking; do not promote live coverage joins or history-only claims. Run model calls outside a long assembly persistence transaction; final creation resolves and checks stored evidence atomically. Do not nest parallel operations inside workspace transactions.
- [ ] Invoke generation after atomic publication and omission safety check, before finishing the production/experiment extraction workflow; also on resume. Return `assembly_id` and checks in production response. Keep extraction-only requested kinds supported and preserve batch/journal/count response semantics. Reuse batch ID as generation key. Existing legacy merge/status consume judged outputs only; KAN-38 will wire approved assemblies. Experiment calls stay copied-workspace scoped and must not receive gold answers. Add assembly errors to safe route handling.
- [ ] Implement strict GET `/api/accuracy/assemblies?workspace_id=...` => `{ assemblies }`; adding one `assembly_id` returns `{ assembly }`. Follow history session/workspace authorization. No manual creation endpoint required. Reject unknown query keys, empty or duplicate fields. Route runtime failures log server details and return generic 500.
- [ ] Run `npm test -- tests/accuracy-assembly-generation.test.ts tests/accuracy-assembly-api.test.ts tests/accuracy-coverage-decide.test.ts tests/accuracy-extract-api.test.ts tests/accuracy-omission-resume.test.ts tests/accuracy-experiment-pipeline.test.ts` and `npm run typecheck`. Report commands/results and any compatibility adjustment. Do not commit.

### Task 4: Inspect complete proposals in the ledger

**Files:**
- Create: `src/components/accuracy/assembly-history.tsx`, `docs/kan-37-mixed-assembly.md`
- Modify: `src/app/accuracy/ledger/page.tsx`
- Test: `tests/accuracy-assembly-ui.test.ts`

**Interfaces:** `AssemblyHistory({workspaceId}: {workspaceId:string})` consumes Task 3 GET API and immutable Assembly report. No selection/approval/add/remove product controls in this ticket; KAN-38/KAN-39 own those final-review controls.

- [ ] Read installed React/Next.js guides and existing ledger/UI test conventions; applicable frontend skills must preserve existing styling rather than redesign. Write tests first for on-demand list/detail, loading/error/retry, empty history, selected source/run/snapshot/final-only labels and reasons, exact gap/tactic fields, mappings and uncovered gaps, incomplete/blocked vs passed scope, stub warning, accessible disclosure and errors, no approval or manual selection prerequisite.
- [ ] Run UI tests and retain RED evidence.
- [ ] Add compact complete-proposal inspection to ledger: immutable identity, source scope, generated gaps/tactics and links, agent reasons, lineage and structured findings. Clearly label unapproved proposals and deterministic checks; no accuracy score or individual scores as whole-set proof. Surface non-relevant/uncovered outcomes honestly, and no raw JSON required for main content. Match ledger components/typography/spacing. Semantic buttons, aria-expanded, announced errors and keyboard behavior. No changes to current validation controls or downstream eligibility.
- [ ] Document the automatic flow, identity/lineage/check meanings, conservative source/reference behavior, stub/uncovered limits, and the final human add/remove-with-reason and approval boundaries still owned by KAN-38/KAN-39.
- [ ] Run focused UI test, `npm run typecheck`, and eslint on changed files. Run full Vitest suite once for final proof. Report evidence and material limitations. Do not commit.

## Controller completion

Commit each reviewed task, publishing the KAN37 branch to origin and github per AGENTS.md. Task-scoped spec and quality reviews precede next-task dispatch; then broad whole-branch review. Keep reports and every ruling in this plan's SDD workspace. Do not call KAN-37 done unless sufficient proof, concise Jira evidence comment, and confirmed Done transition all succeed. After Done select highest-priority assigned Ready/To Do issue (creation time tie-breaker), fetch complete next context and arm the lifecycle handoff. Do not merge a shared branch without authorization.
