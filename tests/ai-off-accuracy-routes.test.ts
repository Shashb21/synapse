import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAccuracyStack } from "@/accuracy";
import { POST as extractPost } from "@/app/api/accuracy/extract/route";
import { GET as reviewGet } from "@/app/api/accuracy/review/route";
import { POST as assistPost } from "@/app/api/accuracy/coverage/assist/route";
import { POST as ideatePost } from "@/app/api/accuracy/ideate/route";
import { POST as seedPost } from "@/app/api/accuracy/seed/route";
import { insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { listCompletenessVerdicts } from "@/accuracy/store/completeness-verdict-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { sql } from "drizzle-orm";
import { listAccuracyRuns } from "@/accuracy/kernel/observability";
import { AI_OFF_MESSAGE, setAiEnabled } from "@/modules/kernel/ai-switch";

registerAccuracyStack();

const ADMIN = "AI-off accuracy test";

async function workspaceWithBlocks(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  const source = await insertSourceFile({
    workspace_id,
    org_id,
    filename: "plan.txt",
    mime: "text/plain",
    checksum: `chk-${label}-${Date.now()}`,
    doc_role: "medical",
  });
  await persistParseBlocks({
    workspace_id,
    source_file_id: source.id,
    parser: "local_structured",
    blocks: [
      {
        id: `${source.id}-B001`,
        source_file_id: source.id,
        index: 0,
        kind: "prose",
        heading: null,
        text: "Unmet need for pneumonitis monitoring outside academic centres.",
      },
    ],
  });
  const gap = await insertClaim({
    workspace_id,
    claim_type: "gap",
    statement: "No real-world data on pneumonitis monitoring",
    validated: true,
    status: "open",
    metadata: { priority: "high" },
  });
  const tactic = await insertClaim({
    workspace_id,
    claim_type: "tactic",
    statement: "Community oncology registry",
    status: "draft",
  });
  return { org_id, workspace_id, source_file_id: source.id, gap, tactic };
}

function post(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectAiOff(res: Response) {
  expect(res.status).toBe(409);
  const json = (await res.json()) as { ok?: boolean; code?: string; error?: string };
  expect(json).toMatchObject({ ok: false, code: "ai_off", error: AI_OFF_MESSAGE });
}

async function workspaceCount(): Promise<number> {
  const rows = (await accuracyDb().execute(
    sql`select count(*)::int as n from accuracy_workspaces`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function snapshot(workspace_id: string) {
  const [claims, runs, verdicts] = await Promise.all([
    listClaims(workspace_id, { limit: 1000 }),
    listAccuracyRuns(workspace_id, 500),
    listCompletenessVerdicts(workspace_id),
  ]);
  return { claims: claims.length, runs: runs.length, verdicts: verdicts.length };
}

describe("accuracy AI routes with AI off", () => {
  let ws: Awaited<ReturnType<typeof workspaceWithBlocks>>;

  beforeAll(async () => {
    ws = await workspaceWithBlocks("ai-off-routes");
    await setAiEnabled({ enabled: false, actor_name: ADMIN, rationale: "AI off for accuracy route tests" });
  });
  afterAll(async () => {
    await setAiEnabled({ enabled: true, actor_name: ADMIN, rationale: "restore after accuracy route tests" });
  });

  it("extract answers 409 ai_off and writes nothing", async () => {
    const before = await snapshot(ws.workspace_id);
    await expectAiOff(
      await extractPost(
        post("/api/accuracy/extract", {
          workspace_id: ws.workspace_id,
          source_file_id: ws.source_file_id,
        }),
      ),
    );
    expect(await snapshot(ws.workspace_id)).toEqual(before);
  });

  it("review GET does not run the completeness audit", async () => {
    const before = await snapshot(ws.workspace_id);
    await expectAiOff(
      await reviewGet(
        new Request(
          `http://localhost/api/accuracy/review?workspace_id=${encodeURIComponent(ws.workspace_id)}`,
        ),
      ),
    );
    const after = await snapshot(ws.workspace_id);
    expect(after).toEqual(before);
    expect(after.verdicts).toBe(0);
  });

  it("coverage assist answers 409 ai_off and writes nothing", async () => {
    const before = await snapshot(ws.workspace_id);
    await expectAiOff(
      await assistPost(
        post("/api/accuracy/coverage/assist", {
          workspace_id: ws.workspace_id,
          gap_id: ws.gap.id,
          tactic_id: ws.tactic.id,
        }),
      ),
    );
    expect(await snapshot(ws.workspace_id)).toEqual(before);
  });

  it("LLM ideate (all gaps and per gap) answers 409 ai_off and writes nothing", async () => {
    const before = await snapshot(ws.workspace_id);
    await expectAiOff(await ideatePost(post("/api/accuracy/ideate", { workspace_id: ws.workspace_id })));
    await expectAiOff(
      await ideatePost(
        post("/api/accuracy/ideate", { workspace_id: ws.workspace_id, gap_id: ws.gap.id, hints: "registry" }),
      ),
    );
    expect(await snapshot(ws.workspace_id)).toEqual(before);
  });

  it("seed with an explicit parse answers 409 ai_off before creating a workspace", async () => {
    const before = await workspaceCount();
    await expectAiOff(
      await seedPost(post("/api/accuracy/seed", { pack_id: "beone-bgb-58067-prmt5i", parse_source: true })),
    );
    expect(await workspaceCount()).toBe(before);
  });

  it("seed without a parse loads the gold claims and skips the parse with a note, not an error", async () => {
    const res = await seedPost(post("/api/accuracy/seed", { pack_id: "beone-bgb-58067-prmt5i" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      workspace_id: string;
      gaps: number;
      tactics: number;
      parse_blocks: number;
      parse_error: string | null;
      parse_skipped: string | null;
    };
    expect(json.ok).toBe(true);
    expect(json.gaps).toBeGreaterThan(0);
    expect(json.tactics).toBeGreaterThan(0);
    expect(json.parse_blocks).toBe(0);
    expect(json.parse_error).toBeNull();
    expect(json.parse_skipped).toMatch(/AI is off/);
    // No parse (or any AI) run was opened for the seeded workspace.
    const runs = await listAccuracyRuns(json.workspace_id, 100);
    expect(runs.filter((run) => run.call_kind === "parse")).toHaveLength(0);
  });

  it("with AI back on, review GET runs the audit again", async () => {
    await setAiEnabled({ enabled: true, actor_name: ADMIN, rationale: "check the on path" });
    try {
      const res = await reviewGet(
        new Request(
          `http://localhost/api/accuracy/review?workspace_id=${encodeURIComponent(ws.workspace_id)}`,
        ),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; scanned_blocks: number };
      expect(json.ok).toBe(true);
      expect(json.scanned_blocks).toBe(1);
    } finally {
      await setAiEnabled({ enabled: false, actor_name: ADMIN, rationale: "back off for the rest" });
    }
  });
});
