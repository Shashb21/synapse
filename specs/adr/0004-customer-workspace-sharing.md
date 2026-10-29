# Customer-owned workspaces with owner-controlled invitations

- Status: Accepted policy decision; production enforcement deferred.
- Date: 2026-10-29.
- Decision owner: Calix Tan.
- Issue: KAN-191. Deployed access verification remains KAN-178's responsibility.
- Approval: Calix approved the proposed policy area in the ticket implementation conversation: “yes i like the policy area you've come up with”.
- Approved design: [KAN-191 sharing design](../../docs/superpowers/specs/2026-10-29-kan-191-sharing-design.md).

## Scope and terminology

A customer is the organisation holding licensed seats. A seat is a current assignment allowing a named person to use that customer's application. Workspace membership separately names the people who can access a workspace, with owner/member roles. A principal is the stable identity used to check that membership. Platform owner means the operator authorised to use the administration console; workspace owner means the customer member allowed to manage that workspace's invitations. These are different authorities.

This ADR records intended policy and migration requirements. The [reference model](../policies/workspace-sharing.ts) and [tests](../../tests/kan-191-workspace-sharing-policy.test.ts) are executable design evidence only. They authenticate nobody and do not prove deployed enforcement. KAN-191 adds no production imports, runtime guards, database migrations, UI changes or access restrictions. Existing runtime behavior remains unchanged, including for unresolved legacy workspaces.

## Evidence from the current implementation

The following paths were inspected for this decision:

- `src/modules/workspaces/store.ts`: workspace records contain `created_by`, schema and demo flags, but no durable owning customer field. `workspace_members` identifies a principal and owner/member role. `createWorkspace` adds the creator as owner. `inviteMember` checks only that the inviter is a member, then adds the email principal; it does not require workspace ownership or match customer seats.
- `src/app/api/workspaces/[id]/members/route.ts`: POST delegates to `inviteMember`; its documented behavior allows any member to invite.
- `src/modules/workspaces/session.ts`: `myWorkspaces`, `selectWorkspace` and `currentWorkspace` use membership. `mayClaimDefault` permits password/demo providers or listed owner emails to claim the legacy Default workspace. This is existing behavior, not evidence of customer ownership.
- `src/modules/auth/customers.ts`: seats are assigned to customer records and are unique per email across customers. `hasActiveSeat` checks an active customer. `SEATLESS_PROVIDERS` includes password and demo; existing sign-in/session treatment must not become a workspace-ownership inference or blanket customer-app bypass.
- `src/modules/workspaces/admin-context.ts`: the owner console already keeps a separately signed, session-bound admin workspace selection and rechecks `ownerAccess`. Ordinary customer selection is membership checked. Preserve that boundary when changing access decisions.
- `src/modules/auth/api-guard.ts` and `src/modules/workspaces/context.ts`: request guards and query scoping are affected future enforcement entry points; the reference model changes neither.
- `src/modules/auth/admin-setup.ts` and `scripts/create-test-customer.ts`: KAN-59 creates password test customers with seats. Password login alone does not classify their workspaces as platform data.

A creator's present seat, email domain, authentication provider, demo flag or schema name cannot reliably establish the durable customer boundary. In particular, a person can move to another customer while the original workspace and its data remain owned by the original customer.

## Decision

Each customer workspace belongs durably to one customer. Ordinary customer access requires all of: verified identity, a current active seat at an active customer, explicit membership of the selected workspace, an explicitly classified customer workspace, and an active owning customer. The person's seat customer must match that durable owner unless an exact recorded exception applies. Missing required facts deny access in the intended policy after that workspace's approved cutover.

Only a workspace owner who already satisfies access checks and belongs to the owning customer may invite. Invitees must hold active seats at that same active customer. Members cannot grant access. Invitation creates membership rather than a new seat, and membership never grants a licence or substitutes for verification when the invitee later accesses the application.

Cross-customer access requires an explicit recorded platform-admin exception naming exactly one principal and workspace. It must have a record identifier, approving platform-admin identity, reason and current active state. Trusted adapters must establish that the approver actually had platform authority and that the approval is live, including any revocation or validity checks. An arbitrary string or client-supplied `active` flag is not proof of approval. The reference model consumes trusted facts; it cannot validate the approval ledger or authenticate the actor.

An exception relaxes only the customer-match requirement for access. It never supplies identity verification, a seat, membership, an active customer, additional capabilities or invitation authority. An external member labelled owner still cannot invite through that exception. New external grants and revocations belong to the separate platform-admin process, not the customer invitation flow.

Platform administration remains a separate verified, owner-checked admin context. Its workspace selection permits the operator's administration work without manufacturing ordinary customer membership or a customer-app bypass. Ordinary application operations continue to require customer policy checks even when the operator has an admin session. Other operation-specific role/capability checks still apply; this model covers access and invitation only.

## Allowed and denied matrix

All customer-app allow rows assume classified customer ownership and active actor/owning customers.

| Context and facts | Access | Invite |
| --- | --- | --- |
| Verified active same-customer member with workspace membership | Allow | Deny |
| Verified active same-customer workspace owner | Allow | Allow only to active seats of that customer |
| Missing verification, seat or membership; revoked seat; inactive actor or owning customer | Deny | Deny |
| Actor changes seat to another customer, with old membership retained | Deny absent exact recorded exception | Deny |
| Cross-customer member with exact active recorded admin exception and all ordinary prerequisites | Allow | Deny, including if membership role says owner |
| Missing, revoked, incomplete, wrong-principal or wrong-workspace exception | Deny cross-customer access | Deny |
| Invitee without seat, with inactive seat/customer or at another customer | Existing actor access unaffected | Deny |
| Missing workspace/owner facts, unclassified, platform/internal or development-demo workspace | Deny ordinary customer access | Deny |
| Password, demo, SSO provider or platform-owner/demo flag alone | No grant | No grant |
| Separate verified platform-owner admin context | Allow administration only | No customer-app invitation grant |
| Separate admin context without verified platform-owner authority | Deny administration | No customer-app invitation grant |

Customer-owned demo workspaces are classified customer workspaces and follow the same rows. Demo data and recorded demo replay flags do not add permission. The TypeScript request union distinguishes customer-app access/invite from platform administration so the two contexts cannot accidentally share a permission result. Missing optional facts produce an explicit denial rather than exceptions or permissive defaults.

## Alternatives considered

1. Keep any-member cross-customer sharing. This preserves current convenience but delegates disclosure of customer data to every member and makes the organisation boundary unclear.
2. Let workspace owners administer external collaboration. This is flexible but requires a separate guest lifecycle, licensing decisions and revocation administration.
3. Chosen: isolate customer workspaces by default with narrowly recorded platform-admin exceptions. This makes the ordinary boundary clear and keeps exceptional support/collaboration access deliberate and auditable.

## Migration and future enforcement

No automatic reassignment, content deletion or silent lockout is authorised by this decision. A backfill means writing reviewed ownership/classification values into existing records; it is future work, not part of this ticket.

1. Inventory every workspace, schema, member/role, recorded creator, active/inactive seat relationship and relevant integrations/jobs. Identify affected people, cross-customer grants and owners who no longer hold a seat. Capture a recoverable baseline before any data change.
2. Review durable ownership and classification with the responsible customer/platform owner. Record supporting evidence and approval for each backfill; never derive ownership automatically from the creator's current seat, email domain, provider or a demo flag. Keep unresolved workspaces on existing behavior pending review and approved cutover.
3. Explicitly classify the legacy Default/public workspace, platform/internal workspaces, Accuracy/lab workspaces, development demo workspaces and customer-owned demos. `public` is a database/schema concern, not permission to disclose customer data. Platform/internal and development-demo data stay outside ordinary customer grants and use their reviewed admin/development access path. Accuracy must preserve its separate platform-owner context and review any customer-workspace reads. KAN-59 password test customers and customer-owned demos follow customer seat and membership rules. Do not infer classification from a name or flag.
4. Review existing sharing, prepare explicit principal/workspace exception records where justified, and remediate invalid grants with the affected owner. Resolve seatless/stale owners and ownership transfer through an approved workflow without moving the workspace's customer merely because its creator moved. Do not silently give new users access or discard content.
5. Build central request-time authorization from trusted identity, durable ownership, customer/seat state, scoped membership and current exception facts. Cover creation, listing/discovery, selection and cookie resolution, pages/layouts, all workspace APIs (including invites/member changes), file/content routes, exports, background/trusted jobs and admin/Accuracy entry points. Creation must atomically record customer ownership and initial membership. Query/schema scoping must follow an authorised workspace selection rather than itself imply permission.
6. Run report-only comparisons: calculate intended decisions alongside unchanged behavior, record mismatches and remediate them without changing grants. Review coverage and readiness with the decision owner. KAN-178 and subsequent enforcement work must verify actual routes, database effects, session/cookie boundaries and browser flows; this reference suite cannot supply that proof.
7. Obtain explicit cutover approval, then enable enforcement per reviewed workspace with reversible controls and monitoring. After a workspace is cut over, missing ownership or required facts deny ordinary access. Unresolved workspaces retain current behavior until their own approved cutover.

## Revocation, concurrent changes and audit

Future adapters must read current facts on requests: removing a seat, disabling either relevant customer, removing membership or revoking an exception takes effect without relying on an old session or selected-workspace cookie. Moving a seat never moves workspace ownership. Invalidate relevant cached decisions, sessions and selections consistently; membership alone must not preserve access after revocation. A seat restored at another customer must not revive an old ordinary grant.

For invitation and creation, validate authorization and persist the grant/ownership in one transaction or an equivalent checked write. Grouping reads and writes in a transaction alone does not prevent a concurrent seat removal or owner-role change from leaving a grant based on stale facts. The future implementation must use appropriate locking, serialization or version checks to prevent that race: coordinate concurrent changes, or reject the grant when the facts used to authorize it have changed. Recheck actor ownership/access, both customer states and invitee seat at the write boundary, and verify the guarantee with concurrent database tests in the enforcement work. Define matching revocation guarantees for in-flight requests/jobs before cutover. These are implementation requirements for follow-up work; the synchronous pure model cannot test storage races.

Audit reviewed ownership/classification changes, membership and invite changes, exception approval/revocation, intended versus existing decision mismatches, denied access and cutover/rollback actions. Include principal, workspace, durable customer, action/context, decision basis, exception record identifier when used, responsible operator and timestamp. Limit audit detail to what review/recovery needs rather than copying customer content or secrets.

Rollback pauses further cutovers and restores reviewed ownership/grants and affected selections using the baseline and audit trail. Preserve customer data and revocation history; never recover by reopening arbitrary sharing or treating a provider as exempt. Investigate/remediate mismatches before resuming. Recovery and the rollout controls require review and tests before enforcement ships.

## Verification and limits

The reference tests use Arrange / Act / Assert: construct trusted facts, evaluate the pure function, then compare a hand-derived decision. They cover same-customer membership, absent/revoked prerequisites, invitation authority and invitee seats, scoped live exceptions, non-waivable checks, separate admin context, and absent/provider/demo classification bypasses.

Run `npx vitest run tests/kan-191-workspace-sharing-policy.test.ts`, scoped ESLint for the model and test, and `npm run typecheck`. Use an explicit isolated test `DATABASE_URL`: repository-wide test setup attempts to set AI flags in a database even for pure tests. A deliberately unreachable local test URL lets that setup fail harmlessly via its existing catch while these tests remain independent of Postgres.

Passing these tests establishes consistency of the proposed model only. It does not establish session authenticity, correctness of future adapters or exception storage, transaction safety, runtime route coverage, migration readiness, or deployed customer isolation. Those remain enforcement/cutover work and KAN-178 verification.
