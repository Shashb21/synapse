# Gold set

Canonical gold for the Velmara seed. Source of truth is `GOLD_INSIGHTS` in `src/lib/seed/corpus.ts`. This file is the human-readable inventory and the scenario map. Protocol, pairing, and metrics: [06-eval-protocol.md](./06-eval-protocol.md).

**90** rows. **80** `must_find`. **7** source documents. All seven stakeholder functions.

Gold is a **scenario pack**, not a completeness proof for future decks.

## Sources

| ID | Function | File | What it is for |
| --- | --- | --- | --- |
| DOC-COM-001 | commercial | `Velmara_US_Brand_Plan_Q3_2026.pptx` | share, access delay, competitive, site-of-care gaps, WAC/340B, negation, ODAC conditional, chart SOV |
| DOC-MA-001 | market_access | `Velmara_Payer_AdBoard_Sep2026.pptx` | step edit, Medicaid, Horizon, IRA, AMCP, PA turnaround, copay law, 340B IDNs |
| DOC-MED-001 | medical_affairs | `Velmara_KOL_Insights_Q3_2026.docx` | CNS n=28, sequencing, resistance, ILD/QT, boxed-warning residual |
| DOC-CO-001 | clinops | `VEL-203_Enrollment_Dashboard_Sep2026.xlsx` | enrollment cells, diversity `table_cell`, NX-441 site pressure |
| DOC-MKT-001 | marketing | `Velmara_Unbranded_Campaign_Readout_Q3.pptx` | recall, NPS, spend shift, DTC/REMS, awareness chart |
| DOC-HEOR-001 | heor | `Velmara_HEOR_ICER_Pack_Sep2026.xlsx` | ICER, PSA, BIM 1%/3%, caregiver gap, WAC corroboration |
| DOC-REG-001 | regulatory | `Velmara_FDA_Interaction_Log_Q3_2026.docx` | PDUFA clock pause, CMC, PREA, ODAC, section 14, REMS ETASU |

## Scenario families

| Family | Gold examples | What eval should catch if the extractor fails |
| --- | --- | --- |
| Atomic split (`and both` / `and we`) | 005+006, 018+019, 042+043, 049+050 | partial mashed bullet, or one exact + one missed |
| Prose / unknown headings | 008–010, 016, 025, 039 | v1.0 miss (bullets only) |
| Tables / cells | 028–033, 063–066, 072–080 | v1.0/v1.1 miss |
| Chart / figure | 047, 061, 069 | miss unless gap-scan+ |
| Negation | 044, 054 | inverted “will pursue / will accept” would be **wrong** |
| Conditional | 045 | drop the ODAC trigger → partial |
| Named vs unspecified resistance | 025 vs 058 | pairing steal or a silent unspecified gap |
| Small-n / hypothesis-generating | 021, 059, 060, 087 | mash n=28 with ORR |
| Multi-theme | 006, 013, 039, 066, 090 | eval does not score themes; catalog does |
| Residual / Unassigned | 040, 041, 062, 082–086, 088 | emerge (REMS), not force-fit |
| Cross-doc corroboration | 042+078 (WAC), 012+073 (ICER), 016+080 (IRA), 040+041+088 (REMS) | `new` if wording drifts; corroboration is `knowledge_state`, not a theme |
| Cross-doc tension | 002 (PDUFA date) vs 081 (clock paused 21 days) | two knowns; do not collapse |
| Nice-to-have (`must_find: false`) | 037, 040, 041, 048, 065, 070, 071, 084, 085, 088 | can miss without tanking recall |
| `Dr.` period trap | 070 | `atomize` splits on `Dr. Hale` |

## Known champion misses

v1.2-gap-sensitive still misses these. Do not delete them to green the tape.

| ID | Must | Why it stays missed |
| --- | --- | --- |
| GOLD-018 | yes | Source is one mashed bullet with GOLD-019 (`want both CNS … and a budget-impact model`). `atomize` only splits `and both` / `and we`, not `want both X and Y`. One extract pairs with 019; 018 is unmatched. |
| GOLD-025 | yes | Unspecified resistance sits next to GOLD-058 (named C797S / MET). Greedy pairing can leave 025 unmatched when the extractor emits the named form more cleanly. |
| GOLD-070 | no | `Speaker bureau contract with Dr. Hale was declined` splits on `Dr.` + capital `Hale`. Nice-to-have. |

Fixing them is an extractor / `atomize` patch, then a re-sweep. Gold stays.

## Hygiene (locked)

`tests/req-eva-gold.test.ts` (TDD-EVA-03) and `tests/req-lock.test.ts` (REQ-EVA-001):

- Unique ids and unique statements
- Every row keys to an existing seed document
- Grounding vs **that** document ≥ 0.28
- No two rows ≥ 0.58 similar (exact-match alias)
- All seven stakeholder functions; known + unknown + opportunity
- Mix of `must_find` true/false; at least one multi-theme; at least one residual
- HEOR + Regulatory sources present; chart + figure + `table_cell` blocks exist
- Baseline extractor still misses (the pack must stay hard)

## How to add a row

1. Put the claim in a seed **block** first. Gold that is not in a source becomes a permanent miss.
2. One atomic statement, close to what `atomize` will emit (or the extractor will only partial-match).
3. Set `must_find: true` only if a VP briefing would be wrong without it.
4. `theme_ids[0]` = primary catalog object. Extra ids only when the claim truly sits on two decisions.
5. Run `npm test`. If the alias test fails, the new row is too close to an existing one — reword the **source and** the gold, not just the gold.
6. Reset seed (`POST /api/reset` or Ingest → Reset) so `/evals` re-sweeps.
7. Champion may drop. That is the point. Promote only through REQ-EVA-010.

Grounded `new` on the tape is a candidate, not an automatic append.

## Inventory

Theme names below are denormalized from `theme_ids` for reading. Membership at runtime is `theme_links`.

### DOC-COM-001 — commercial · Brand Plan Q3 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-001 | known | yes | Sequencing & resistance | Velmara (velmaratinib) is an oral EGFR TKI in development for 2L EGFRm NSCLC after osimertinib. |
| GOLD-002 | known | yes | Access & formulary | PDUFA is 14 Mar 2027; US launch is assumed Q2 2027. |
| GOLD-003 | known | yes | Access & formulary | Unrestricted access supports peak 18% share of 2L EGFRm NSCLC by year 5. |
| GOLD-004 | known | yes | Access & formulary | Share erodes to 11% if two of the top five national accounts remain non-formulary through year 2. |
| GOLD-005 | known | yes | Access & formulary | Formulary decisions at Aetna and UnitedHealthcare are delayed into Q1 2027. |
| GOLD-006 | known | yes | Evidence gaps; Access & formulary | Aetna and UnitedHealthcare have requested additional 6-month discontinuation RWE. |
| GOLD-007 | known | yes | Competitive dynamics | Next-generation EGFR-MET bispecific NX-441 is expected to file in 2027 and will contest the post-osimertinib setting. |
| GOLD-008 | unknown | yes | Community vs academic | Community oncology adoption versus academic centers remains unquantified. |
| GOLD-009 | unknown | yes | Community vs academic | There is no reliable split of 2L EGFRm treated lives by site of care. |
| GOLD-010 | unknown | yes | HCP engagement & messaging; Evidence gaps | Message testing of CNS differentiation has not been fielded. |
| GOLD-011 | opportunity | yes | Community vs academic | Stand up a community-focused peer-to-peer program before the first NPP to close the site-of-care evidence gap. |
| GOLD-040 | unknown | no | Unassigned | FDA has not confirmed whether velmaratinib will require a REMS. |
| GOLD-042 | known | yes | Pricing & policy; Access & formulary | WAC is set at $18,400 per 28-day cycle. |
| GOLD-043 | known | yes | Access & formulary; Pricing & policy | Both national accounts have asked for a 340B discount policy before P&T. |
| GOLD-044 | known | yes | Sequencing & resistance | Velmara will not pursue a 1L EGFRm NSCLC indication in this planning cycle. |
| GOLD-045 | known | yes | HCP engagement & messaging; Evidence gaps | If ODAC votes negatively, launch messaging will drop CNS differentiation claims. |
| GOLD-046 | unknown | yes | Competitive dynamics; Pricing & policy | Peak share impact in year 3 is not modeled. |
| GOLD-047 | known | yes | HCP engagement & messaging; Community vs academic | Share of voice among community oncologists is 9% versus 31% in academic centers. |
| GOLD-048 | known | no | HCP engagement & messaging | Kantar Q2 2026 wave, n=142 community oncologists. |
| GOLD-049 | known | yes | Access & formulary | Sample program start is Q1 2027. |
| GOLD-050 | unknown | yes | Access & formulary | We do not have a free-goods cap. |

### DOC-MA-001 — market access · Payer ad board Sep 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-012 | known | yes | Pricing & policy | ICER-style cost-effectiveness versus chemo-plus-IO is the dominant objection among national pharmacy directors. |
| GOLD-013 | known | yes | Access & formulary; Evidence gaps | Payers will impose a step edit through osimertinib plus documented progression unless CNS and discontinuation data are in the AMCP dossier. |
| GOLD-014 | known | yes | Access & formulary | Medicaid plans in Texas, Florida, and New York flagged high risk of preferred-product step therapy. |
| GOLD-015 | opportunity | yes | Access & formulary | Horizon signaled openness to an outcomes-based contract tied to 6-month persistence. |
| GOLD-016 | unknown | yes | Pricing & policy | Impact of CMS IRA negotiation eligibility on net price in year 3 is not modeled. |
| GOLD-017 | unknown | yes | Evidence gaps; Access & formulary | No payer-ready RWE protocol exists for real-world discontinuation at 6 months. |
| GOLD-018 | known | yes | Evidence gaps; Access & formulary | National accounts want CNS metastases subgroup data. |
| GOLD-019 | known | yes | Pricing & policy; Access & formulary | National accounts want a budget-impact model at 1% and 3% uptake. |
| GOLD-051 | known | yes | Access & formulary; Community vs academic | Prior authorization median turnaround is 11 days in community practices versus 4 days in academic centers. |
| GOLD-052 | unknown | yes | Access & formulary; Pricing & policy | Medicare Part D copay-card stacking legality remains unspecified. |
| GOLD-053 | known | yes | Access & formulary; Pricing & policy | Two IDNs (AdventHealth and CommonSpirit) requested 340B ceiling-price language in the contract. |
| GOLD-054 | known | yes | Access & formulary | Payers will not accept the Horizon outcomes-based contract as a national template. |
| GOLD-055 | unknown | yes | Pricing & policy; Access & formulary | Budget-impact at 5% uptake was requested but is not in the current AMCP dossier. |

### DOC-MED-001 — medical affairs · KOL insights Q3 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-020 | known | yes | Evidence gaps | KOLs consistently asked for intracranial activity data. |
| GOLD-021 | known | yes | Evidence gaps | The current clinical package has limited brain-mets representation (n=28). |
| GOLD-022 | known | yes | Sequencing & resistance | Sequencing after osimertinib failure is the decision that will determine use. |
| GOLD-023 | known | yes | Sequencing & resistance | T790M is not the relevant question in 2L post-osi. |
| GOLD-024 | known | yes | Community vs academic; Sequencing & resistance | Community biomarker testing still misses liquid biopsy in about 30% of progressing patients in the Southeast. |
| GOLD-025 | unknown | yes | Sequencing & resistance | Some KOLs mentioned resistance mutations without specifying which alterations should trigger Velmara versus a clinical trial. |
| GOLD-026 | opportunity | yes | Sequencing & resistance | Opportunity to fund a medical education series on post-osi resistance testing. |
| GOLD-027 | unknown | yes | Evidence gaps | Unknown whether KOLs will accept tumor-agnostic EGFR exon 20 data as supportive. |
| GOLD-041 | unknown | no | Unassigned | A REMS for velmaratinib remains unspecified, with no elements proposed. |
| GOLD-056 | known | yes | Evidence gaps | Treatment-emergent ILD occurred in 2.1% of treated patients, including one grade 5 event. |
| GOLD-057 | unknown | yes | Evidence gaps | QT prolongation has not been pooled across the two phase 2 cohorts. |
| GOLD-058 | unknown | yes | Sequencing & resistance | KOLs named C797S and MET amplification as possible resistance without a treatment algorithm. |
| GOLD-059 | known | yes | Evidence gaps | Intracranial ORR is 38% in the n=28 brain-mets subset. |
| GOLD-060 | known | yes | Evidence gaps | KOLs called that intracranial result hypothesis-generating, not confirmatory. |
| GOLD-061 | unknown | yes | Evidence gaps; Pricing & policy | No head-to-head data versus chemo-plus-IO exist in 2L EGFRm NSCLC. |
| GOLD-062 | unknown | yes | Unassigned | Medical affairs cannot yet say whether interstitial lung disease will force a boxed warning in the USPI. |

### DOC-CO-001 — clinops · VEL-203 enrollment Sep 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-028 | known | yes | Trial execution | Protocol VEL-203 is at 281 enrolled of 420 target (67%) at month 14. |
| GOLD-029 | known | yes | Trial execution | Screen fail rate is 41%, primary reason prior TKI washout window. |
| GOLD-030 | known | yes | Trial execution | Southern EU site activation is 4.2 months versus 2.1 months in the US. |
| GOLD-031 | opportunity | yes | Trial execution | Protocol amendment to allow concurrent biopsy during washout. |
| GOLD-032 | unknown | yes | Competitive dynamics; Trial execution | Impact of competing NX-441 phase 3 on remaining US sites is unknown. |
| GOLD-033 | known | yes | Trial execution | Japan first-patient-in slipped from May to September 2026. |
| GOLD-063 | known | yes | Trial execution; Community vs academic | Hispanic / Latino enrollment is 8% versus 18% US EGFRm incidence. |
| GOLD-064 | known | yes | Trial execution; Evidence gaps | Untreated brain metastases account for 14% of screen fails. |
| GOLD-065 | unknown | no | Trial execution | China CTA approval has not been filed. |
| GOLD-066 | opportunity | yes | Trial execution; Competitive dynamics; Community vs academic | Open two additional community sites in Florida to offset NX-441 competition. |

### DOC-MKT-001 — marketing · Unbranded campaign Q3 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-034 | known | yes | HCP engagement & messaging | Unbranded disease-awareness impressions over-index 3.2x in academic versus community settings. |
| GOLD-035 | known | yes | HCP engagement & messaging | Message recall is 64% for once-daily oral and 19% for CNS coverage. |
| GOLD-036 | unknown | yes | HCP engagement & messaging | Patient support program NPS is not measured. |
| GOLD-037 | known | no | HCP engagement & messaging | HCP email open rate is 28% versus a 22% benchmark. |
| GOLD-038 | opportunity | yes | Community vs academic; HCP engagement & messaging | Shift 40% of unbranded spend to community oncology networks in Texas, Florida, and Ohio. |
| GOLD-039 | unknown | yes | HCP engagement & messaging; Sequencing & resistance; Competitive dynamics | Unknown whether the post-osi sequencing message is differentiated versus competitor unbranded campaigns. |
| GOLD-067 | known | yes | HCP engagement & messaging | Patient advocacy asked for ILD counseling materials before any branded launch. |
| GOLD-068 | unknown | yes | HCP engagement & messaging | DTC spend is paused until FDA confirms whether a REMS is required. |
| GOLD-069 | known | yes | HCP engagement & messaging; Community vs academic | Unaided awareness of post-osi options is 22% in community versus 61% academic. |
| GOLD-070 | known | no | HCP engagement & messaging | Speaker bureau contract with Dr. Hale was declined. |
| GOLD-071 | known | no | HCP engagement & messaging | No replacement KOL is booked for Q4. |

### DOC-HEOR-001 — HEOR · ICER pack Sep 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-072 | known | yes | Pricing & policy | Base-case ICER versus chemo-plus-IO is $247,000 per QALY. |
| GOLD-073 | known | yes | Pricing & policy | ICER exceeds the $150,000 per QALY threshold used by national pharmacy directors. |
| GOLD-074 | known | yes | Pricing & policy | Probabilistic sensitivity analysis puts the probability of cost-effectiveness at 18% at $150,000/QALY. |
| GOLD-075 | known | yes | Pricing & policy; Access & formulary | Budget impact at 1% uptake is $42 million. |
| GOLD-076 | known | yes | Pricing & policy; Access & formulary | Budget impact at 3% uptake is $119 million. |
| GOLD-077 | unknown | yes | Pricing & policy | Caregiver productivity offsets are not modeled. |
| GOLD-078 | known | yes | Pricing & policy | WAC of $18,400 per cycle is the HEOR list-price assumption. |
| GOLD-079 | opportunity | yes | Pricing & policy; Access & formulary | Convene an ICER engagement before the AMCP dossier lock in November 2026. |
| GOLD-080 | unknown | yes | Pricing & policy | Unknown whether CMS IRA negotiation in year 3 would rebase the ICER below threshold. |

### DOC-REG-001 — regulatory · FDA interaction log Q3 2026

| ID | Class | Must | Themes | Statement |
| --- | --- | --- | --- | --- |
| GOLD-081 | known | yes | Pricing & policy | The PDUFA clock is paused 21 days pending a late CMC information request. |
| GOLD-082 | unknown | yes | Unassigned | FDA has not confirmed a boxed warning for ILD. |
| GOLD-083 | known | yes | Unassigned | The 12-month primary stability package is incomplete for two process-validation lots. |
| GOLD-084 | known | no | Unassigned | PREA pediatric deferral has been requested. |
| GOLD-085 | unknown | no | Unassigned | FDA response is outstanding. |
| GOLD-086 | unknown | yes | Unassigned | An ODAC date has not been scheduled. |
| GOLD-087 | unknown | yes | Evidence gaps | FDA asked whether the n=28 intracranial subset will appear in section 14 of labeling. |
| GOLD-088 | unknown | no | Unassigned | A REMS with ETASU has not been proposed by the sponsor. |
| GOLD-089 | opportunity | yes | Evidence gaps | Request a Type B meeting on the CNS subgroup before label negotiations. |
| GOLD-090 | unknown | yes | Evidence gaps; Sequencing & resistance | Unknown whether FDA will allow tumor-agnostic EGFR exon 20 data in the clinical studies section. |
