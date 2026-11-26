import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as data from "@/modules/kernel/db";
import * as workspace from "@/modules/workspaces/store";
import * as entities from "@/modules/kernel/learning-entities";
import { similarExamples } from "@/modules/kernel/decision-examples";

it("bounds foreign ranking globally and validates the shortlist with one privacy-scoped read", async () => {
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const records = Array.from({ length: 128 }, (_, i) => ({
    id: "rec-" + i,
    workspace_id: "foreign-" + i,
    stage: "S8",
    kind: "s8_band",
    lesson: "Review the narrower population.",
    lesson_status: "ok",
    outcome: "edited",
  }));
  const execute = vi.fn(async (query: SQL) => {
    const parsed = dialect.sqlToQuery(query);
    queries.push(parsed);
    if (parsed.sql.includes("union all")) return records;
    if (parsed.sql.includes("d.id in"))
      return records
        .slice(0, 16)
        .map((row) => ({ ...row, ai_input: { secret: "private content" }, ai_output: {}, final: {}, rationale: null }));
    return [];
  });
  try {
    vi.spyOn(data, "sharedDb").mockReturnValue({ execute } as unknown as ReturnType<typeof data.sharedDb>);
    vi.spyOn(workspace, "learningSharingEligible").mockResolvedValue(true);
    vi.spyOn(workspace, "getWorkspace").mockImplementation(
      async (id) => ({ id, schema_name: "public" }) as Awaited<ReturnType<typeof workspace.getWorkspace>>,
    );
    const projection = vi
      .spyOn(entities, "readLearningEntityProjection")
      .mockResolvedValue({ asset: { name: "Fiction", inn: "", planning_context: {} }, names: [] });
    const result = await similarExamples({
      stage: "S8",
      text: "narrower population",
      workspace_id: "own",
      allow_cross_workspace: true,
      take: 100,
    });
    expect(result).toHaveLength(16);
    expect(projection).toHaveBeenCalledTimes(16);
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(queries.find((q) => q.sql.includes("union all"))!.sql).toContain("limit 128");
    const scrub = queries.filter((q) => q.sql.includes("d.id in"));
    expect(scrub).toHaveLength(1);
    expect(scrub[0].sql.match(/learning_sharing_eligible=true/g)).toHaveLength(2);
    expect(scrub[0].params.filter((p) => String(p).startsWith("rec-"))).toHaveLength(16);
  } finally {
    vi.restoreAllMocks();
  }
});
