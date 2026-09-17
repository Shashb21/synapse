# Synapse IEGP: problem statement and proposed solution

Status: v1 product paper for the digital **Integrated Evidence Generation Plan (IEGP)**. Locked model: [`iegp-model.md`](iegp-model.md). Historical CIR/theme SDLC pack remains under [`sdlc/`](sdlc/) as design lineage, not the live system of record.

Demo corpus is fictional (Velmara / velmaratinib). No real patient or payer data.

---

## 1. Problem statement

Cross-functional pharmaceutical teams (Clinical Development, Medical Affairs, HEOR, RWE, Market Access, Regulatory, Commercial, affiliates, KOLs, payers, HTA) must answer:

**What does the organisation need to know, why, what evidence already exists or is being generated, what remains unresolved, which residual needs matter most, and what should be done about them?**

Today that work lives in static gap spreadsheets, study trackers, and slideware. Those tools fail in the same ways Synapse already refused for insights:

- A stakeholder quote (“we don’t have enough evidence in elderly patients”) is treated as a **validated gap** instead of a **candidate need**.
- A tactic that **exists** (a chart review, a publication, a registry) is treated as a gap that is **closed**.
- One registry that collects treatment, OS, HCRU and PROs is copied onto four gap rows, or forced into a single theme.
- When coverage is partial, teams overwrite the original gap instead of keeping a residual with an audit trail.
- Coverage is confused with **priority**. An 80%-covered HTA question can still be the most important residual; a 10%-covered curiosity is not.

The unit of work is not a document, a study, or a cluster. It is an **atomic evidence need**, joined onto a named **gap**, mapped to **tactics** with dimensional coverage, leaving a **residual** that can be prioritised onto a **roadmap**.

---

## 2. What we refuse (Synapse principles, IEGP objects)

| Refusal | IEGP consequence |
| --- | --- |
| Nested document trees as the store | Needs, gaps, tactics, coverages are flat rows plus joins. |
| Embedding clusters as the catalog | Gaps are named decision objects a TA lead can brief. IDs do not drift. |
| Copying the sentence onto every gap or tactic | `need_gap_links` and `coverages` store IDs. The statement lives once. |
| Auto-naming / auto-closing | Humans lock every gate. Engine drafts; it does not write Addressed. |
| Overwriting the parent when residual | Original gap remains. Residual is a child. |
| “A tactic exists” = “the gap is closed” | Ten coverage dimensions + overall degree. |
| Coverage = priority | Separate locked band on the residual. Effort/cost sit on the tactic. |
| Publications as non-objects | Generation and dissemination are both tactics; dissemination can be `not_relevant` for coverage. |

---

## 3. Proposed solution

Synapse IEGP is a **dynamic evidence-planning system**:

Strategic objectives → sources → extracted gaps + tactics → residual drafts → human accept/reject/modify → human priority → create/assign tactics → High/Medium/Low plan + addressed → stale-and-re-lock monitoring.

### IEGP process (new plan)

```mermaid
flowchart TD
  upload["1. Upload sources"]
  extract["2. Extract gaps and tactics"]
  residual["3. Draft residual evidence needs"]
  openlist["4. List open gaps + residuals"]
  decide{"5. Accept, reject, or modify"}
  pri["6. Human locks priority"]
  assign["7. Create or assign tactics"]
  board["8. High / Medium / Low"]
  closed["Addressed gaps with tactics"]
  upload --> extract
  extract --> residual
  residual --> openlist
  openlist --> decide
  decide -->|modify| openlist
  decide -->|reject| openlist
  decide -->|accept| pri
  pri --> assign
  assign --> board
  board --> closed
```

The engine never assigns the priority band. Extracted tactics wait until after that lock. Addressed gaps remain on the plan.

### Traceability

Source → candidate need → gap → associated tactics → coverage → residual → priority → proposed tactic → owner/timing → roadmap.

### Candidate vs gap

Interview: “We don’t have enough evidence in elderly patients.”

The system extracts a **candidate evidence need** and a **candidate gap**, plus a residual draft. It does not accept the gap. Pressure-test against TLR, CDP, RWE, and tactics comes next. Only a human accept / reject / modify moves that gap onto priority.

### Worked mapping (Velmara seed)

Gap: comparative effectiveness of velmaratinib vs regional SoC in elderly advanced EGFR-mutant NSCLC.

Tactic: retrospective RWE in patients aged ≥65, no comparator.

| Dimension | Assessment |
| --- | --- |
| Population | Yes |
| Intervention | Yes |
| Comparator | No |
| Outcomes | Yes |
| Comparative effectiveness / decision utility | No |
| **Overall** | **Partial** |

Residual (parent preserved): comparative outcomes versus relevant regional SoC in elderly patients remain insufficiently characterised.

Priority: human-locked High (HTA decision date, uncovered comparator). The engine does not propose a band.

### One tactic, several gaps

The prospective Velmara registry maps to sequencing, HCRU and QoL. That synergy is visible because membership is a join, not a copy.

```mermaid
flowchart TD
  reg["Prospective Velmara registry"]
  seq["Gap: treatment sequencing"]
  hcru["Gap: HCRU"]
  qol["Gap: QoL / PRO"]
  elderly["Gap: elderly vs SoC"]
  reg --> seq
  reg --> hcru
  reg --> qol
  elderly -.->|"chart review only, no comparator"| partial["Overall: partial"]
```

### Priority (locked)

Humans lock High / Medium / Low. The engine does not assign a band. Effort and cost live on the tactic. Engine never places a residual on the roadmap.

### Refresh

Living plan. Tactic status change or ingest marks coverage stale and queues residuals for re-lock. Nothing auto-closes.

---

## 4. v1 slice

Shipped on Postgres with a rich Velmara seed (objectives, interviews, TLR, CDP/HEOR/RWE sources, 20+ needs, 12 gaps, 12 tactics, dimensional mappings, residuals, priorities, forward roadmap).

Not in v1: login, AI tactic ideation, multi-asset/franchise overlays, annual snapshots, embedding catalog.

Run: `npm install && npm test && npm run dev` after Postgres (`DATABASE_URL`). App: [http://127.0.0.1:43217](http://127.0.0.1:43217).
