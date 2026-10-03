# KAN-36 item-version history design

Status: Implemented for KAN-36 on 2026-10-03; all four task reviews passed. Whole-branch review remains the final gate.

Issue: [KAN-36](https://synapse21.atlassian.net/browse/KAN-36), under KAN-4.
Parent design: `2026-09-29-kan4-agent-loop-design.md`.

## Goal and scope

Keep one knowledge-base entry per distinct generated gap or tactic, with inspectable agent-loop alternatives, source/run lineage, and explicit identity decisions. A stored draft is available for review but does not acquire downstream eligibility merely by being stored. KAN-37 owns mixed assemblies; KAN-38 owns approval of those exact assemblies; KAN-39 owns subsequent human content edits.

KAN-30 through KAN-35 are Done in Jira. At design time the KAN4 checkout contained KAN-34; KAN-35 was available on its own clean, published branch. Implement KAN-36 in an isolated workspace based on KAN35 so the completed comparison functionality is retained. Do not merge or publish a shared branch as part of setup.

## Existing behavior and design choice

The accuracy-first claim store already owns gap/tactic entries. The extraction route stores only judged final items; intermediate drafts are retained separately by loop observability. Gap IDs are allocated during judging, so they cannot establish identity across earlier snapshots. Existing extraction batches provide atomic draft publication and durable downstream resume.

Extend this structure with append-only item versions and identity/ancestry records in Postgres. Reuse the claim entry as the stable identity and the recorded snapshots as the source of generated alternatives. Do not create a second knowledge base or store alternatives as additional active claims.

Alternatives considered: embedding mutable history in claim metadata is simpler initially but allows overwriting history and weakens concurrency guarantees. A separate knowledge-base subsystem duplicates current claim ownership. Dedicated history records attached to existing claims provide the clearest ownership and durable history.

## Records and identity

An item version stores an immutable version ID, workspace and claim identity, item type, exact generated payload, source file and provenance, call-run ID, snapshot identity/index, and creation time. The stored payload preserves available fields and does not invent IDs for raw drafts. A unique snapshot-item origin makes retrying publication safe without duplicating versions. Historical invalid alternatives remain inspectable and are never silently promoted.

Automatically join only unique exact same-item matches within the same workspace and item type, with matching source-backed content. Shared source blocks, array position, similar wording, or a reused external identifier alone do not prove identity. Changed wording without decisive identity evidence becomes a proposed link for contributor review rather than an automatic join. This conservative rule may require more review but avoids silently combining distinct evidence questions.

A proposed link records both entries, supporting version/source/run references, and its pending/confirmed/rejected decision. Confirmation requires the authenticated contributor identity, a reason, and an atomic workspace-scoped operation. Viewers cannot confirm. A conflicting or stale decision fails without partial history changes. Preserve original version origins when a confirmed join consolidates the visible entry; retire the duplicate active entry rather than delete history.

Splits and merges create new entries. Persist explicit predecessor edges and source/run lineage; neither operation is treated as same-item identity. Validate that predecessors exist in the same workspace and have the appropriate type; reject self-links and ancestry cycles. Do not infer split/merge ancestry solely from overlapping quotes. An explicit contributor relationship operation may record ancestry when generated output provides insufficient evidence.

## Publication and eligibility

Publish histories with extraction drafts inside the existing batch transaction, using server-owned successful run and snapshot records. Failed publication rolls back claim/history changes together. Persist distinct alternatives omitted from the final result as review drafts without adding them to the existing final-output downstream set.

Separate review-visible inventory from downstream extraction inputs. Existing behavior for the currently judged output remains compatible; history-only alternatives and unresolved identity candidates cannot enter merge, status, coverage, or other downstream inputs because they appear in a ledger list. Selecting an alternative for a live mixed assembly remains KAN-37/KAN-38 work.

Use the same publication path in isolated experiments, keeping experiment histories in their copied workspace. Gold reference answers remain evaluator-only. Existing claims remain readable; do not fabricate historical runs or snapshots during migration.

## API and UI

Provide workspace-scoped history reads and contributor-only identity/ancestry writes using existing authentication and organization membership checks. Validate all input and resolve stored origins server-side; clients cannot supply another workspace's run or source to manufacture lineage. Return specific validation/conflict/authorization errors through established route conventions.

Extend the existing ledger claim card with an on-demand history view showing exact alternatives, their snapshot/run/source origins, ancestry, and pending identity proposals. Clearly label draft alternatives. Confirmation and rejection record the contributor's reason. Viewing history does not change the claim or select an alternative for downstream use.

## Verification

Use the repository's Vitest tests for its TypeScript implementation. Test one entry with multiple versions; distinct items from the same block; changed wording requiring confirmation; confirmed and rejected links; split/merge ancestry; cross-workspace and viewer rejection; stale concurrent decisions; retry-safe publication; transactional rollback; and exclusion of history-only drafts from downstream inputs. Cover production and isolated experiment publication. Check the history UI for accessible controls and unchanged eligibility when opened. Run relevant existing extraction, omission/resume, and experiment tests plus type checking and lint on changed files.

## Material limits and assumptions

Conservative identity matching increases contributor review. It is preferable to a semantic guess that irreversibly contaminates history. This design adds no production pass-depth change, model-based identity matcher, automatic ancestry inference, or mixed-assembly approval. Exact routes, table names, signatures, and task boundaries will be specified in the implementation plan after design approval.
