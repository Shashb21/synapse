/** Development headings and long saved evidence remain readable when the page reflows. */
import { expect, test } from "@playwright/test";
import { developmentDetails, developmentStep } from "../support/development-workflow";

test("all workflow steps retain heading order and wrap long saved evidence", async ({ page }) => {
  const name = `Hierarchy ${Date.now()} ${"LongExperimentName".repeat(12)}`.slice(0, 120);
  const created = await page.request.post("/api/admin/development", { data: { name, source_workspace_id: null } });
  expect(created.ok(), `Create experiment: ${created.status()} ${await created.text()}`).toBe(true);
  const { experiment } = await created.json();
  const identity = "saved-identity-".repeat(14);
  const execution = {
    id: identity, experiment_id: experiment.id, created_at: "2026-11-04", updated_at: "2026-11-04",
    generation_status: "succeeded", evaluation_status: "not_requested", error: null, calls: [],
    manifest: { revision: 1, config: { mode: "standard" }, routes: {}, sources: [{ id: identity, sha256: "a".repeat(64) }], references: [] },
    sections: [{ id: identity, section: "gap_extraction", status: "succeeded", error: null, prerequisites: {},
      result: { output_id: "b".repeat(64), candidates: [], output: { accepted: [{ name: "LongEvidenceName".repeat(20), source_quote: "Saved source evidence remains unchanged. ".repeat(12) }], rejected: [] } } }],
  };
  await page.route("**/api/admin/development/*/executions**", intercepted => intercepted.fulfill({ json: { executions: [execution], delivery: { available: true, reason: null } } }));
  await page.goto("/admin/development");
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Selected execution", exact: true })).toHaveValue(identity);

  for (const width of [1440, 390, 720]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const step of ["Documents", "Test settings", "Run", "Results"] as const) {
      await developmentStep(page, step);
      await expect(page.getByRole("heading", { name: step, exact: true })).toBeVisible();
      if (step === "Documents") await developmentDetails(page, "Optional evaluation references");
      if (step === "Test settings") await developmentDetails(page, "Gap extraction route and roles");
      if (step === "Results") {
        await developmentDetails(page, "Provenance and retry policy");
        await developmentDetails(page, "Attempt identifiers and prerequisites");
        await expect(page.getByText("Generated output: unreviewed", { exact: true })).toBeVisible();
        await expect(page.getByText("A fresh run may incur provider charges. Interrupted or uncertain sends are not automatically resent.", { exact: true })).toBeVisible();
      }
      const headings = await page.locator("main :is(h1,h2,h3,h4,h5,h6)").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => ({ level: Number(node.tagName.slice(1)), text: node.textContent })));
      expect(headings[0]).toMatchObject({ level: 1, text: "Development" });
      for (let index = 1; index < headings.length; index++) {
        expect(headings[index].level, `Heading order at ${width}px in ${step}: ${JSON.stringify(headings)}`).toBeLessThanOrEqual(headings[index - 1].level + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${step} at ${width}px`).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${step.replaceAll(" ", "-")}-${width}.png`), fullPage: true });
    }
    await developmentDetails(page, "New experiment");
    const labelGap = await page.getByRole("textbox", { name: "New experiment name", exact: true }).evaluate(control => {
      const label = control.closest("label")!;
      const text = Array.from(label.childNodes).find(node => node.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNodeContents(text);
      return control.getBoundingClientRect().top - range.getBoundingClientRect().bottom;
    });
    expect(labelGap, `Label and input need breathing room at ${width}px`).toBeGreaterThanOrEqual(8);
  }
});
