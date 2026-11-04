/** Bundled demo file selection: partial failure, retry, reopen and scripted generation start. */
import { expect, test } from "@playwright/test";
import { developmentStep, developmentDetails } from "../support/development-workflow";
import { CLIENT_DEMO_PACK } from "../../src/lib/demo/client-pack";

// Expose configured credentials so readiness permits the scripted run; no provider is called.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/control", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.provider_keys = body.provider_keys.map((provider: Record<string, unknown>) => ({ ...provider, status: "configured" }));
    await route.fulfill({ response, json: body });
  });
});

test("demo files save once, retry only the failure, reopen and start scripted generation", async ({ page }) => {
  // Arrange: real persistence in the isolated database; fail one POST before it reaches the server.
  const name = `Demo files ${Date.now()}`;
  const posted: string[] = [];
  let failedOnce = false;
  let runBody: Record<string, unknown> | undefined;
  await page.route("**/api/admin/development/*/demo-documents", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const demoId = route.request().postDataJSON().demo_id;
    posted.push(demoId);
    if (posted.length === 2 && !failedOnce) {
      failedOnce = true;
      return route.fulfill({ status: 503, json: { code: "development_unavailable", error: "Development could not complete this request. Retry this file." } });
    }
    return route.continue();
  });
  await page.route("**/api/admin/development/*/executions*", async route => {
    if (route.request().method() === "POST") {
      runBody = route.request().postDataJSON();
      return route.fulfill({ status: 409, json: { error: "Scripted run stopped; no provider was called." } });
    }
    return route.fulfill({ json: { executions: [], delivery: { available: true, transport: "scripted", reason: null } } });
  });
  await page.goto("/admin/development");
  await developmentDetails(page, "New experiment");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment", exact: true }).click();
  await developmentStep(page, "Documents");
  const group = page.getByRole("group", { name: "Demo files" });
  await expect(group).toContainText("AI parsing may incur charges.");
  const boxes = group.getByRole("checkbox");
  await expect(boxes).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Add selected demo files" })).toBeDisabled();

  // Act: choose three files; the second request fails.
  for (const index of [0, 1, 2]) await boxes.nth(index).check();
  await expect(group.getByRole("status")).toContainText("3 demo files selected");
  await page.getByRole("button", { name: "Add selected demo files" }).click();

  // Assert: successes persist, the failure is shown for that file, and only it remains selected.
  await expect(group).toContainText("Not added");
  await expect(boxes.nth(0)).toBeDisabled();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(boxes.nth(2)).toBeDisabled();
  await expect(group.getByRole("status")).toContainText("1 demo file selected");
  const firstPass = [...posted];
  expect(firstPass).toHaveLength(3);

  // Act: retry sends only the remaining file.
  await page.getByRole("button", { name: "Add selected demo files" }).click();
  await expect(group.getByText("Already added")).toHaveCount(3);
  expect(posted.slice(3)).toEqual([firstPass[1]]);

  // Assert: reopening keeps exactly three private demo sources with details.
  await page.reload();
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await developmentStep(page, "Documents");
  const saved = page.getByRole("region", { name: "Saved documents" });
  await expect(saved.getByText("Generation source", { exact: true })).toHaveCount(3);
  await saved.getByText("Document details", { exact: true }).first().click();
  await expect(saved).toContainText("Private demo file");

  // Narrow viewport: controls stay usable without horizontal overflow.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole("button", { name: "Add selected demo files" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Start the run flow with the saved sources; real server-side execution from these sources is proven in tests/ui-4-demo-documents.test.ts.
  await developmentStep(page, "Run");
  await page.getByRole("button", { name: "Run all sections" }).click();
  await expect(page.getByRole("region", { name: "Execution", exact: true }).getByRole("alert")).toContainText("Scripted run stopped");
  expect(runBody?.target).toBe("all");
});

test("failed demo discovery is retried explicitly and the error clears", async ({ page }) => {
  // Arrange: fail every discovery GET until availability is restored just before Retry.
  const name = `Demo discovery ${Date.now()}`;
  let available = false;
  await page.route("**/api/admin/development/*/demo-documents", async route => {
    if (route.request().method() !== "GET") return route.continue();
    if (!available) return route.fulfill({ status: 503, json: { code: "development_unavailable", error: "unavailable" } });
    return route.continue();
  });
  await page.goto("/admin/development");
  await developmentDetails(page, "New experiment");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment", exact: true }).click();
  await developmentStep(page, "Documents");
  const group = page.getByRole("group", { name: "Demo files" });
  await expect(group.getByRole("alert")).toContainText("Demo files could not be loaded");
  await expect(group.getByRole("checkbox")).toHaveCount(0);

  // Act: restore availability, then retry without changing the draft.
  available = true;
  await group.getByRole("button", { name: "Retry loading demo files" }).click();

  // Assert: the list appears, the error clears, and nothing was added.
  await expect(group.getByRole("checkbox")).toHaveCount(CLIENT_DEMO_PACK.length);
  await expect(group.getByRole("alert")).toHaveCount(0);
  await expect(group).not.toContainText("Already added");
});

test("a bundled file already uploaded without demo provenance is shown as added and never re-posted", async ({ page }) => {
  // Arrange: upload the exact bundled bytes through the ordinary private upload control.
  const name = `Demo duplicate ${Date.now()}`;
  const [old, fresh] = CLIENT_DEMO_PACK;
  const posted: string[] = [];
  await page.route("**/api/admin/development/*/demo-documents", async route => {
    if (route.request().method() === "POST") posted.push(route.request().postDataJSON().demo_id);
    return route.continue();
  });
  await page.goto("/admin/development");
  await developmentDetails(page, "New experiment");
  await page.getByLabel("New experiment name").fill(name);
  await page.getByRole("button", { name: "Create experiment", exact: true }).click();
  await developmentStep(page, "Documents");
  await page.getByLabel("File to add to this experiment").setInputFiles({ name: old.filename, mimeType: "text/plain", buffer: Buffer.from(old.text, "utf8") });
  await developmentStep(page, "Documents");
  await page.getByRole("button", { name: "Upload experiment document", exact: true }).click();
  await expect(page.getByRole("region", { name: "Saved documents" }).getByText("Generation source", { exact: true })).toHaveCount(1);

  // Assert: the matching demo file is satisfied and disabled; the rest stay selectable.
  const group = page.getByRole("group", { name: "Demo files" });
  const boxes = group.getByRole("checkbox");
  await expect(boxes.nth(0)).toBeDisabled();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(group).toContainText("Already added");

  // Act: a selection of only unsaved files saves; the old file is never posted.
  await boxes.nth(1).check();
  await page.getByRole("button", { name: "Add selected demo files" }).click();
  await expect(group.getByText("Already added")).toHaveCount(2);
  expect(posted).toEqual([fresh.id]);
  await expect(page.getByRole("region", { name: "Saved documents" }).getByText("Generation source", { exact: true })).toHaveCount(2);
});
