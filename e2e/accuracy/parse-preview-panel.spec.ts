import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Sources parse-block preview: upload a DOCX, then assert side panel + expand.
 */
test("sources parse-block preview panel shows verbatim blocks", async ({ page, request }) => {
  const stamp = Date.now();
  const wsRes = await request.post("/api/accuracy/workspaces", {
    data: {
      name: `Parse Preview E2E ${stamp}`,
      slug: `parse-preview-e2e-${stamp}`,
      org_name: `Parse Preview Org ${stamp}`,
    },
  });
  expect(wsRes.ok()).toBeTruthy();
  const wsBody = (await wsRes.json()) as { workspace_id?: string };
  const workspaceId = wsBody.workspace_id;
  expect(workspaceId).toBeTruthy();

  const docx = readFileSync(join(process.cwd(), "e2e/fixtures/parse-preview-demo.docx"));
  const upload = await request.post("/api/accuracy/sources/upload", {
    multipart: {
      workspace_id: workspaceId!,
      doc_role: "medical",
      file: {
        name: "demo-iep.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: docx,
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const uploaded = (await upload.json()) as { source_file_id?: string; block_count?: number };
  expect((uploaded.block_count ?? 0) > 0).toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId!)}`);
  await expect(page.getByRole("heading", { name: /^sources$/i })).toBeVisible();
  await expect(page.getByTestId("parse-block-preview")).toBeVisible();
  await expect(page.getByTestId("sources-list")).toBeVisible();
  await expect(page.getByText("demo-iep.docx").first()).toBeVisible();
  await expect(page.getByText(/parse block\(s\)/i).first()).toBeVisible();

  const firstBlock = page.locator("[data-testid=parse-block-preview] details").first();
  await firstBlock.locator("summary").click();
  await expect(page.getByTestId("parse-block-verbatim").first()).toBeVisible();
  await expect(page.getByTestId("parse-block-verbatim").first()).toContainText(/Evidence gaps|OS evidence|pneumonitis/i);

  await page.screenshot({
    path: "/opt/cursor/artifacts/parse_preview_sources_panel_e2e.png",
    fullPage: true,
  });
});
