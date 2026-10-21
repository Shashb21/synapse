# KAN-120 / KAN-124 implementation ticket proposal

Status: owner approved the breakdown and all seven blocking edges. Published KAN-128 through KAN-137 as native subtasks, assigned to Calix Tan, Medium, To Do and ready-for-agent. Readback verified descriptions, parent, labels, assignment, status and blocking directions. The full specifications are published on the existing [KAN-120](https://synapse21.atlassian.net/browse/KAN-120) and [KAN-124](https://synapse21.atlassian.net/browse/KAN-124) issues and verified by readback.

Each proposed ticket delivers usable behaviour through the existing application, including persistence, authorised actions, presentation, error handling and relevant verification. Existing full-record/history surfaces allow data/behaviour work to proceed independently of common panel work. Reuse the existing editable tactic panel; no separate prefactoring or infrastructure-only ticket is needed.

| Draft | Parent | Title | Blocked by |
| --- | --- | --- | --- |
| [01](01-priority-context.md) | KAN-120 | Show evidence needed, decision context and priority next actions | None |
| [02](02-audited-priority.md) | KAN-120 | Require and preserve reasons for manual priority decisions | None |
| [03](03-objective-context-review.md) | KAN-120 | Edit objective deadlines and decision context with priority review | 02 |
| [04](04-gap-context-review.md) | KAN-120 | Audit gap edits and review priorities after meaning changes | 03 |
| [05](05-supported-ai-priorities.md) | KAN-120 | Make AI priority suggestions inspectable and safe to accept | 02 |
| [06](06-gap-panel-history.md) | KAN-124 | Open gap details with expandable history without losing workspace context | None |
| [07](07-tactic-panel-history.md) | KAN-124 | Unify tactic details and editing with the shared history panel | 06 |
| [08](08-relationship-history.md) | KAN-124 | Audit gap–tactic links and coverage from both records | 05 |
| [09](09-tactic-decision-audit.md) | KAN-124 | Audit tactic edits, lifecycle and option decisions consistently | 05 |
| [10](10-retained-tactic-discovery.md) | KAN-124 | Keep tactic options and planned work discoverable as gaps progress | 07 |

## Why these blocking edges exist

- 03 uses 02's audited reconfirmation rather than leaving changed-context priorities without a complete human review path.
- 04 reuses the consistent context-save/review behaviour delivered in 03 for the gap editor.
- 05 extends 02's reasoned priority-decision persistence with model support validation and readback.
- 07 consolidates the current tactic panel using the common panel/history interaction delivered in 06.
- 08 and 09 reuse 05's supporting-reference handling within the existing audit mechanism for other covered model judgements. Neither waits for the panels because full records already expose history.
- 10 uses both shared record-panel targets completed by 07. Current stored decisions and eligibility rules already exist, so it does not wait for new audit coverage in 08/09.

Tickets 01, 02 and 06 can start immediately. Numbers are draft identifiers, not Jira keys; replace each blocker reference with its real issue key during publication. All seven edges point to earlier drafts, with no circular dependency. Later slices must consume earlier work instead of duplicating it, and independent work must account for changes already integrated into the same modules.

## Coverage of the specifications

- Priority content, state wording, setting/global distinctions and nonblocking unknowns: 01.
- Reasons, preserved judgement, manual operation, priority permissions and reconfirmation: 02.
- Separate objective deadline, warnings, shared impact, linked history and consistent review transitions: 03.
- Statement/objective/name-only distinctions and remaining direct gap-field auditing: 04.
- Model reasoning/support, older suggestions, human-value preservation and reusable reference handling: 05.
- Common panel, accessible navigation, honest/bounded History and error recovery: 06–07.
- One relationship event from both endpoints, separate coverage per reused tactic and attributable changes: 08.
- Remaining tactic-field/lifecycle/option-decision audit and model-support coverage: 09.
- Accepted/rejected/current options, planned work, status/priority changes, manual/library routes and retained access: 10.
- Permissions, workspace boundaries, failed saves and relevant concurrency checks belong in each changing slice, not a later hardening ticket. Manual date changes require a reason but no supporting reference; covered model judgements require inspectable support.

## Publication record

Create ten native **Subtask** issues in dependency order beneath the indicated existing parent issues. The KAN project supports this issue type and native **Blocks** links. Each will be assigned to **Calix Tan**, priority **Medium**, with **ready-for-agent** and relevant existing parent labels. Keep issues open and retain the two parent specifications without editing or closing them during ticket publication.

Publish each body's Parent, What to build, Acceptance criteria, Blocked by and Implementation context sections, replacing draft blocker titles/numbers with Jira links. Use native blocking links in addition to textual blockers. Read each issue back to verify parent, description, assignment, labels, status and blocking direction. If publication partially fails, preserve created keys and repair the missing part without recreating issues.

The testing plan uses existing browser journeys as the main boundary, plus focused server/persistence checks for permissions, support validation, consistency and concurrency. It was presented to the owner for feedback; no response has been recorded, so it is an explicit implementation assumption rather than a claimed approval. No application tests have been run and no application code has been changed during this planning work.

## Published issues

- Draft 10: [KAN-137](https://synapse21.atlassian.net/browse/KAN-137)
- Draft 01: [KAN-128](https://synapse21.atlassian.net/browse/KAN-128)
- Draft 02: [KAN-129](https://synapse21.atlassian.net/browse/KAN-129)
- Draft 03: [KAN-130](https://synapse21.atlassian.net/browse/KAN-130)
- Draft 04: [KAN-131](https://synapse21.atlassian.net/browse/KAN-131)
- Draft 05: [KAN-132](https://synapse21.atlassian.net/browse/KAN-132)
- Draft 06: [KAN-133](https://synapse21.atlassian.net/browse/KAN-133)
- Draft 07: [KAN-134](https://synapse21.atlassian.net/browse/KAN-134)
- Draft 08: [KAN-135](https://synapse21.atlassian.net/browse/KAN-135)
- Draft 09: [KAN-136](https://synapse21.atlassian.net/browse/KAN-136)
