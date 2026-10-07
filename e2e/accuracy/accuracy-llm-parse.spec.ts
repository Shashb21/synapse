import { expect, test } from "@playwright/test";

/**
 * Every file type is parsed on the chosen LLM's parse route; LlamaParse is
 * disabled, so there is no key gate. Playwright runs the test stub.
 */
test.describe("accuracy LLM parse", () => {
  test("uploads with no LlamaParse gate and says the LLM parses every file", async ({ page, request }) => {
    const created = await request.post("/api/accuracy/workspaces", {
      data: { name: "E2E LLM Parse", slug: `e2e-llm-parse-${Date.now()}` },
    });
    expect(created.ok()).toBeTruthy();
    const { workspace_id } = (await created.json()) as { workspace_id: string };

    await page.goto(`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspace_id)}`);
    await expect(page.getByRole("heading", { name: /^sources$/i })).toBeVisible();
    await expect(page.getByText(/parsed by the LLM on the parse route/i)).toBeVisible();
    await expect(page.getByText(/LLAMA_CLOUD_API_KEY/)).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles({
      name: "memo.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Need OS evidence in 1L NSCLC.\n\nRegistry gap remains open."),
    });
    await page.getByRole("button", { name: /upload & parse/i }).click();
    await expect(page.getByText(/Uploaded memo\.txt/i)).toBeVisible();
    await expect(page.getByText(/parse block\(s\)/i).first()).toBeVisible();
  });
});
