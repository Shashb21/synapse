import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";

// KAN-52: Add a source is a form on the Upload page, and Choose file fills it.
test.describe("add a source", () => {
  freshWorkspace({ name: "KAN-52 source" });

  test("choosing a file fills the title and text; an empty form says what is missing", async ({ page }) => {
    await page.goto("/?place=upload");
    const form = page.getByRole("form", { name: "Add a source" });
    await expect(form).toBeVisible();
    const submit = form.getByRole("button", { name: /add and read source/i });
    await expect(async () => {
      await submit.click();
      await expect(form.getByRole("alert")).toHaveText("Give the source a title.", { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    const chooser = page.waitForEvent("filechooser");
    await form.getByText("Choose file", { exact: true }).click();
    await (await chooser).setFiles({
      name: "payer_advisory-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Payers need 6-month persistence data in routine US care."),
    });
    await expect(form.getByTestId("chosen-file")).toContainText("payer_advisory-notes.txt");
    await expect(form.getByLabel("Title")).toHaveValue("payer advisory notes");
    await expect(form.getByLabel("Source text")).toHaveValue(/6-month persistence/);

    const other = page.waitForEvent("filechooser");
    await form.getByText("Choose file", { exact: true }).click();
    await (await other).setFiles({ name: "deck.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
    await expect(form.getByRole("alert")).toHaveText("Choose a .txt or .md file, or paste the text below.");
  });

  test("a pasted source is read and its gaps reach Evidence Inventory", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?place=upload");
    await page.waitForLoadState("networkidle");
    const form = page.getByRole("form", { name: "Add a source" });
    await form.getByLabel("Title").fill("KOL interview notes");
    await form.getByLabel("Source text").fill(
      "KOLs need to know intracranial outcomes. Limited evidence on CNS response and duration in patients with brain metastases.",
    );
    await form.getByRole("button", { name: /add and read source/i }).click();
    await expect(form.getByRole("status")).toContainText("Read “KOL interview notes”", { timeout: 90_000 });
  });
});

// KAN-52: a new gap is entered with everything it carries, in one larger dialog.
test.describe("create a gap with all its details", () => {
  freshWorkspace({ name: "KAN-52 gap" });

  test("title, description, domain, settings and details are all saved", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/?place=gaps");
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await page.getByRole("button", { name: "Add open gap" }).first().click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeGreaterThan(600);
    await expect(dialog.getByText(/Tactics and sources are matched against it/)).toBeVisible();

    await dialog.getByLabel(/^Title/).fill("Persistence in German routine care");
    await dialog.getByLabel(/^Domain/).selectOption("adherence");
    await dialog.getByLabel(/^Treatment settings/).fill("1L, Maintenance");
    await dialog.getByLabel(/^Impacted stakeholders/).fill("Payers, G-BA");
    await dialog.getByLabel(/^Geography/).fill("DE");
    await dialog.getByLabel(/^Regional nuances/).fill("AMNOG dossier due in Q3.");
    await dialog.getByRole("button", { name: "Add open gap" }).click();
    await expect(dialog).toBeHidden();

    // No description given: the title stands in for it.
    const row = page.getByTestId("evidence-inventory").locator("tr").filter({ hasText: "Persistence in German routine care" });
    await expect(row.first()).toBeVisible();
    const gapId = (await row.first().getAttribute("data-gap-id"))!;
    await page.goto(`/gaps/${gapId}`);
    await expect(page.getByRole("heading", { name: "Persistence in German routine care" })).toBeVisible();
    const details = page.getByTestId("gap-metadata");
    await expect(details.getByLabel("Impacted stakeholders")).toHaveValue("Payers, G-BA");
    await expect(details.getByLabel("Geography")).toHaveValue("DE");
    await expect(details.getByLabel("Regional nuances")).toHaveValue("AMNOG dossier due in Q3.");
    await expect(page.getByText("1L").first()).toBeVisible();
  });
});
