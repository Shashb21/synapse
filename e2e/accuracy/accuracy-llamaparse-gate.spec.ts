import { expect, test } from "@playwright/test";

/**
 * PDF/PPTX LlamaParse env gate. No live Llama — Playwright has no
 * LLAMA_CLOUD_API_KEY; text still parses locally.
 */
test.describe("accuracy LlamaParse key gate", () => {
  test("blocks PDF upload without the key and still parses text locally", async ({
    page,
    request,
  }) => {
    const created = await request.post("/api/accuracy/workspaces", {
      data: {
        name: "E2E LlamaParse Gate",
        slug: `e2e-llama-gate-${Date.now()}`,
      },
    });
    expect(created.ok()).toBeTruthy();
    const { workspace_id } = (await created.json()) as { workspace_id: string };
    expect(workspace_id).toBeTruthy();

    await page.goto(`/accuracy/sources?workspace_id=${encodeURIComponent(workspace_id)}`);
    await expect(page.getByRole("heading", { name: /^sources$/i })).toBeVisible();
    await expect(page.getByText(/uploads are gated without it/i)).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(/LLAMA_CLOUD_API_KEY/);

    await page.locator('input[type="file"]').setInputFiles({
      name: "plan.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 gated"),
    });
    await page.getByRole("button", { name: /upload & parse/i }).click();
    await expect(page.getByText(/PDF and PPTX require LlamaParse/i)).toBeVisible();
    await expect(page.getByText(/plan\.pdf/i)).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles({
      name: "memo.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Need OS evidence in 1L NSCLC.\n\nRegistry gap remains open."),
    });
    await page.getByRole("button", { name: /upload & parse/i }).click();
    await expect(page.getByText(/Uploaded memo\.txt/i)).toBeVisible();
    await expect(page.getByText(/memo\.txt/).first()).toBeVisible();
    await expect(page.getByText(/parse block\(s\)/i).first()).toBeVisible();
  });
});
