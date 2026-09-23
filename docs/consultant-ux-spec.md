# Synapse IEGP — Consultant UX specification

**Status:** Proposed · ready to implement
**Audience:** Consultants preparing an Integrated Evidence Generation Plan before a workshop, and facilitating during the workshop
**Out of scope for this phase:** Full workshop presentation / deck mode (stub only)
**Related:** [`iegp-model.md`](iegp-model.md), [`problem-and-solution.md`](problem-and-solution.md), [`accuracy-reference-ux.md`](accuracy-reference-ux.md), existing workshop stage at `/accuracy/workshop`

## 1. Purpose

Synapse IEGP turns static gap spreadsheets and slideware into a living evidence plan: sources → mapped gaps with computed status → human validation → priority bands → proposed tactics → timeline.

Consultants are the primary operators. They need a tool that is dense enough for serious prep, calm enough for a room of stakeholders, and honest about what is engine-computed versus human-locked. Leadership still leaves with a timeline artefact; the room does not need to see the factory floor (pipeline, evals, routing).

This spec defines information architecture, screen behaviour, visual language, and Prep vs Room modes so implementation stays aligned with the locked IEGP model.

## 2. Users and jobs

**Primary user: consultant / facilitator**
- Pre-workshop: ingest sources, resolve Partials, confirm gaps, set priority bands, draft tactics, export a draft timeline.
- In-room: walk boards of gaps, lock decisions with name + function + rationale, avoid accidental deep admin.

**Secondary: TA / Medical / HEOR / Market Access stakeholders**
- Read status and priority clearly from across a table or screen share.
- Challenge individual gaps and tactics; do not operate Lab tools.

**Not primary for this UI pass**
- Platform operators running pipeline stages, hillclimb, or gold evals (Lab surfaces).

## 3. Design principles

**One question per screen**
- Upload: what is in?
- Gaps: what is true?
- Prioritize: what matters?
- Tactics: what do we do?
- Timeline: what is the plan over time?

Prep and Room are modes of the same data, not two products. Same gaps, tactics, locks, and joins. Room reduces chrome and enlarges decision affordances.

Status is colour plus word, never colour alone. Open / Partially Addressed / Addressed must remain readable on a projector and for colour-vision deficiency.

Coverage ≠ priority. Status tokens and priority bands must never share the same colour language.

Traceability on demand. Constituent needs, quotes, and sources sit one click behind the gap card — not in the default reading path.

Engine drafts; humans lock. UI never implies auto-close. Partial cannot stay; Resolve is mandatory before Prioritize when Partials remain.

Presentation comes later as a read-only lens (chapters → boards → tactic chips → Gantt) over validated state. This phase only stubs Prep | Room.

Cut instructional walls. Once the UI encodes the flow, page intros shrink to one short line. Helper copy belongs next to the rare action that needs it.

## 4. Information architecture

### 4.1 Primary rail (always visible in Prep)

| Place | Route | Question |
| --- | --- | --- |
| Upload | `/?place=upload` | What sources are in the plan? |
| Gaps | `/?place=gaps` | What evidence gaps are true, and in what status? |
| Prioritize | `/?place=plan` (existing prioritize place) | Which Open gaps are High / Medium / Low? |
| Tactics | `/?place=tactics` | What proposed tactics address Open gaps? |
| Timeline | `/timeline` | What does the living IEGP look like over time? |

### 4.2 Tools (secondary, not peer to the rail)

- Matrix (`/matrix`) — reachable from Prioritize (tools cluster or inline link).
- Ideation (`/ideation`) — reachable from Tactics.

These stay in the product but must not compete visually with Upload → Gaps → Prioritize → Tactics → Timeline.

### 4.3 Lab (collapsed by default)

Hidden behind a Lab disclosure in the sidebar / mobile sheet:

- Get started (`/setup`)
- Mapping table (`/mappings`)
- Pipeline (`/pipeline`)
- Runs (`/runs`)
- Control panel (`/control`)
- Eval (`/evals`)
- Spec (`/sdlc`)

Workshop personas should not need Lab open. Power users can expand it.

### 4.4 Workspace chrome

Top or sidebar header always shows:

- Asset / workspace name
- Indication (when set)
- Plan label (IEP vs IEGP from workspace metadata when present)
- Readiness strip (see §5)

Optional later: Prep | Room toggle (see §10).

## 5. Readiness strip

A compact, always-visible strip so the facilitator knows whether the room can start.

Contents (derived from existing engine helpers — `planNavCounts`, `gapsReadyForPrioritize`, `planGates`):

| Signal | Meaning |
| --- | --- |
| Gaps N | Live gap count |
| Partial N | Must resolve (split or rewrite) before Prioritize |
| Unconfirmed N | Live gaps not yet human-validated |
| Ready / Not ready for Prioritize | Boolean from existing readiness rules |

**Behaviour**

- Counts are links/filters into Gaps with the matching chip selected when clicked (Partial → `partial`, Unconfirmed → `needs_validation`).
- When Partial > 0 or Unconfirmed > 0, strip uses muted warning styling; when ready, calm success styling without celebration chrome.
- Upload place also mirrors the same checklist in a local readiness panel (§6.1).

## 6. Screen specifications

### 6.1 Upload

**Goal:** Get sources into the plan and see prep readiness.

**Layout**
- Main: Drop zone first; demo-pack affordance second; source list as rows.
- Side or below: Readiness checklist (same signals as chrome strip, expanded into checklist copy).

**Source row**
- Title, type, last extract state, "used in N gaps" when known.
- Clear empty state: blank workspace, point at demo files in `public/demo-sources/`.

**Copy**
- Title: Upload sources
- One line: Demo files and notes extract gaps and tactics already mapped, with engine-computed status.

**Non-goals**
- Do not run pipeline stage chrome on this page.
- Do not show accept/reject inbox language.

### 6.2 Gaps (heart of prep)

**Goal:** Establish what is true. Engine status + human validation + Partial resolution.

**Layout — split workbench**

```
┌─────────────────────┬──────────────────────────────────────┐
│ Filters + list       │ Selected gap detail                  │
│ (≈38–42% width)      │ (≈58–62% width)                      │
└─────────────────────┴──────────────────────────────────────┘
```

On narrow viewports: list full-width; selecting a gap opens detail as a sheet or stacked panel with back control.

**Left: list**

Filter chips (existing semantics): All · Partial · Open · Addressed · Unconfirmed

Default sort / triage
1. Partial first
2. Unconfirmed next
3. Then Open
4. Addressed last

Within a band, stable secondary sort (domain, then title).

List row content
- Status cue (left border + short label)
- Title (evidence-topic title once)
- Domain / SI / chapter tag when present
- Compact tactic count
- Unconfirmed flag if needed

Selected row: stronger ring / elevated background.

**Right: detail**

Header
- Title
- Status badge + override control (existing override with required reason)
- Disagreement flag when human override disagrees with engine (existing pattern)

Body
- Short statement
- Mapped tactics as chips (name, tactic status, overall coverage badge, needs-review flag)
- Quiet control: View constituent needs (N)

Primary actions by status

| Status | Hero action | Secondary |
| --- | --- | --- |
| Partially Addressed | Resolve → existing split / rewrite dialog | Override (rare) |
| Unconfirmed (any live) | Confirm → LockForm name + function | Map tactic, record missed |
| Open | Map existing tactic / Record missed | Override, Confirm if still needed |
| Addressed | Confirm if unconfirmed; else quiet | Map / record missed / override |

Header (quiet)
- Add open gap
- Add addressed gap (library tactic or recorded missed real study; no proposed invention here)

**Rules (product locks — UI must enforce messaging)**
- Partial cannot remain: Resolve is mandatory path.
- Do not invent proposed tactics on Gaps; that belongs on Tactics after Prioritize.
- Addressed creation requires accompanying tactic (library or missed real study).

**Empty state**
- No mapped gaps yet → point to Upload, or add Open / Addressed here.

### 6.3 Prioritize

**Goal:** Lock High / Medium / Low on Open gaps only.

**Layout**
- Three columns: High · Medium · Low
- High is visual hero: slightly wider or stronger column border / header weight
- Addressed bucket: collapsed by default (expand to audit; do not dominate the board)

**Card content**
- Domain tag
- One-line title / statement
- Status micro-label only if still relevant (Open)
- No forms on the board; detail via click-through if needed

**Gates**
- Place remains locked until Gaps readiness allows Prioritize (existing `planGates`).
- Continue to Tactics when bands are set (existing unlock).

**Tools link**
- "Open matrix" → `/matrix` (configurable axes; do not rebuild matrix inside this place in this phase).

### 6.4 Tactics

**Goal:** Create and assign proposed tactics for Open gaps after prioritization.

**Layout**
- Group by priority of linked Open gaps: High groups first, then Medium, then Low.
- Each group lists gap header + proposal cards / assign controls.

**Proposal card**
- Name
- Type chip (RWE, IIT, post-hoc, ITC, publication, …)
- Lead function badge (Medical, HEOR, …)
- Linked gap chips
- Tactic status badge
- Accept / edit affordances for ideation drafts (draft chips until accepted — never auto-write the plan)

**Rules**
- Proposed tactics do not change gap status until planned / ongoing / completed.
- Recording missed real studies remains on Gaps.

**Tools link**
- "Open ideation" → `/ideation` for high-priority open gaps.

### 6.5 Timeline

**Goal:** Final living artefact — interactive Gantt bound to tactics.

**Behaviour (preserve existing; polish presentation)**
- Bars bind to `tactic_id` (or milestone entities from inventory).
- Gap IDs on click / detail, not on every bar label (density).
- Export image (PNG/SVG) remains prominent — leave-behind after workshop.
- Save-as-final remains a deliberate lock, not ambient autosave.

**Chrome**
- Timeline is a primary rail item so consultants treat it as the plan output, not a Lab curiosity.

### 6.6 Matrix and Ideation (tools)

- No IA change to their internal models in this phase.
- Entry points demoted from peer nav to tool links under Prioritize / Tactics.
- Keep routes stable for bookmarks and tests.

## 7. Visual system

### 7.1 Foundation

Keep the existing graphite dark theme:
- Background `#181818`, card `#1e1e1e`, border `#2e2e2e`
- Geist Sans / Mono
- shadcn primitives already in `src/components/ui`

Evolve tokens; do not invent a second theme for Prep.

### 7.2 Status tokens (gap status)

| Status | Token | Treatment |
| --- | --- | --- |
| Open | `--unknown` (amber) | Soft left border + pill "Open" |
| Partially Addressed | `--opportunity` (blue) | Soft left border + pill "Partial" + must-resolve cue |
| Addressed | `--known` (green) | Soft left border + pill "Addressed" |

Never rely on colour alone; always include the word.

### 7.3 Priority tokens (bands)

Priority High / Medium / Low must use a separate scale (e.g. neutral weight, typography, or distinct chart hues that are not the status greens/ambers/blues above). Document the chosen mapping in implementation so badges stay consistent.

### 7.4 Selection and elevation

- Resting cards: flat
- Selected: clearer focus ring + slightly lifted background (card → subtle brighter step)
- Motion: short transitions only on status change and board switch — no decorative motion

### 7.5 Type scale

| Mode | Body | Titles | Action hit target |
| --- | --- | --- | --- |
| Prep | 13–14px | 15–18px | standard buttons |
| Room (stub / later) | 16px+ | 28–32px | ≥44px |

## 8. Component inventory (implementation map)

| Spec piece | Likely touchpoints |
| --- | --- |
| Nav IA + Lab disclosure | `plan-chrome.tsx` |
| Readiness strip | `plan-chrome.tsx`, `app-shell.tsx` nav model, `lib/iegp/engine` counts/gates |
| Gaps split workbench | `gaps-workbench.tsx`, `split-gap-dialog.tsx`, `gap-status-override.tsx`, `gap-tactic-actions.tsx`, `iegp-badges.tsx` |
| Prioritize polish | `plan-cards.tsx`, home prioritize pane in `app/page.tsx` |
| Tactics polish | `tactics-place.tsx` (and related) |
| Upload readiness | `ingest-panel.tsx` (or equivalent), home upload pane |
| Prep | Room stub | `plan-chrome.tsx` + link to `/accuracy/workshop` (or workspace workshop route) |
| Spec doc | `docs/consultant-ux-spec.md` + docs index / README table |

Preserve LockForm name+function, coverage dimension menus, and API actions; this is a UI/IA pass, not an engine rewrite.

## 9. Copy guidelines

- Prefer short titles; one-line intros.
- Use product terms consistently: Open, Partially Addressed (UI short label Partial), Addressed, Confirm, Resolve, High / Medium / Low.
- Avoid "inbox", "accept/reject", "cluster", "auto-closed".
- IEP vs IEGP: show workspace `plan_label`; do not hardcode one acronym in chrome.

## 10. Prep | Room stub

**Prep (default)**

Full consultant workbench as specified above. Lab available but collapsed.

**Room (stub — this phase)**

Toggle in chrome: Prep | Room.

Room behaviour now
- Hide Lab entirely.
- Optionally bump base type one step if cheap.
- Deep-link to existing workshop experience when workspace context exists (`/accuracy/workshop` or `/accuracy/w/[slug]/workshop`).
- If no workshop workspace context: empty state — "Room mode uses a workshop workspace" with a link to create/open one. Do not invent presentation slides.

**Room behaviour later (not this phase)**
- In-app boards (facilitator tags or priority bands) with large cards
- Rationale-gated actions only
- Keyboard: ← → change boards, Esc clear selection (already in workshop stage)
- Presentation lens: read-only chapters, no edit, Gantt finale

> **Implementation note (added after Phase A shipped):** `/accuracy/workshop` is a separate subsystem — its own tenant/workspace model and its own `accuracy_*` claims/snapshot schema, structurally unrelated to the IEGP `gaps`/`tactics` tables this spec's screens are built on. The Phase A stub above (a deep-link toggle) is exactly right and ships as specified — it costs nothing and the picker's existing empty state is honest. But it is **not** a foundation to build the real, gap-native Presentation view or Breakout Groups on top of; see [`presentation-and-breakouts.md`](presentation-and-breakouts.md) for why that work is a new, IEGP-native surface instead.

## 11. Accessibility and room constraints

- Status always text + colour.
- Focus rings visible on keyboard navigation.
- Projector: Partial and Unconfirmed must remain obvious at 1080p / half brightness.
- Do not put critical actions only in hover menus.
- Lock dialogs must work with keyboard submit and clear error text.

## 12. Phased delivery

**Phase A — Spec + structural UI (this implementation)**
- Add `docs/consultant-ux-spec.md` and link from docs README / main README docs table.
- Consultant nav + Lab disclosure + readiness strip.
- Gaps split workbench with Resolve / Confirm heroes and triage sort.
- Status language pass across Gaps, Prioritize, Tactics badges.
- Upload readiness checklist.
- Prioritize High-hero + Addressed collapsed default; Tactics High-first grouping.
- Prep | Room stub toggle.

**Phase B — Room depth (later)**
- First-class Room boards inside Synapse shell (or promote accuracy workshop into primary IA).
- Rationale-gated action sheet polished for projector.
- Facilitator tags as first-class prep input.

**Phase C — Presentation view (later)**
- Read-only chaptered walkthrough: context → gaps → tactics → Gantt.
- Export pack for leave-behind.
- No parallel data store; projection of validated plan only.

> **Status:** Phase C, plus a new Breakout Groups capability the user asked for alongside it, are specified in [`presentation-and-breakouts.md`](presentation-and-breakouts.md).

## 13. Success criteria

- Consultant can complete Upload → Gaps → Prioritize → Tactics → Timeline without opening Lab.
- Partials and Unconfirmed are the first things seen on Gaps.
- Resolve / Confirm are obvious; secondary actions do not compete.
- Status and priority are visually distinguishable.
- Readiness strip answers "can we start the workshop?" in under two seconds.
- Room toggle does not break Prep; workshop deep-link or honest empty state only.
- Unit tests for touched engine/UI helpers still pass; no IEGP semantic regressions (Partial still cannot stay; proposed tactics still do not address gaps).

## 14. Explicit non-goals (this phase)

- Full slide / presentation mode
- Changing coverage dimension semantics or lock rules
- Auto-assigning priority bands
- Accept/reject candidate inbox
- Merging accuracy-app and plan-app into one codebase structure beyond nav/deep-links
- Rebranding away from the graphite dark theme

## 15. Open decisions (resolve during implementation if needed)

- Exact placement of Matrix / Ideation: sidebar "Tools" under the active place vs inline text links in page headers. Prefer header text links if sidebar clutter returns. **Resolved for Phase A:** inline header text links (`Open matrix →` on Prioritize, `Open ideation →` on Tactics); no sidebar Tools cluster added.
- Room stub target when multiple accuracy workspaces exist: picker empty state vs last-used workspace. Prefer last-used with a switch control if trivial; otherwise picker. **Resolved for Phase A:** deep-link straight to `/accuracy/workshop`, which already has its own "choose a workspace" picker — no new last-used logic added.
- Whether Timeline counts toward "ready for workshop" in the strip (recommend: informational only in Phase A; readiness stays Gaps-gated). **Resolved for Phase A:** informational only — the readiness strip's Ready/Not ready signal is `gapsReadyForPrioritize`, unaffected by Timeline state.

---

*End of specification.*
