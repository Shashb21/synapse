# Presentation view and breakout groups

**Status:** Implemented (v1) · builds on [`consultant-ux-spec.md`](consultant-ux-spec.md) Phase A
**What this covers:** the spec's own Phase C ("Presentation view — read-only chaptered walkthrough") plus a new capability requested alongside it: **breakout groups** — group gaps by workshop theme, and open one browser window per group (one per screen) so two themes can run side by side, each independently facilitated.

## Why this is a new surface, not an extension of `/accuracy/workshop`

The consultant UX spec's §10 assumed "Room" mode would deep-link to the existing `/accuracy/workshop` stage. That stage is real and does have the keyboard-driven board pattern (← → between boards, Esc to clear) worth copying — but it is built on a **completely separate subsystem**: its own tenant/workspace model (`src/accuracy/store/tenant.ts`) and its own `accuracy_*` claims/snapshot schema. It has no concept of an IEGP `gap`, `tactic`, or `coverage` row. Building gap-native breakout rooms "on top of" it would mean either forking that subsystem's data model or bolting IEGP concepts onto it sideways.

So: the Phase A "Prep | Room" toggle still deep-links to `/accuracy/workshop` exactly as shipped (that part of the spec is unchanged and correct — it costs nothing and the picker's own empty state is honest). But Presentation and Breakout Groups below are new, IEGP-native routes and tables, reading the same `gaps`/`tactics`/`coverages` state as the rest of the app.

## Identity: reusing the session system, not inventing one

The README's "No login" line describes the Gaps/Prioritize/Tactics lock pattern (typed name + function on every action, no session check) — but the app already has a second, fully-working identity layer that Timeline, Matrix, Ideation, Pipeline and Setup already use: `src/modules/auth/session.ts` + `roles.ts`. It gives each browser/device its own **cookie-scoped session** (`auth_sessions` table, 12h TTL), created either via real OAuth or, in demo mode, via `signInDemo()` — which is just the existing typed-name gate turned into a persistent per-device identity, using the same `SessionPanel` UI already shipped (`src/components/platform/session-panel.tsx`).

This is exactly "let another consultant log in and manage a breakout": they open the room's URL on their own device and sign in there. No new auth code. Breakout rooms carry a `<SessionPanel>` the same way Timeline does, and every lock action's actor-name field defaults to the signed-in session's name (a small additive `LockForm` convenience — see below) so a facilitator isn't retyping their name on every action inside their own room.

Mutations themselves stay on the existing typed-name-at-lock-time pattern (`LockForm` → `/api/iegp`), consistent with every other Gaps/Prioritize/Tactics action — the session only supplies *who's likely acting*, as a default, not a hard gate. Destructive breakout actions (delete a group) are gated behind the existing `can(role, "prioritize")` capability check, same as Matrix already does.

## Multi-window: stable URLs, not new infrastructure

Confirmed nothing in this stack does live push (no WebSockets/SSE anywhere; every mutation is `fetch` → `router.refresh()`, and every page is already `dynamic = "force-dynamic"`). Two consultants each in their own breakout window is just two browser tabs/windows open on two different `/breakouts/[id]` URLs — trivial with the App Router, no new mechanism needed for that part.

What *isn't* free is a change made in window A automatically appearing in window B without a manual refresh. Rather than introduce WebSockets/SSE (a new category of infrastructure nothing else here uses, for a workshop-day feature), the breakout room polls lightly — `router.refresh()` every 20s while the tab is visible. That's "live enough" for a room of people talking to each other, at the cost of a real render every 20s; it is not instant sync. If that ever isn't good enough, upgrading to SSE later is straightforward (the read side is already server-rendered `loadState()`), but it's explicitly not built now.

## Data model

Two new tables, following the existing `need_gap_links` pattern (a plain composite-PK join, no extra per-row state):

```sql
CREATE TABLE breakout_groups (
  id text PRIMARY KEY, name text NOT NULL, note text,
  created_at text NOT NULL, actor_name text NOT NULL, actor_function text NOT NULL
);
CREATE TABLE breakout_group_gaps (
  group_id text NOT NULL, gap_id text NOT NULL,
  PRIMARY KEY (group_id, gap_id)
);
```

Breakout groups are an organizational overlay for the workshop day, not a locked evidence object — unlike a gap or a coverage row, deleting one has no bearing on the plan itself (it just ungroups its gaps). So there's no audit-trail/version-history ceremony around them: create, assign, unassign, delete, full stop. Store functions follow the same `loadState()` → validate → mutate → `appendAudit()` shape as every other mutator (`assignTacticToGap` was the template).

## Screens

### `/breakouts` — index

Create a group (name + optional note). Lists existing groups with their assigned-gap count and two actions: **Open room ↗** (opens `/breakouts/[id]` in a new tab — this is the "one window per group, drag each to its own screen" affordance) and **Delete**.

### `/breakouts/[id]` — the room

The per-group working surface, meant to be one browser window per monitor:

- `SessionPanel` at the top — sign in on this device as this room's facilitator.
- **Add gaps** — a picker over every live gap not yet in this group.
- The group's assigned gaps as large cards (Room type scale — bigger body/title than Prep, per spec §7.5): status badge, domain tag, tactic summary, and the *same* actions already built elsewhere (override status, resolve a Partial, confirm) — a breakout room is for actually working the gaps in that theme, not just displaying them.
- ← / → moves focus between cards, Esc clears focus — the pattern copied from `/accuracy/workshop`.
- A link out to `/presentation` if the facilitator wants to switch from working mode to showing mode.

### `/presentation` — read-only chaptered walkthrough

Phase C from the consultant spec, implemented as specified: a single route, four chapters (**Context → Gaps → Tactics → Timeline**), advanced with ← / → (same copied pattern) or the chapter dots. Every chapter is a pure projection of `loadState()` / `buildPlanWorkspace()` — **no new data store**, and no mutation controls anywhere on this route (no `LockForm`, no dialogs). The Timeline chapter reuses the existing `TimelineBoard` component with `canSaveFinal`/`canReschedule` both `false`, which already hides its edit affordances.

**Leave-behind export**: a "Export pack (.pptx)" button using `pptxgenjs` (already a dependency, previously only used server-side for demo-file generation — this is its first use for exporting the plan itself). It builds a title slide, a gaps-by-status summary, a tactics-by-band summary, and a Gantt slide — the Gantt image is rasterized client-side with the same SVG→canvas→PNG technique `ExportImageButton` already uses for Timeline's own PNG export, then embedded as a slide image. This is a functional v1: the deck is a snapshot leave-behind, not a live-linked, chart-editable one — that would be real future work, not this pass.

## What this does not change

- No changes to gap/tactic/coverage semantics, lock rules, or the engine's status computation.
- No new identity/auth mechanism — the session system already existed and already covered this need.
- No websockets/SSE/real-time push added anywhere.
- `/accuracy/workshop` is untouched; the Phase A Prep | Room stub still points at it as shipped.
