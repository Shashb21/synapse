/** Real PostgreSQL coverage for the presenter approval and the ordinary decision owner. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";

const cookies = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookies.has(name) ? { name, value: cookies.get(name)! } : undefined,
    set: (name: string, value: string) => { cookies.set(name, value); },
    delete: (name: string) => { cookies.delete(name); },
  }),
  headers: async () => new Headers(),
}));

import "@/modules";
import { GET as pending } from "@/app/api/demo/pending/route";
import { POST as demoPost } from "@/app/api/demo/ideation-approvals/route";
import { POST as planPost } from "@/app/api/plan/route";
import { db } from "@/lib/iegp/db";
import { suppliedJudgementRecords } from "@/lib/iegp/judgement-references";
import { createGap, createProposedTactic, loadState } from "@/lib/iegp/store";
import type { Role } from "@/modules/auth/roles";
import { createSession } from "@/modules/auth/session";
import { listAuditEvents } from "@/modules/kernel/audit";
import { listEdits } from "@/modules/kernel/edit-records";
import * as t from "@/modules/kernel/schema";
import { validatePlacement } from "@/modules/stages/s8-prioritization/module";
import { addIdeationProposal, editIdeationProposal, listIdeationProposals, type ProposalFields } from "@/modules/stages/s9-ideation/module";
import { replaceContentsOf } from "@/modules/workspaces/contents";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
import { createWorkspace, inviteMember, setWorkspaceDemoMode, withWorkspace, type Workspace } from "@/modules/workspaces/store";
import { priorityDecision } from "./support/priority-decision";

const key = crypto.randomUUID().slice(0, 8);
const email = `kan263-s9-${key}@example.com`;
const viewerEmail = `kan263-viewer-${key}@example.com`;
const actor = { name: "Velmara presenter", function: "medical_affairs" as const };
const rationale = "Reviewed alongside the other Velmara ideas";
const pg = postgres(process.env.DATABASE_URL!, { max: 1, connection: { client_min_messages: "warning" } });
let workspace: Workspace;
let gap: string;

const inDemo = <T,>(fn: () => Promise<T>) => withWorkspace(workspace.id, fn);

async function signIn(role: Role = "medical_affairs", address = email) {
  cookies.clear();
  const session = await createSession({
    provider_id: "demo", subject: address, email: address, actor_name: actor.name, actor_function: actor.function, role,
  });
  cookies.set(WORKSPACE_COOKIE, workspaceCookieValue(workspace.id, session.id));
}

async function modelIdea(fields: ProposalFields) {
  const proposal = await addIdeationProposal({ gap_id: gap, fields, rationale: "Recorded fictional support", actor });
  const [row] = await db().select().from(t.ideationProposals).where(eq(t.ideationProposals.id, proposal.id));
  const state = await loadState();
  await db().update(t.ideationProposals).set({ design: {
    ...(row.design as object), origin: "ai",
    supplied_records: suppliedJudgementRecords(state, [gap]),
    supporting_references: [{ entity_type: "gap", entity_id: gap, reason: "Supports the need for this fictional study" }],
  } }).where(eq(t.ideationProposals.id, proposal.id));
  return proposal.id;
}

const firstIdea = () => modelIdea({ name: "First study", type: "rwe_study", evidence_question: "What happens after relapse?", study_design: "Claims cohort" });
const secondIdea = () => modelIdea({ name: "Second study", type: "chart_review", evidence_question: "Where are patients treated?", study_design: "Chart review" });

async function review(ids: string[]) {
  const res = await inDemo(pending);
  expect(res.status).toBe(200);
  const checklist = await res.json();
  expect(checklist.workspace_id).toBe(workspace.id);
  const proposals: { id: string; name: string; version: string }[] = checklist.ideation.proposed;
  return ids.map(id => {
    const proposal = proposals.find(item => item.id === id);
    expect(proposal?.name).toBeTruthy();
    return { id, expected_version: proposal!.version };
  });
}

function request(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function approve(proposals: unknown[], extra: Record<string, unknown> = {}) {
  return inDemo(() => demoPost(request("/api/demo/ideation-approvals", { workspace_id: workspace.id, proposals, rationale, ...extra })));
}

async function decisionState() {
  const state = await inDemo(loadState);
  const proposals = await inDemo(listIdeationProposals);
  const edits = await inDemo(() => listEdits({ stage: "S9" }));
  const { events } = await listAuditEvents({ workspace_id: workspace.id, category: "plan" });
  return {
    tactics: state.tactics,
    expansions: state.expansions,
    coverage: state.coverages,
    proposals: proposals.map(({ id, version, status }) => ({ id, version, status })),
    edits: edits.filter(edit => edit.action === "accept"),
    audits: events.filter(event => event.action === "ideation_proposal.accept" || event.rationale === rationale),
  };
}

beforeAll(async () => {
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "0");
  workspace = await createWorkspace({ name: `KAN-263 Velmara batch ${key}`, owner: email });
  await inviteMember({ workspace_id: workspace.id, email: viewerEmail, by: email });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.end();
});

beforeEach(async () => {
  await replaceContentsOf(workspace.id, "client_demo", true);
  await signIn();
  gap = await inDemo(async () => {
    const id = await createGap({ statement: "Comparative evidence is unavailable in the fictional population.", actor_name: actor.name, actor_function: actor.function });
    await validatePlacement({ ...await priorityDecision(id, "This gap blocks the decision"), gap_id: id, band: "high", rationale: "This gap blocks the decision", actor });
    return id;
  });
});

describe("Velmara S9 approvals", () => {
  it("accepts a new study and a distinct expansion against the same opening context, with attributed audit history", async () => {
    const [first, expansion, unselected] = await inDemo(async () => {
      const parent = await createProposedTactic({
        name: "Existing fictional trial", type: "phase3_trial", description: "Original trial",
        evidence_question: "Overall safety", population: "Adults", intervention: "Velmara", comparator: "SOC", outcomes: "Safety",
        owner: actor.name, function: actor.function, residual_ids: [], status: "completed", actor_name: actor.name, actor_function: actor.function,
      });
      const first = await firstIdea();
      const scope = {
        name: "Elderly safety analysis", evidence_question: "What is safety in participants aged 75+?",
        population: "Age 75+", outcomes: "Adverse events", geography: "", data_cut: "Locked trial data",
        analysis: "Post-hoc subgroup", instrument: "", study_design: "Retrospective subgroup analysis",
        gap_coverage: "Estimates elderly safety", cost_effort: "Two analyst months", timing: "3 months + 1 month review",
        feasibility_risks: "Small subgroup", post_hoc: true, prospective_enrolment: false, protocol_amendment: false,
        start_date: null, evidence_available: null,
      };
      const expansion = await modelIdea({
        proposal_kind: "expansion", name: scope.name, evidence_question: scope.evidence_question, type: "subgroup_analysis",
        target_tactic_id: parent, expansion_scope: scope, duration_months: 3, readout_lag_months: 1,
        comparative_rationale: "Uses existing data to answer one part of the need",
      });
      return [first, expansion, await secondIdea()];
    });
    const selected = await review([first, expansion]);
    const opened = await inDemo(listIdeationProposals);
    expect(opened.find(proposal => proposal.id === first)?.supporting_context_basis)
      .toBe(opened.find(proposal => proposal.id === expansion)?.supporting_context_basis);
    const before = await decisionState();

    const result = await approve(selected);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, accepted: 2 });
    const after = await decisionState();
    expect(after.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first, status: "accepted" }),
      expect.objectContaining({ id: expansion, status: "accepted" }),
      expect.objectContaining({ id: unselected, status: "proposed" }),
    ]));
    expect(after.tactics).toHaveLength(before.tactics.length + 1);
    expect(after.expansions).toMatchObject([{ proposal_id: expansion, status: "proposed" }]);
    expect(after.coverage.map(row => row.overall)).toEqual(["unassessed", "unassessed"]);
    expect(after.edits).toHaveLength(2);
    for (const id of [first, expansion]) {
      expect(after.edits).toContainEqual(expect.objectContaining({
        entity_id: id, field: "supported_model_status", actor, actor_principal: email, rationale,
        supporting_references: [expect.objectContaining({ entity_id: gap })],
      }));
      expect(after.audits).toContainEqual(expect.objectContaining({
        action: "ideation_proposal.accept", entity_id: id, actor_name: actor.name, actor_principal: email, rationale,
      }));
    }
    expect((await approve(selected)).ok).toBe(false);
    expect(await decisionState()).toEqual(after);
  });

  it.each(["version", "basis", "supplied support"] as const)("leaves the whole selection unchanged when the second idea has stale %s", async problem => {
    const [first, second] = await inDemo(async () => [await firstIdea(), await secondIdea()]);
    let selected = await review([first, second]);
    await inDemo(async () => {
      if (problem === "version") {
        await editIdeationProposal({ id: second, fields: { idea_rationale: "Refined idea" }, rationale: "Changed the opening version", actor });
      } else {
        const [row] = await db().select().from(t.ideationProposals).where(eq(t.ideationProposals.id, second));
        const change = problem === "basis" ? { supporting_context_basis: "a".repeat(64) } : {
          supporting_references: [{ entity_type: "gap", entity_id: "unrelated-gap", reason: "Unavailable support" }],
        };
        await db().update(t.ideationProposals).set({ design: { ...(row.design as object), ...change } }).where(eq(t.ideationProposals.id, second));
      }
    });
    if (problem !== "version") selected = await review([first, second]);
    const before = await decisionState();
    const result = await approve(selected);
    expect(result.ok).toBe(false);
    const expected = { version: /opening snapshot/, basis: /context changed.*stale/i, "supplied support": /supporting references/i }[problem];
    expect((await result.json()).error).toMatch(expected);
    expect(await decisionState()).toEqual(before);
  });

  it("rejects duplicate selection and a signed-in viewer without deciding either idea", async () => {
    const [first, second] = await inDemo(async () => [await firstIdea(), await secondIdea()]);
    const selected = await review([first, second]);
    const before = await decisionState();
    const duplicate = await approve([selected[0], selected[1], selected[1]]);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "demo_ideation_selection" });
    await signIn("viewer", viewerEmail);
    const viewer = await approve(selected);
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toMatchObject({ code: "forbidden" });
    expect(await decisionState()).toEqual(before);
  });

  it("rejects two different proposal rows for the same new scientific design", async () => {
    const [first, duplicate] = await inDemo(async () => [
      await firstIdea(),
      await modelIdea({ name: "Alternative title", type: "rwe_study", evidence_question: "What happens after relapse?", study_design: "Claims cohort" }),
    ]);
    const before = await decisionState();
    const result = await approve(await review([first, duplicate]));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "demo_ideation_conflict" });
    expect(await decisionState()).toEqual(before);
  });

  it("rolls back the first tactic, its coverage and its audits when the second write fails", async () => {
    const [first, second] = await inDemo(async () => [await firstIdea(), await secondIdea()]);
    const selected = await review([first, second]);
    const before = await decisionState();
    await inDemo(() => db().execute(sql`ALTER TABLE ideation_proposals ADD CONSTRAINT kan263_test_fail_second
      CHECK (name <> 'Second study' OR status <> 'accepted')`));
    try {
      expect((await approve(selected)).ok).toBe(false);
      expect(await decisionState()).toEqual(before);
    } finally {
      await inDemo(() => db().execute(sql`ALTER TABLE ideation_proposals DROP CONSTRAINT kan263_test_fail_second`));
    }
  });

  it("reports a concurrent library writer and accepts the same selection after the workspace lock clears", async () => {
    const [first, second] = await inDemo(async () => [await firstIdea(), await secondIdea()]);
    const selected = await review([first, second]);
    const before = await decisionState();
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const holding = pg.begin(async tx => {
      await tx`set local search_path to ${tx(workspace.schema_name)}`;
      await tx`lock table tactics in row exclusive mode`;
      locked();
      await proceed;
    });
    try {
      await Promise.race([ready, holding]);
      const result = await approve(selected);
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ request_outcome: "rejected", code: "demo_ideation_busy" });
      expect(await decisionState()).toEqual(before);
    } finally {
      release();
      await holding;
    }
    expect((await approve(selected)).ok).toBe(true);
  });

  it("keeps the regular proposal route usable and requires separate renewed review when an earlier action changes the library", async () => {
    const [first, second] = await inDemo(async () => [await firstIdea(), await secondIdea()]);
    const selected = await review([first, second]);
    await setWorkspaceDemoMode(workspace.id, false);
    const decide = (choice: typeof selected[number], extra = {}) => inDemo(() => planPost(request("/api/plan", {
      action: "decide_proposal", ...choice, rationale, decision: "accept", ...extra,
    })));
    expect((await decide(selected[0])).status).toBe(200);
    const response = await decide(selected[1]);
    expect(response.ok).toBe(false);
    expect((await response.json()).error).toMatch(/context changed.*stale/i);
    const current = (await inDemo(listIdeationProposals)).find(proposal => proposal.id === second)!;
    expect((await decide(selected[1], { judgement_origin: "manual", reviewed_context_basis: current.current_context_basis })).status).toBe(200);
    const edits = await inDemo(() => listEdits({ stage: "S9", entity_id: second }));
    expect(edits.map(edit => edit.field)).toEqual(expect.arrayContaining(["renewed_context_review", "manual_status"]));
  });
});
