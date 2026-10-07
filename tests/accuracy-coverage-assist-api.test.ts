import { describe, expect, it } from "vitest";
import { POST as assistPost } from "@/app/api/accuracy/coverage/assist/route";
import { registerAccuracyStack } from "@/accuracy";
import { insertClaim, persistClaimPatch } from "@/accuracy/store/claim-store";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { GET as coverageGet, POST as coveragePost } from "@/app/api/accuracy/coverage/route";
import { coveragePairRevisions, listCoverageJoins } from "@/accuracy/store/coverage-store";

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
  return { org_id, workspace_id };
}

async function postAssist(body: Record<string, unknown>) {
  return assistPost(
    new Request("http://localhost/api/accuracy/coverage/assist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("accuracy coverage assist API", () => {
  it("rejects unknown workspace and mismatched claim types", async () => {
    registerAccuracyStack();
    const missing = await postAssist({
      workspace_id: "ws-missing",
      gap_id: "gap_x",
      tactic_id: "tac_x",
    });
    expect(missing.status).toBe(404);

    const { workspace_id } = await freshWorkspace("cov-assist-bad");
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS data",
    });
    const badType = await postAssist({
      workspace_id,
      gap_id: gap.id,
      tactic_id: gap.id,
    });
    expect(badType.status).toBe(400);
    const body = (await badType.json()) as { error?: string };
    expect(body.error).toMatch(/tactic/i);
  });

  it("returns stub suggestion under SYNAPSE_TEST_STUB_LLM without persisting", async () => {
    expect(process.env.SYNAPSE_TEST_STUB_LLM).toBe("1");
    registerAccuracyStack();
    const { workspace_id, org_id } = await freshWorkspace("cov-assist-stub");
    const source = await insertSourceFile({ workspace_id, org_id, filename: "coverage.txt", mime: "text/plain", checksum: crypto.randomUUID() });
    const B1 = `${source.id}-B1`, B2 = `${source.id}-B2`;
    await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "fixture", blocks: [
      { id: B1, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Need OS" },
      { id: B2, source_file_id: source.id, index: 1, kind: "prose", heading: null, text: "Registry" },
    ] });
    const gap = await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need comparative OS in 1L NSCLC",
      metadata: {
        provenance: [{ source_file_id: source.id, block_id: B1, quote: "Need OS" }],
      },
    });
    const tactic = await insertClaim({
      workspace_id,
      claim_type: "tactic",
      statement: "VEL-REG-01",
      metadata: {
        provenance: [{ source_file_id: source.id, block_id: B2, quote: "Registry" }],
        gap_ids: [gap.id],
      },
    });

    const res = await postAssist({
      workspace_id,
      gap_id: gap.id,
      tactic_id: tactic.id,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok?: boolean;
      mode?: string;
      suggestion?: {
        overall: string;
        schema_overall: string;
        rationale: string;
        confidence: number;
      };
      block_bundle_ids?: string[];
    };
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("stub");
    expect(json.suggestion?.schema_overall).toBe("not_relevant");
    expect(json.suggestion?.overall).toBe("not_relevant");
    expect(json.suggestion?.confidence).toBe(0);
    expect(json.block_bundle_ids).toEqual([B1, B2]);
    expect(await listCoverageJoins(workspace_id)).toEqual([]);
  });

  it("pages the coverage API and confirms Limited against explicit facts without trusting actor_name", async () => {
    const { workspace_id } = await freshWorkspace("cov-api-revisions");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need OS" });
    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Registry" });
    await insertClaim({ workspace_id, claim_type: "tactic", statement: "Fourth/unlinked" });
    const response = await coverageGet(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${workspace_id}&page_size=1`));
    const page = await response.json();
    expect(page.pairs).toHaveLength(1);
    expect(page.progress).toMatchObject({ eligible_total: 2, pending: 2, validated: 0 });
    expect(page.next_cursor).toEqual(expect.any(String));
    const identity = { workspace_id, gap_id: gap.id, tactic_id: tactic.id };
    async function decide(body: Record<string, unknown>) {
      return coveragePost(new Request("http://localhost/api/accuracy/coverage", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    }
    expect((await decide({ ...identity, overall: "limited", rationale: "Small overlap" })).status).toBe(409);
    const revisions = await coveragePairRevisions(identity);
    expect((await decide({ ...identity, ...revisions, overall: "limited", rationale: "Small overlap",
      evidence: ["outside"], actor_name: "Impersonated" })).status).toBe(400);
    expect(await listCoverageJoins(workspace_id)).toEqual([]);
    expect((await decide({ ...identity, ...revisions, overall: "limited", rationale: "Small overlap", evidence: [] })).status).toBe(200);
    const [saved] = await listCoverageJoins(workspace_id);
    expect(saved).toMatchObject({ overall: "limited", validated: true });
    expect((saved.dimensions as { actor: { name: string } }).actor.name).not.toBe("Impersonated");
  });

  it("refuses a provenance override outside the pair before invoking assist", async () => {
    const { workspace_id } = await freshWorkspace("cov-assist-provenance");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need OS" });
    const tactic = await insertClaim({ workspace_id, claim_type: "tactic", statement: "Registry" });
    const response = await postAssist({ workspace_id, gap_id: gap.id, tactic_id: tactic.id, block_bundle_ids: ["foreign-block"] });
    expect(response.status).toBe(400);
    expect(await listCoverageJoins(workspace_id)).toEqual([]);
  });

  it("resumes assessment pages independently of validation and returns actionable stale cursor errors", async () => {
    const { workspace_id } = await freshWorkspace("cov-assess-pages");
    const gap = await insertClaim({ workspace_id, claim_type: "gap", statement: "Need OS" });
    for (let n = 0; n < 4; n++) await insertClaim({ workspace_id, claim_type: "tactic", statement: `Inventory ${n}` });
    async function assess(cursor?: string) {
      return coveragePost(new Request("http://localhost/api/accuracy/coverage", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "assess", workspace_id, cursor, page_size: 2 }) }));
    }
    const firstResponse = await assess();
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.pairs).toHaveLength(2);
    expect(first.pairs.every((p: { validated: boolean }) => !p.validated)).toBe(true);
    expect(first.progress).toMatchObject({ eligible_total: 4, assessed: 2, pending: 2, validated: 0 });
    const second = await (await assess(first.next_cursor)).json();
    expect(second.next_cursor).toBeNull();
    expect(second.progress).toMatchObject({ assessed: 4, pending: 0, assessment_complete: true, validation_complete: false });
    expect((await (await assess()).json()).attempts).toEqual([]);
    await persistClaimPatch({ workspace_id, claim_id: gap.id, statement: "Changed evidence need" });
    const changed = await coverageGet(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${workspace_id}&cursor=${encodeURIComponent(first.next_cursor)}`));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "stale_snapshot", restart_without_cursor: true } });
    const restarted = await (await coverageGet(new Request(`http://localhost/api/accuracy/coverage?workspace_id=${workspace_id}`))).json();
    expect(restarted.progress).toMatchObject({ eligible_total: 4, pending: 4, stale: 4 });
  });
});
