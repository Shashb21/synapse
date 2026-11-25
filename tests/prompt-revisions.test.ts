import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import { createWorkspace } from "@/modules/workspaces/store";
import { proposePromptRevision, listPromptRevisions } from "@/modules/kernel/prompt-revisions";
import * as routing from "@/modules/kernel/routing";
import { ensurePlatformSchema } from "@/modules/kernel/db";
import * as examples from "@/modules/kernel/decision-examples";

describe("prompt revision preflight", () => {
  it("refuses unsupported stages before loading lessons or allocating a cohort", async () => {
    const read = vi.spyOn(examples, "listDecisionExamples");
    try {
      for (const stage of ["S2", "S3", "S6"] as const) {
        await expect(
          proposePromptRevision({
            stage,
            workspace_id: "fiction",
            exclude_ids: [],
            actor: { name: "Owner", function: "medical_affairs" },
          }),
        ).rejects.toThrow("human target contract");
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("creates no candidate or orphan cohort when the workspace lacks independent gold", async () => {
    const ws = await createWorkspace({ name: "fiction-" + crypto.randomUUID(), owner: "fiction-owner" });
    const completion = vi.spyOn(routing, "completionFor");
    vi.spyOn(routing, "routeConfigs").mockResolvedValue([
      {
        stage: "S8",
        provider_id: "test",
        model: "fiction",
        params: { temperature: 0, max_tokens: 500 },
        fallbacks: [],
        updated_by: "fixture",
        updated_at: "2026-01-01",
      },
    ]);
    vi.spyOn(routing, "resolveRoute").mockResolvedValue({
      stage: "S8",
      provider_id: "test",
      provider_label: "fiction",
      model: "fiction",
      params: { temperature: 0, max_tokens: 500 },
      degraded: false,
      connected: true,
      auth: "api_key",
      fallbacks: [],
      reason: null,
    });
    try {
      await ensurePlatformSchema();
      await expect(
        proposePromptRevision({
          stage: "S8",
          workspace_id: ws.id,
          exclude_ids: [],
          actor: { name: "Owner", function: "medical_affairs" },
        }),
      ).rejects.toThrow("three independent");
      expect(completion).not.toHaveBeenCalled();
      expect(await listPromptRevisions(ws.id)).toEqual([]);
      expect(await sharedDb().execute(sql`select id from prompt_revision_cohorts where workspace_id=${ws.id}`)).toHaveLength(
        0,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
