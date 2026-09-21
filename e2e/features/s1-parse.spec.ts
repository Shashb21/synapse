import { expect, test } from "@playwright/test";
import {
  DEMO_SOURCES,
  consolidate,
  evalValue,
  resetWorkspace,
  runRecord,
  runStage,
} from "../support/synapse";

type ParseOutput = {
  documents: {
    id: string;
    file_id: string;
    source_id: string;
    blocks: number;
    quality: {
      blocks: number;
      characters: number;
      avg_block_chars: number;
      need_cue_blocks: number;
      tactic_cue_blocks: number;
      warnings: string[];
    };
  }[];
  failures: { file_id: string; reason: string }[];
};

test.describe.configure({ mode: "serial" });

test.describe("S1 file parse", () => {
  test.beforeAll(async ({ request }) => {
    await resetWorkspace(request);
    await runStage(request, "S0", { demo_ids: DEMO_SOURCES });
  });

  test("parses from the pipeline page into blocks with quality signals", async ({ page, request }) => {
    await page.goto("/pipeline");
    await page.getByRole("button", { name: /^run s1$/i }).click();
    await expect(page.getByText(/document\(s\) parsed, 0 failed/)).toBeVisible({ timeout: 30_000 });

    const state = await runStage<ParseOutput>(request, "S1", { dry_run: true });
    expect(state.output.documents.length).toBeGreaterThan(0);
    for (const document of state.output.documents) {
      expect(document.quality.blocks).toBeGreaterThan(0);
      expect(document.quality.characters).toBeGreaterThan(200);
      expect(document.quality.avg_block_chars).toBeGreaterThan(0);
    }
  });

  test("writes the domain source but extracts nothing", async ({ request }) => {
    const lists = await consolidate(request);
    expect(lists.open, "parse must not create gaps").toHaveLength(0);
    expect(lists.addressed).toHaveLength(0);
  });

  test("scores parse quality on its own gold cases", async ({ request }) => {
    const response = await request.post("/api/modules/evals", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ stage: "S1", actor_name: "Feature E2E", actor_function: "medical_affairs" }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as {
      cases: number;
      passed: boolean;
      metrics: { name: string; value: number }[];
    };
    expect(body.cases).toBeGreaterThan(0);
    const names = body.metrics.map((metric) => metric.name);
    expect(names).toContain("text_recovered");
    expect(names).toContain("need_language_found");
    expect(body.metrics.find((metric) => metric.name === "text_recovered")!.value).toBe(1);
  });

  test("reports a per-file failure instead of failing the batch", async ({ request }) => {
    const result = await runStage<ParseOutput>(request, "S1", { file_ids: ["FILE-does-not-exist"] });
    expect(result.output.documents).toHaveLength(0);
    expect(result.output.failures[0]).toEqual({ file_id: "FILE-does-not-exist", reason: "file not found" });
    const run = await runRecord(request, result.run_id);
    expect(run.status).toBe("ok");
    expect(evalValue(run, "parse_success_rate")).toBe(0);
  });
});
