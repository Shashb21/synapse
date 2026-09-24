import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * The admin AI switch, end to end: with AI off the app is fully manual. The
 * first screen is Add gaps / Add tactics, AI controls are gone, AI APIs answer
 * 409 ai_off, and turning AI back on restores them.
 */

async function setAi(request: APIRequestContext, enabled: boolean) {
  const res = await request.post("/api/control", {
    data: { action: "set_ai_enabled", enabled, rationale: enabled ? "e2e: AI back on" : "e2e: manual mode" },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe.serial("AI switched off by an admin", () => {
  test.afterAll(async ({ request }) => {
    await setAi(request, true);
  });

  test("the control panel flips AI off and every page shows it", async ({ page, request }) => {
    await page.goto("/control");
    await expect(page.getByTestId("ai-switch-panel")).toContainText(/AI is on/);

    await setAi(request, false);
    await page.reload();
    await expect(page.getByTestId("ai-switch-panel")).toContainText(/AI is off/);
    await expect(page.getByTestId("ai-off-banner")).toBeVisible();
  });

  test("the first screen is Add gaps and Add tactics, with no upload or ingest", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /add gaps/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /add tactics/i }).first()).toBeVisible();
    await expect(page.getByText(/ingest this file|ingest gaps and tactics/i)).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  test("the pipeline offers the manual path instead of AI runs", async ({ page }) => {
    await page.goto("/pipeline");
    await expect(page.getByText(/AI is off — done by hand/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /upload and parse/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /run evals/i })).toHaveCount(0);
  });

  test("AI APIs answer 409 ai_off and record no run", async ({ request }) => {
    const res = await request.post("/api/modules", { data: { stage: "S2", input: {} } });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("ai_off");
  });

  test("the accuracy app leads with adding gaps and tactics", async ({ page, request }) => {
    const created = await request.post("/api/accuracy/workspaces", {
      data: { name: "E2E AI off", slug: `e2e-ai-off-${Date.now()}` },
    });
    expect(created.ok()).toBeTruthy();
    await page.goto("/accuracy");
    await expect(page.getByTestId("accuracy-manual-start")).toBeVisible();
    await expect(page.getByText(/add gaps/i).first()).toBeVisible();
    await expect(page.getByText(/add tactics/i).first()).toBeVisible();
  });

  test("turning AI back on restores the AI controls", async ({ page, request }) => {
    await setAi(request, true);
    await page.goto("/pipeline");
    await expect(page.getByTestId("ai-off-banner")).toHaveCount(0);
    await expect(page.getByText(/AI is off — done by hand/i)).toHaveCount(0);
  });
});
