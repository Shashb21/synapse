# Figma Make → Synapse mapping (KAN-8)

Source: Figma Make file `yAix7683CdlVHvIOPQOKv7` ("Design Evidence Inventory Screen"). It is a working React prototype, not static frames. Read it through the Figma MCP: `get_design_context` with nodeId `0:1`, then read the `file://figma/make/source/yAix7683CdlVHvIOPQOKv7/src/...` resources. The files are `App.tsx`, `types.ts`, `data.ts` and `components/{EvidenceInventory,PrioritizationMatrix,TacticIdeation,GanttTimeline}.tsx`. A saved copy of `EvidenceInventory.tsx` is in `.claude/figma-make/`.

## Shell
- **Left rail:** white, 52px collapsed and 220px on hover. Top to bottom it holds:
  - the logo mark ("Synapse · IEGP Workspace")
  - a **program chip** (asset code, "NEXAVIR · NSCLC 1L", a phase tag and the gap count)
  - the nav under a "Workspace" label
  - a **user chip** at the bottom (name and function)
- **Four places**, in this order, each with a subtitle:
  - Evidence Inventory ("Gaps & metadata")
  - Prioritization Matrix ("Priority canvas")
  - Tactic Ideation ("Gap tactics")
  - Gantt Timeline ("Schedule view")
- **No Upload place.** This is the non-AI flow, which starts at the Inventory.
- **Look:**
  - main area light grey `#F4F5F7`, surfaces white with a `#E5E7EB` border
  - accent indigo `#4F46E5`, with `#EEF2FF` / `#C7D2FE` tints
  - font JetBrains Mono at 10–12px, very data-dense
  - status colours: open rose, partial amber, addressed emerald
  - priority colours: high red, medium amber, low blue, n/a stone
- **Stat strip per place** (the `sectionStats` data):
  - Inventory: total, open, partial, addressed, high priority
  - Matrix: plotted, high, unpositioned
  - Ideation: tactics, linked, unlinked, gaps covered
  - Timeline: tactics, ongoing, planned, on hold

**Maps to:** `plan-chrome.tsx` (nav), `workspace-tag.tsx` (program chip) and the account menu (user chip). Our places are Upload, Gaps, Prioritize, Tactics and Timeline. Upload stays only when AI is on.

## Evidence Inventory (maps to Gaps)
This is a Jira "List" view.
- **Toolbar:** search, plus filters for domain, status, priority and setting, with "Clear" and an active-filter count.
- **Table:**
  - sortable columns
  - rows expand to show linked tactics as cards
  - status and priority are edited inline from dropdowns on the row
- **Add Gap modal:** title, domain, setting, impacted stakeholders (tag input), geography, source, status, priority and priority rationale.
- **Full-page gap edit:** everything above plus gap rationale, tactic objectives, notes, regional nuances (per country), impact areas and multiple sources.
- **Tactic assigner:** search the library, link or unlink tactics, and open a tactic detail side panel. The panel covers milestones, typed dependencies and data collection (source, population, method, endpoints).

## Prioritization Matrix (maps to Prioritize)
- **Axes:**
  - the X and Y axes are chosen from 8 options: strategic importance, unmet evidence need, stakeholder impact, regulatory risk, feasibility, time sensitivity, budget efficiency and competitive differentiation
  - setting chips ("All" plus each setting)
  - priority chips (Prioritize, Plan, Monitor, Defer, each with a count) that highlight their gaps
- **Quadrants:** PRIORITIZE (high), PLAN (medium), MONITOR (low) and DEFER (n/a).
- **Dragging:** a gap chip shows its coordinates while you drag it. On release, a **Rationale modal** shows the suggested priority and lets you pick High, Medium, Low or N/A and write a rationale.
- **Gap Index:** a side list you can also drag from, plus a dark tooltip on hover.

**Maps to:** `src/components/prioritize/*`. We already have per-setting axes, drag to place, and validate with a rationale.

## Tactic Ideation (maps to Tactics / ideation)
- **Which gaps appear:** only **High**-priority gaps, as collapsible cards. Filters are search, domain, and "No tactics yet" / "Has tactics".
- **Inside each card:**
  - linked tactics (click to edit in a side panel)
  - "Suggested · AI-assisted" cards, each with an Add button
  - a "+ Custom Tactic" form: name, type or a custom type with a colour, status, lead function, start and end quarter, budget and objective, plus a preview chip
- **Tactic Library:** a collapsible block with search, "+ New Tactic", an unassigned badge, the gaps each tactic is linked to, and Edit.

## Gantt Timeline (maps to Timeline)
- **Layout:** quarter columns grouped by year. Each gap is a header row (priority dot, id, title) with its tactic rows beneath.
- **Bars:**
  - coloured by tactic type
  - patterned by status (planned hatched, on-hold dark hatched, completed striped)
  - a "Today" line
- **Dependencies:** elbow arrows with a rationale on hover, and a toggle to show or hide them.
- **Filters:** All / High / High+Medium, plus setting chips.
- **Also:** a legend (type, status, markers) and a hover card (dates, budget, lead function).
- **Editing:** the design is **read-only**. Our timeline edits by drag or dialog (KAN-25) and must keep that.

## Data model gaps compared with Synapse
- **Gap:** impacted stakeholders, source(s), geography, regional nuances, impact areas, gap rationale, priority rationale, tactic objectives, notes, and a priority of `na`.
- **Tactic:** budget, lead function, vendor, geographies, assumptions, risks, impact summary, publication plan, milestones (readout, submission, interim, completion), and dependency types (finish-to-start, start-to-start, data-input, informs) each with a rationale. Also custom tactic types with a colour, and quarter-based dates.

## Conflicts with decisions already made (need the owner)
1. **Ideation scope:** the design shows High only. We changed ideation to cover every validated band after the run-through.
2. **Priority levels:** the design has 4 (adds Defer / N/A). We have 3.
3. **Quadrant auto-suggest:** the design suggests a priority from the quadrant, and the human confirms it with a rationale. That fits the "human decides" rule as long as it stays a suggestion that has to be confirmed.
4. **Timeline:** the design is read-only and uses quarters. We keep editing and day-level dates, and can show a quarter scale.
5. **"AI-assisted" suggestions** must come from the LLM (S9), never from a hard-coded table like the prototype's `DOMAIN_SUGGESTIONS`. With AI off they're hidden and only Custom Tactic remains.
