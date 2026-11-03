/** Document selection and fixed-copy persistence, with scripted workspace discovery. */
import { expect, test } from "@playwright/test";
import { developmentStep } from "../support/development-workflow";

test("workspace choice, discovery recovery, import and upload preserve the experiment", async ({ page }) => {
  // Arrange: use real persistence; script discovery and import at the existing API boundary.
  const name = `Documents ${Date.now()}`;
  let discoveryReads = 0;
  let creates = 0;
  let workspaceId = "";
  let experimentId = "";
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/admin/development") creates++;
  });
  await page.route("**/api/admin/development/*/sources", async route => {
    if (route.request().method() === "POST") {
      // Assert selection is sent correctly before scripting fixed-copy persistence.
      expect(route.request().postDataJSON().source_file_id).toBe("workspace-file");
      // Persist the imported fixed copy through the real upload endpoint, without customer writes.
      const response = await page.request.post(`/api/admin/development/${experimentId}/source-upload`, { data: {
        revision: route.request().postDataJSON().revision,
        filename: "workspace-evidence.txt", content_base64: Buffer.from("Retained workspace evidence").toString("base64"),
      } });
      await route.fulfill({ status: response.status(), json: await response.json() });
      return;
    }
    discoveryReads++;
    await route.fulfill(discoveryReads === 1
      ? { status: 503, json: { error: "Workspace documents unavailable. Refresh the choices." } }
      : { json: { sources: [{ id: "workspace-file", filename: "workspace-evidence.txt", status: "parsed" }] } });
  });
  await page.goto("/admin/development");
  const workspace = page.getByLabel("Workspace for this experiment");
  await expect(page.locator("#workspace-help")).toContainText("Private uploads only exposes no existing workspace documents");
  // The authenticated fixture always has its customer workspace available.
  await expect(workspace.locator('option').nth(1)).toBeAttached();
  workspaceId = await workspace.locator('option').nth(1).getAttribute("value") ?? "";
  await workspace.selectOption(workspaceId);
  await page.getByLabel("New experiment name").fill(name);
  const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/development");
  await page.getByRole("button", { name: "Create experiment", exact: true }).click();
  experimentId = (await (await created).json()).experiment.id;
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Your experiment is saved");
  await page.getByLabel("Experiment name", { exact: true }).fill(`${name} edited`);
  await page.getByLabel("File to add to this experiment").setInputFiles({ name: "private-evidence.txt", mimeType: "text/plain", buffer: Buffer.from("Private evidence") });
  await page.getByRole("button", { name: "Refresh workspace documents", exact: true }).click();
  // Assert: retry only discovers choices; it keeps unsaved fields and creates no extra experiment.
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(`${name} edited`);
  await expect(page.getByLabel("File to add to this experiment")).toHaveValue(/private-evidence.txt/);
  await expect(page.getByRole("button", { name: "Add a copy to this experiment" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Workspace document", exact: true }).selectOption("workspace-file");
  await page.getByRole("button", { name: "Add a copy to this experiment" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Experiment document saved." })).toBeVisible();
  await developmentStep(page, "Documents");
  await expect(page.getByRole("region", { name: "Saved documents" })).toContainText("workspace-evidence.txt");
  await page.getByRole("button", { name: "Upload experiment document", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Experiment document saved." })).toBeVisible();
  await developmentStep(page, "Documents");
  await expect(page.getByRole("region", { name: "Saved documents" })).toContainText("private-evidence.txt");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: `Open ${name} edited`, exact: true }).click();
  await developmentStep(page, "Documents");
  const documents = page.getByRole("region", { name: "Saved documents" });
  await expect(documents).toContainText("workspace-evidence.txt");
  await expect(documents).toContainText("private-evidence.txt");
  await expect(documents).toContainText("Ready for generation");
  await documents.getByText("Document details", { exact: true }).first().click();
  await expect(documents.getByLabel("Experiment document ID").first()).toBeVisible();
  expect(creates).toBe(1);
});

for (const scenario of [
  { name: "empty", filename: "empty.txt", buffer: Buffer.alloc(0), message: "That file is empty" },
  { name: "unsupported", filename: "bad.exe", buffer: Buffer.from("bad"), message: "Unsupported file format" },
  { name: "oversized", filename: "large.txt", buffer: Buffer.alloc(3 * 1024 * 1024 + 1), message: "That file exceeds 3 MiB" },
]) {
  test(`${scenario.name} upload explains recovery before any document write`, async ({ page }) => {
    await page.goto("/admin/development");
    await page.getByLabel("New experiment name").fill(`Validation ${scenario.name} ${Date.now()}`);
    await page.getByRole("button", { name: "Create experiment", exact: true }).click();
    await expect(page.getByText("This experiment uses private uploads only and cannot access existing workspace documents.", { exact: false })).toBeVisible();
    let uploads = 0;
    page.on("request", request => { if (request.url().endsWith("/source-upload")) uploads++; });
    await page.getByLabel("File to add to this experiment").setInputFiles({ name: scenario.filename, mimeType: "application/octet-stream", buffer: scenario.buffer });
    await page.getByRole("button", { name: "Upload experiment document", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(scenario.message);
    await expect(page.getByRole("region", { name: "Saved documents" })).toContainText("No documents saved");
    expect(uploads).toBe(0);
  });
}

test("discovery recovery survives successful name saves and document uploads", async ({ page }) => {
  // Arrange: discovery fails independently of the persisted experiment and subsequent writes.
  let sourceReads = 0;
  let creates = 0;
  await page.route("**/api/admin/development/*/sources", async route => {
    sourceReads++;
    await route.fulfill(sourceReads === 1
      ? { status: 503, json: { error: "Workspace documents unavailable. Refresh the choices." } }
      : { json: { sources: [{ id: "available-file", filename: "available.txt", status: "parsed" }] } });
  });
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/admin/development") creates++;
  });
  await page.goto("/admin/development");
  const workspace = page.getByLabel("Workspace for this experiment");
  await expect(workspace.locator("option").nth(1)).toBeAttached();
  await workspace.selectOption(await workspace.locator("option").nth(1).getAttribute("value") ?? "");
  const name = `Persistent discovery recovery ${Date.now()}`;
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment", exact: true }).click();
  const recovery = page.getByRole("button", { name: "Refresh workspace documents", exact: true });
  await expect(recovery).toBeVisible();
  // Act: a successful name save clears the shared request error, but discovery is still failed.
  await page.getByLabel("Experiment name", { exact: true }).fill(`${name} saved`);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeEnabled();
  // A successful upload must also keep the independent discovery recovery reachable.
  await page.getByLabel("Experiment name", { exact: true }).fill(`${name} edited`);
  await page.getByLabel("File to add to this experiment").setInputFiles({ name: "saved-upload.txt", mimeType: "text/plain", buffer: Buffer.from("Saved evidence") });
  await page.getByRole("button", { name: "Upload experiment document", exact: true }).click();
  await expect(page.getByRole("region", { name: "Saved documents" })).toContainText("saved-upload.txt");
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeEnabled();
  await page.getByLabel("File to add to this experiment").setInputFiles({ name: "pending-upload.txt", mimeType: "text/plain", buffer: Buffer.from("Pending evidence") });
  await recovery.click();
  // Assert: retry reads only and keeps persisted documents plus unrelated edits/selections.
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(`${name} edited`);
  await expect(page.getByLabel("File to add to this experiment")).toHaveValue(/pending-upload.txt/);
  await expect(page.getByRole("region", { name: "Saved documents" })).toContainText("saved-upload.txt");
  await page.getByRole("combobox", { name: "Workspace document", exact: true }).selectOption("available-file");
  await expect(page.getByRole("button", { name: "Add a copy to this experiment" })).toBeEnabled();
  expect(sourceReads).toBe(2);
  expect(creates).toBe(1);
});
