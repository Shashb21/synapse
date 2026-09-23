import { expect, test, type Page } from "@playwright/test";

const ACTOR = { actor_name: "E2E Platform", actor_function: "medical_affairs" };

async function runStage(page: Page, stage: string, input: Record<string, unknown> = {}) {
  const res = await page.request.post("/api/modules", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ stage, input, ...ACTOR }),
  });
  const body = await res.text();
  if (!res.ok()) throw new Error(`${stage} failed: ${res.status()} ${body}`);
  return JSON.parse(body) as { summary: string; run_id: string };
}

test.describe.configure({ mode: "serial" });

test.describe("platform surfaces", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.post("/api/iegp", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ action: "reset", ...ACTOR }),
    });
    if (!res.ok()) throw new Error(`reset failed: ${res.status()}`);
  });

  test("pipeline page lists every stage with its module and route", async ({ page }) => {
    await page.goto("/pipeline");
    await expect(page.getByRole("heading", { name: /^pipeline$/i })).toBeVisible();
    for (const heading of [
      "S0 · File upload",
      "S1 · File parse",
      "S2 · Evidence gap extraction",
      "S4 · Mapping table",
      "S8 · Prioritization",
      "S10 · Interactive Gantt timeline",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(page.getByText("s2-gap-extract.pcj v1.0.0")).toBeVisible();
    await expect(page.getByRole("button", { name: /upload and parse/i })).toBeVisible();
  });

  test("a stage run from the UI is traced with steps, route and eval scores", async ({ page }) => {
    await runStage(page, "S0", { demo_ids: ["heor-interview", "medical-kol"] });
    await runStage(page, "S1");

    await page.goto("/pipeline");
    await page.getByRole("button", { name: /^run s2$/i }).click();
    await expect(page.getByText(/gap candidate\(s\) accepted/i)).toBeVisible({ timeout: 30_000 });

    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /^runs$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /S2 · s2-gap-extract\.pcj/ }).first()).toBeVisible();

    const listed = await page.request.get("/api/modules");
    const { runs } = (await listed.json()) as { runs: { id: string; stage: string; status: string }[] };
    const traced = runs.find((run) => run.stage === "S2" && run.status === "ok")!;
    await page.goto(`/runs/${traced.id}`);
    await expect(page.getByRole("heading", { name: /^steps$/i })).toBeVisible();
    for (const step of ["input:accepted", "round1:proposer", "judge"]) {
      await expect(page.getByRole("heading", { name: step, exact: true })).toBeVisible();
    }
    await expect(page.getByText(/accept_rate/).first()).toBeVisible();
    await expect(page.getByText("Deterministic (no LLM)").first()).toBeVisible();

    // Locked: three proposer↔critic exchanges, all of them in the trace.
    await expect(page.getByRole("heading", { name: /proposer ↔ critic exchanges/i })).toBeVisible();
    for (const round of ["Round 1", "Round 2", "Round 3"]) {
      await expect(page.getByRole("cell", { name: round, exact: true })).toBeVisible();
    }
    for (const step of ["round1:critic", "round2:proposer-revise", "round3:critic"]) {
      await expect(page.getByRole("heading", { name: step, exact: true })).toBeVisible();
    }
  });

  test("control panel offers OAuth login per provider with Grok as the default route", async ({ page }) => {
    await page.goto("/control");
    await expect(page.getByRole("heading", { name: /^control panel$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^xAI · Grok$/ })).toBeVisible();
    await expect(page.getByText("Default route", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Anthropic · Claude$/ })).toBeVisible();
    await expect(page.getByText("One-click alternate", { exact: true })).toBeVisible();
    for (const provider of ["OpenAI · ChatGPT", "Google · Gemini", "OpenRouter"]) {
      await expect(page.getByRole("heading", { name: provider })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: /log in with xAI/i })).toBeVisible();
    // Nothing on the panel accepts a pasted credential.
    await expect(page.getByRole("textbox", { name: /api key|secret|credential/i })).toHaveCount(0);
    await expect(page.getByPlaceholder(/api key|secret|sk-/i)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /S2 · Evidence gap extraction/ })).toBeVisible();
  });

  test("saving the IEGP as final versions it and repaints in place", async ({ page }) => {
    await runStage(page, "S3");
    await runStage(page, "S4");
    await runStage(page, "S8");
    await runStage(page, "S10", { persist: true });

    await page.goto("/timeline");
    await expect(page.getByRole("heading", { name: /^iegp timeline$/i })).toBeVisible();
    await expect(page.locator("svg[role='img']")).toBeVisible();

    await page.getByRole("button", { name: /save as final/i }).click();
    await page.getByPlaceholder(/why this decision/i).fill("Signed off in the e2e review");
    await page.getByRole("textbox", { name: /^name$/i }).fill("E2E Platform");
    await page.getByRole("button", { name: /^save$/i }).click();

    // No reload: the server component repaints with the new version.
    await expect(page.getByText(/Signed off in the e2e review/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Saved v\d+ ·/)).toContainText(/final/i);
  });

  test("an edit rationale from a gate reaches the hillclimb feed", async ({ page }) => {
    const state = await page.request.get("/api/plan");
    expect(state.ok()).toBeTruthy();
    await runStage(page, "S3");
    await runStage(page, "S4");
    const gaps = await page.request.get("/api/modules");
    expect(gaps.ok()).toBeTruthy();

    const consolidated = await runStage(page, "S7");
    expect(consolidated.summary).toMatch(/open/);

    const detail = await page.request.post("/api/iegp", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        action: "validate_gap",
        gap_id: "GAP-001",
        note: "Both source quotes check out for this gap",
        ...ACTOR,
      }),
    });
    expect(detail.ok()).toBeTruthy();

    await page.goto("/runs");
    await expect(page.getByText(/Both source quotes check out/i).first()).toBeVisible();
  });
});
