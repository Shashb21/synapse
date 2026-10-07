import { describe, expect, it } from "vitest";
import { POST as createClaim } from "@/app/api/accuracy/claims/route";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks, deleteParseBlock } from "@/accuracy/store/parse-store";
import { ownerAccess } from "@/modules/auth/owner";
import { emptyTacticStructuredFields } from "@/accuracy/domain/structured-fields";
import { createManualClaim } from "@/accuracy/store/claim-edit";
import { accuracyDb } from "@/accuracy/store/db";
import { accuracyProvenance } from "@/accuracy/store/schema";
import { eq } from "drizzle-orm";
import { insertClaim, listClaims } from "@/accuracy/store/claim-store";

async function fixture() {
  const org_id = await createOrganization(`creation-${crypto.randomUUID()}`);
  const workspace_id = await createWorkspace({ org_id, name: "Claim creation", slug: crypto.randomUUID() });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "owners.txt", mime: "text/plain",
    checksum: crypto.randomUUID(), doc_role: "medical" });
  const block_id = `${source.id}-B001`;
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "local_structured",
    blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Ada owns the registry." }] });
  return { workspace_id, source_file_id: source.id, block_id };
}

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/accuracy/claims", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// A missing effective-payload guard would store and index this fabricated known fact.
describe("structured claim creation boundary", () => {
  it("refuses fabricated metadata evidence on manual creation without writing a claim or provenance", async () => {
    const source = await fixture();
    const response = await createClaim(request({ ...source, claim_type: "tactic", statement: "Registry",
      rationale: "Entered from the source", metadata: { structured: { version: 1,
        owner: { state: "known", value: "Ada", provenance: [{ ...source, quote: "Fabricated owner" }] } } } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/structured\.owner.*quote_not_substring/) });
    expect(await listClaims(source.workspace_id)).toHaveLength(0);
    // Orphan provenance would prevent removal through the production parse owner.
    await expect(deleteParseBlock({ workspace_id: source.workspace_id, block_id: source.block_id,
      rationale: "No accepted claim cites this block", actor: { name: "Ada", function: "medical_affairs" } })).resolves.toBeDefined();
  });

  it.each(["manual", "raw"] as const)("accepts valid complete metadata facts on %s creation", async (path) => {
    const source = await fixture();
    const span = { source_file_id: source.source_file_id, block_id: source.block_id, quote: "Ada owns the registry" };
    const response = await createClaim(request({ workspace_id: source.workspace_id, source_file_id: source.source_file_id,
      claim_type: "tactic", statement: "Registry", ...(path === "manual" ? { rationale: "Confirmed against the source" } : {}),
      metadata: { structured: { version: 1, owner: { state: "known", value: "Ada", provenance: [span] } } } }));
    expect(response.status).toBe(200);
    const claims = await listClaims(source.workspace_id);
    expect(claims).toHaveLength(1);
    expect(claims[0].validated).toBe(false);
    expect(claims[0].metadata).toMatchObject({ structured: { owner: { state: "known", value: "Ada", provenance: [span] } } });
    await expect(deleteParseBlock({ workspace_id: source.workspace_id, block_id: source.block_id,
      rationale: "Cited evidence stays protected", actor: { name: "Ada", function: "medical_affairs" } })).rejects.toThrow(/quote|claim/i);
  });

  it.each([
    ["manual", "foreign", /source_file_mismatch/], ["raw", "foreign", /source_file_mismatch/],
    ["raw", "fabricated", /quote_not_substring/],
    ["manual", "malformed", /owner|structured/], ["raw", "malformed", /owner|structured/],
  ] as const)("refuses %s creation with %s metadata evidence and leaves no side effects", async (path, defect, reason) => {
    const source = await fixture();
    const citedSource = defect === "foreign" ? await fixture() : source;
    const owner = defect === "malformed" ? { state: "known", value: "Ada", provenance: [] }
      : { state: "known", value: "Ada", provenance: [{ source_file_id: citedSource.source_file_id,
        block_id: citedSource.block_id, quote: defect === "fabricated" ? "Fabricated owner" : "Ada owns the registry" }] };
    const response = await createClaim(request({ workspace_id: source.workspace_id, source_file_id: source.source_file_id,
      claim_type: "tactic", statement: "Registry", ...(path === "manual" ? { rationale: "Confirmed against the source" } : {}),
      metadata: { structured: { version: 1, owner } } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(reason) });
    expect(await listClaims(source.workspace_id)).toHaveLength(0);
    const citations = await accuracyDb().select().from(accuracyProvenance).where(eq(accuracyProvenance.workspace_id, source.workspace_id));
    expect(citations).toHaveLength(0);
  });

  it("validates the complete effective manual payload even when a different typed field is supplied", async () => {
    const source = await fixture();
    await expect(createManualClaim({ workspace_id: source.workspace_id, claim_type: "tactic", statement: "Registry",
      rationale: "Confirmed against the source", actor: { name: "Ada", function: "medical_affairs" },
      metadata: { structured: { ...emptyTacticStructuredFields(), owner: { state: "known", value: "Ada", provenance: [{
        source_file_id: source.source_file_id, block_id: source.block_id, quote: "Fabricated owner" }] } } },
      fields: { structured: { objective: { state: "unknown", value: null, reason: "not_stated", provenance: [] } } },
    })).rejects.toThrow(/structured\.owner.*quote_not_substring/);
    expect(await listClaims(source.workspace_id)).toHaveLength(0);
  });


  it.each([
    ["raw", { validated: true }], ["raw", { status: "validated" }],
    ["raw", { metadata: { validation: { action: "validate", by: "Forged actor", rationale: "Client sign-off" } } }],
    ["manual", { metadata: { validation: { action: "validate", by: "Forged actor", rationale: "Client sign-off" } } }],
  ] as const)("requires the validation gate for new %s structured facts with client decision %j", async (path, decision) => {
    const source = await fixture();
    const response = await createClaim(request({ workspace_id: source.workspace_id, claim_type: "tactic", statement: "Registry",
      ...(path === "manual" ? { rationale: "Confirmed against the source" } : {}), ...decision,
      metadata: { ...("metadata" in decision ? decision.metadata : {}), structured: { version: 1,
        owner: { state: "known", value: "Ada", provenance: [{ source_file_id: source.source_file_id,
          block_id: source.block_id, quote: "Ada owns the registry" }] } } } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/validation gate/i) });
    expect(await listClaims(source.workspace_id)).toHaveLength(0);
    expect(await accuracyDb().select().from(accuracyProvenance).where(eq(accuracyProvenance.workspace_id, source.workspace_id))).toHaveLength(0);
  });

  it("preserves typed manual field locks, siblings and authenticated actor/rationale", async () => {
    const source = await fixture();
    const actor = (await ownerAccess()).actor;
    const span = { source_file_id: source.source_file_id, block_id: source.block_id, quote: "Ada owns the registry" };
    const response = await createClaim(request({ workspace_id: source.workspace_id, claim_type: "tactic", statement: "Registry",
      rationale: "Owner confirmed against the source", actor_name: "Forged actor", actor_function: "market_access",
      metadata: { structured: { version: 1, objective: { state: "known", value: "Registry", provenance: [span] } } },
      fields: { structured: { owner: { state: "known", value: "Ada", provenance: [span] } } } }));
    expect(response.status).toBe(200);
    const [claim] = await listClaims(source.workspace_id);
    expect(claim.validated).toBe(false);
    expect(claim.metadata).toMatchObject({ human_locked: ["statement", "structured.owner"],
      structured: { owner: { value: "Ada" }, objective: { value: "Registry" } },
      edit_history: [{ by: actor.name, by_function: actor.function, rationale: "Owner confirmed against the source" }] });
  });

  it.each(["manual", "raw"] as const)("keeps ordinary legacy %s API creation compatible", async (path) => {
    const source = await fixture();
    const response = await createClaim(request({ workspace_id: source.workspace_id, claim_type: "gap", statement: "Legacy gap",
      ...(path === "manual" ? { rationale: "Added during review" } : { validated: true }), metadata: { chapter: "Clinical" } }));
    expect(response.status).toBe(200);
    const [claim] = await listClaims(source.workspace_id);
    expect(claim.statement).toBe("Legacy gap");
    expect(claim.validated).toBe(path === "raw");
    expect(claim.metadata).toMatchObject({ chapter: "Clinical" });
  });

  it("retains trusted internal fixture insertion independently of request evidence checks", async () => {
    const source = await fixture();
    const claim = await insertClaim({ workspace_id: source.workspace_id, claim_type: "tactic", statement: "Fixture",
      validated: true, metadata: { structured: { ...emptyTacticStructuredFields(),
        owner: { state: "known", value: "Fixture owner", provenance: [{ source_file_id: source.source_file_id,
          block_id: source.block_id, quote: "Trusted fixture quote" }] } } } });
    expect((await listClaims(source.workspace_id))[0]).toMatchObject({ id: claim.id, validated: true });
  });

});
