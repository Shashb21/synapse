# KAN-37 mixed-version assembly design

Status: Draft for review. Product implementation has not started.

Issue: [KAN-37](https://synapse21.atlassian.net/browse/KAN-37), under KAN-4.

Sources: the Jira acceptance criteria, `2026-09-29-kan4-agent-loop-design.md`, `../../adr/0001-kan4-mixed-iteration-selection.md`, and the completed KAN-36 implementation on `codex/kan36-item-history` at `ccfaae4`.

## Purpose and scope

The agents complete gap extraction, tactic extraction, selection of generated versions, and gap-to-tactic linking before the human review step. The human receives that complete proposed output and can add or remove gaps and tactics, with a reason required for each change. Human version selection is not a prerequisite for generation or linking.

An **assembly** is the selected set of exact gap and tactic versions, its links, recorded origins, and selection reasons. **Lineage** means the records identifying where each selected item came from. The agent's selection reasons and the human's later change reasons are recorded separately.

For example, choosing gap A from V0 and gap B from V2 creates a new assembly. Both gaps may be individually valid, but the combination may repeat the same knowledge-base entry, lose a source quote, or invalidate a coverage decision. The system checks the combination before presenting it as structurally sound.

KAN-37 owns agent-generated assembly creation, version-bound linking, exact reconstruction, deterministic whole-set checks, and inspection. KAN-38 owns authenticated approval, rejection, warning overrides, and downstream consumption. KAN-39 owns reasoned human additions, removals, and content edits at the final review step. These ticket boundaries must not introduce extra mandatory human gates between extraction, selection, and linking. Creating or inspecting an assembly must not itself change claim eligibility, validation, selected claim payloads, or production pass depth.

## Agreed end-to-end sequence

1. Run the gap and tactic extraction agent loops and retain generated versions and their source evidence.
2. Let the agents select the proposed versions and record their reasons. Preserve alternatives for inspection; do not require the human to construct the initial selection.
3. Complete gap-to-tactic linking against those exact versions and retain link evidence and coverage decisions. An uncovered gap is an explicit result; do not invent a link merely to make every gap appear covered.
4. Check and save the complete proposed assembly. Technical failures or incomplete linking remain visible as incomplete/blocked work, rather than being labeled a complete proposal.
5. Present the complete output for human review. A contributor may add or remove a gap or tactic, supplying a reason for every action. Retain the unchanged agent result separately from the human-adjusted result.
6. Recheck any changed result and reassess affected links against its exact content. Removing an item also removes its links from the new assembly while retaining the old assembly's history; a newly added item must enter linking checks. Approval applies to the final exact checked result before live downstream use.

Automatic checking and relinking after a human change do not create another mandatory intermediate human gate. Existing exceptional pauses for blocking omissions or unresolved identity remain safety behavior, not the normal selection workflow.

## Starting point and approach

Use the completed KAN-36 branch as the implementation base in an isolated worktree. The current KAN4 checkout is behind that work and has existing local changes; retain those changes. Do not merge a shared branch during setup.

Extend the accuracy-first Postgres store with immutable assembly records attached to existing item versions. Reuse KAN-36 item history rather than duplicate version storage or put mutable selections into claim metadata. Use existing workspace transactions, source records, authorization, and domain checks where their invariants fit.

Alternatives considered:

- Mutable selection fields on claims are smaller initially but cannot reliably bind future approval to the exact combination and reasons.
- Saving only a combined JSON output loses independently verifiable version origins and can accept client-invented lineage.
- Immutable assembly records with server-resolved item versions preserve exact reconstruction and give KAN-38 a stable approval target. This is the recommended approach.

## Identity and immutable content

Each saved assembly has its own identifier, workspace, creation origin (agent generation or human review), authenticated initiating actor, relevant generating run identities, creation time, checker version, ordered selections, exact reconstructed output, and check findings. Each selection records its item-version identifier, original claim identifier, resolved canonical claim identifier at creation, claim type, source file, call run, snapshot and iteration when present, original item index, exact payload, and a trimmed nonempty agent selection reason. Human-adjusted assemblies additionally record each addition/removal, its actor, time, and required reason.

The generation pipeline supplies selected item-version identifiers and recorded agent reasons. The server resolves all origins and content from persisted workspace-scoped records. Clients cannot provide replacement payloads, actor identities, source files, run identifiers, or snapshot identifiers as authoritative generation lineage. KAN-39 supplies the separate authorized human-change boundary.

Changing a selected version, its position, the selection reasons, or any bound reference context creates a new assembly record and identifier. Existing records are never edited in place. A server-generated identity and a deterministic content fingerprint serve separate purposes: the identity names one saved artifact; the fingerprint describes the exact saved content. No existing approval is inherited by a changed artifact.

Retain a version's original origins even after a confirmed same-item relationship resolves its claim to a canonical entry. Capture the canonical identity used for checks so a later relationship decision cannot rewrite the historical result. A selected judged final-output version with no raw snapshot remains explicitly labeled as such; do not fabricate a snapshot or iteration.

## Safety and failure behavior

User-facing reads and run initiation require an authenticated session and organization-authorized workspace. The existing authorized generation pipeline creates initial assemblies without another human action. Viewers may inspect authorized assemblies but cannot initiate generation or change them. Human change actor identity comes from the session. Unknown or unauthorized workspace records return the existing scoped not-found response.

Reject malformed input, unknown selected versions, and cross-workspace origins before saving. Resolve selections and persist the artifact with its initial checks atomically under the existing workspace transaction and advisory lock, so concurrent identity decisions cannot produce partially resolved lineage. A failed write rolls back the complete artifact.

A well-formed selection that fails a deterministic check is saved with visible blocking findings, allowing inspection and a corrected replacement assembly. Failed checks do not promote or validate claims. Specific validation/not-found/conflict errors use established HTTP responses; unexpected errors are logged and return generic server errors without internal details.

## Selection scope and whole-set checks

An assembly belongs to one authorized workspace and declares its in-scope stored source files. Require at least one source file and nonempty agent selection reasons. A legitimate empty extraction result is retained explicitly; do not force invented gaps or tactics to satisfy a minimum item count. Human addition/removal reasons must be nonempty after trimming and are enforced at KAN-39's change boundary. Every selected source must be in the declared scope. Resolve the source files and parse blocks server-side. Cross-run and cross-snapshot selections are allowed within that workspace; cross-workspace combinations are rejected. Experiment copies retain their own workspace identities; this ticket does not copy assemblies into production or add an experiment-selection interface.

The output preserves selected payloads exactly and groups gaps and tactics without overwriting generated IDs. Assembly-local references use item-version IDs, which are present even when a raw draft has no generated ID. Validate the substantive gap or tactic fields with the existing extraction schemas, treating absent raw generated IDs as origin metadata rather than an invented payload field. Missing statements, tactic fields, invalid enum values, and missing provenance produce blocking findings. Existing permissive raw-draft storage does not make a draft valid for assembly.

Run these deterministic checks over the entire selected set:

1. **Origin integrity:** item versions, original claims, sources, successful call runs, and any non-null snapshot/item index agree. Null snapshot and iteration are accepted only for the stored judged-final origin. Invalid or unauthorized origins reject creation rather than producing a forged draft.
2. **Duplicates:** detect repeated version IDs, multiple versions of one canonical entry, exact same-item fingerprints, repeated generated IDs within a type, and the existing extraction rules for normalized gap statement/external identifier and tactic name. Do not merge entries as a side effect of checking. Findings identify the conflicting selections.
3. **Source support:** every provenance span names an existing block in its recorded source file and passes the existing quote validation rule, including its whitespace normalization. Empty spans, wrong source IDs, unknown blocks, missing quotes, and unsupported quotes block the check. Reuse the responsible quote validator; unknown blocks cannot count as checked.
4. **Mappings:** each assembly-local mapping explicitly names a selected gap version and selected tactic version. Both endpoints must occur in the assembly, have the correct types, and form a unique pair. Do not recover historical mappings from current mutable claim metadata. Record completion of linking independently of the number of links, so an explicitly uncovered gap differs from a gap whose linking has not run.
5. **Coverage consistency:** any attached coverage decision must come from a successful stored coverage call in the same workspace. Resolve its exact output and input server-side and retain them with its run ID. Its gap/tactic endpoints must map unambiguously to selected versions and a declared mapping. Its quoted blocks must exist in the selected pair's evidence bundle; output structure, confidence range, and identifiers must satisfy the existing coverage schema. Its recorded input must establish the exact gap/tactic content used, not only mutable claim IDs. If it cannot, emit a blocking `coverage_version_unbound` finding. If it identifies different content, emit a blocking stale-reference finding. Never silently reuse the present-day coverage join as proof of historical coverage.

The initial complete proposal includes the linking step and its version-bound results. Extend the responsible coverage call input and persistence boundary to record the exact selected content/version context, reusing the existing coverage logic. An empty mapping set is valid when linking concludes that there is no supported coverage; a missing linking result is incomplete. Earlier extraction-only artifacts may remain inspectable as progress, but are not the normal human review gate. Do not require human approval to run linking; KAN-38 gates subsequent live consumption of the finished assembly. KAN-40 owns full-pipeline benchmarking.

Store the checker version and structured findings with a code, severity, affected selected-version IDs, and explanation. Summarize the result as deterministic checks passed or blocked; display the tested scope. Do not turn that result into an accuracy percentage. This ticket does not add an LLM completeness check: deterministic source validation cannot establish that every relevant item was selected.

## Persistence, API, and inspection

Add focused assembly domain and store modules under `src/accuracy/`, with Drizzle definitions and matching DDL in the existing schema. The store owns origin resolution, canonical-identity capture, exact reconstruction, transactions, and workspace scoping. The pure domain checker owns whole-set findings against resolved immutable inputs. Keep checks separate from HTTP and UI so behavior can be tested directly.

Persist the assembly header, ordered selected-version references and agent reasons, source scope, linking completion/results and exact coverage context, exact resolved output, and immutable initial check report. Foreign keys preserve referenced versions; tenant deletion removes assembly dependencies before item versions, claims, and runs. No synthetic assemblies are created for legacy claims. Assembly creation adds no history-only marker changes and performs no claim validation or promotion.

Provide workspace-authorized list/read APIs and integrate assembly production with the existing authorized generation flow. Server-owned creation receives source scope, selected item-version IDs and agent reasons, mapping endpoints, and stored version-bound coverage call results. Reject extra fields at exposed request boundaries. Readers receive the saved exact content and report; no re-read of mutable claims may change a historical artifact's displayed output. Do not make a manual create-and-check API action a required step in generating the initial proposal.

Present the agent-generated complete assembly in the existing ledger/review flow. A selected-item summary shows its payload, original source/run/snapshot or judged-final label, item-version ID, and agent reason. An assembly detail shows its own identity, declared source scope, all selected items, mappings/coverage outcomes including uncovered gaps, and whole-set findings. KAN-39 adds the human add/remove controls and required reason fields to this final review surface. A human-adjusted output saves a new artifact; the UI never overwrites the original agent proposal or requires manual version picking to produce it. Viewers can inspect results but cannot change them.

Use existing ledger styling and semantic controls. Include labeled fields, keyboard-accessible actions, loading states, retry, and announced errors. Clearly label saved artifacts as unapproved and describe the limited meaning of deterministic checks. Do not offer assembly approval in this ticket.

## Proposed implementation boundaries

After design review, write a task-by-task plan with these independently testable deliverables:

1. Pure reconstruction and whole-set deterministic checks using resolved version/source/reference inputs.
2. Immutable transactional persistence, scoped origin resolution, tenant cleanup, and eligibility regression coverage.
3. Automatic generation integration and version-bound coverage/linking, plus authorized list/read APIs and safe error mapping.
4. Complete-proposal inspection in the ledger, user documentation explaining the final human review step, and final integration verification. Reasoned human add/remove controls remain KAN-39 work.

Use fresh implementation and task-review agents for each deliverable, then one final whole-branch reviewer. Record decisions and review evidence in this plan's SDD ledger. Associate every implementation change with KAN-37. Complete the Jira lifecycle only after verification, a successful implementation/evidence comment, and a confirmed Done transition.

## Verification requirements

Use the existing TypeScript/Vitest test conventions. Tests follow Arrange / Act / Assert: prepare persisted origins, perform selection or checking, then assert exact output and safety boundaries.

- Reconstruct a mixed V0/V2 selection with exact payloads, source/run/snapshot origins, and reasons.
- Generate and link the complete proposal without an intermediate human selection or approval action.
- Distinguish successful linking with uncovered gaps from incomplete linking and failed calls; preserve legitimate empty extraction results.
- Changing a version, order, reason, or reference context creates a different immutable identity.
- Confirmed same-item histories preserve original origins and detect duplicate canonical entries.
- Invalid source quotes, unknown mappings, and stale coverage references produce blocking findings.
- Reject cross-workspace selections, invented origins, signed-out writes, and viewer writes.
- Roll back the artifact and selections together on persistence failure; serialize relationship changes consistently.
- Preserve empty legacy histories and explicitly identify final-only versions.
- Creating or viewing an assembly never changes downstream eligibility, current claim validation, or existing extraction behavior.
- Verify accessible loading, error/retry, exact generated selection and link display, uncovered-gap labels, and whole-set findings in the UI.
- At KAN-39 integration, verify each human addition/removal requires a reason, preserves the agent baseline, creates a new assembly, and triggers affected-link checks before final approval.

Run focused new tests and relevant history, extraction, coverage, and authorization regressions, followed by type checking and lint on changed files. Run the full Vitest suite once for final integration proof. Review each implementation task for specification compliance and quality, then perform a whole-branch review.

## Material limits

Passing deterministic checks means the recorded structure, references, and source evidence satisfy the implemented rules. It does not establish clinical correctness, completeness, benchmark accuracy, or improved full-pipeline performance. Individual item scores are not an assembly quality score.

Gold answers remain evaluator-only. This ticket does not introduce semantic identity guessing, model-based assembly judging, automatic approval, downstream execution, or benchmark claims. KAN-38 and KAN-40 own approval and full-pipeline benchmarking respectively.

The current coverage store records claim-level decisions without exact selected-version input binding. Extend that responsible boundary for new assembly-linked calls; legacy records remain inspectable but cannot pass the assembly version-binding check when the exact inputs cannot be established. Accepting them would assert lineage the database does not contain.

## Design verification performed

- Fetched KAN-4 children from authenticated Jira: KAN-30 through KAN-36 are Done; KAN-37 is the earliest remaining task at the same priority and its KAN-36 dependency is Done.
- Fetched KAN-37 and KAN-38 descriptions and acceptance criteria to separate assembly checks from exact-output approval.
- Read the parent design and mixed-selection ADR and traced completed KAN-36 item history, source validation, coverage contracts, tenant cleanup, authentication, and ledger integration through a read-only subagent.
- Confirmed the implementation base `codex/kan36-item-history` is at `ccfaae4`; the current KAN4 checkout is at `075e597` and contains pre-existing local changes.
- Product code has not been changed and tests have not been run; these are design findings, not implementation proof.
- Incorporated the user's clarification: human review occurs after complete agent extraction and linking; every subsequent gap/tactic addition or removal requires a reason.
