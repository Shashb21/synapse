import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction } from "../support/synapse";

/** KAN-198: local help stays optional while control state and draft work stay visible. */
test("AI settings help is collapsed, keyboard reversible, and leaves a routing draft intact", async ({ page }) => {
  await page.goto("/admin/control");
  const panel = page.getByTestId("ai-switch-panel");
  const help = panel.getByText("How AI settings work", { exact: true });
  const details = panel.locator("details").first();
  const stage = page.locator("article").filter({ has: page.getByRole("heading", { name: "Evidence gap extraction", exact: true }) });
  const provider = stage.getByRole("combobox", { name: "Provider", exact: true });
  await provider.selectOption("openai");
  let writes = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/control")) writes++;
  });

  await expect(help).toBeVisible();
  await expect(details).not.toHaveAttribute("open");
  expect(await details.ariaSnapshot()).toBe("- group: How AI settings work");
  await expect(panel.getByText(/Stages may call the routed models/)).toBeHidden();
  await expect(panel.getByTestId("ai-switch-state")).toBeVisible();
  await expect(panel.getByText("AI by section")).toBeVisible();
  await help.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  expect(await details.ariaSnapshot()).toContain("Stages may call the routed models");
  await expect(panel.getByText(/Stages may call the routed models/)).toBeVisible();
  await expect(help).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).not.toHaveAttribute("open");
  expect(await details.ariaSnapshot()).toBe("- group: How AI settings work");
  await expect(panel.getByText(/Stages may call the routed models/)).toBeHidden();
  await expect(help).toBeFocused();
  await expect(provider).toHaveValue("openai");
  expect(writes).toBe(0);
  await expect(page).toHaveURL(/\/admin\/control$/);
});

test("provider setup help is optional while key and route status remain visible", async ({ page }) => {
  await page.goto("/admin/control");
  const card = page.getByTestId("provider-card-xai-grok");
  const help = card.getByText("Setup instructions", { exact: true });
  await expect(help).toBeVisible();
  await expect(card.getByTestId("provider-key-status")).toHaveText("No key");
  await expect(card.getByTestId("provider-key-env")).toBeHidden();
  await expect(page.getByTestId("providers-routed-to")).toBeVisible();
  await help.focus();
  await page.keyboard.press("Space");
  await expect(card.getByTestId("provider-key-env")).toBeVisible();
  await expect(help).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card.getByTestId("provider-key-env")).toBeHidden();
});

test("expanded control help fits both themes and zoom without hiding a routing error", async ({ page }, testInfo) => {
  await page.goto("/admin/control");
  const help = page.getByTestId("ai-switch-panel").getByText("How AI settings work", { exact: true });
  await expect(help).toBeVisible();
  await page.route("**/api/control", async route => {
    if (route.request().postDataJSON()?.action === "set_default_provider") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Route save failed. Retry the provider choice." }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Anthropic · Claude", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Route save failed. Retry the provider choice." })).toBeVisible();
  await expect(help).toBeVisible();
  await expect(page.getByTestId("ai-switch-panel").getByText(/Stages may call the routed models/)).toBeHidden();

  const aiDetails = page.getByTestId("ai-switch-panel").locator("details");
  await aiDetails.locator("summary").click();
  await expect(aiDetails).toHaveAttribute("open", "");
  await expect(aiDetails.getByText(/Stages may call the routed models/)).toBeVisible();
  const providerDetails = page.locator('[data-testid^="provider-card-"] details');
  await expect(providerDetails).toHaveCount(5);
  for (const details of await providerDetails.all()) {
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details.locator("p")).toBeVisible();
    await expect(details.locator("dd")).toHaveCount(2);
    await expect(details.locator("dd").last()).toBeVisible();
  }

  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    for (const [width, scale] of [[1440, 1], [390, 1], [780, 2]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(scale => { document.documentElement.style.zoom = String(scale); }, scale);
      const layout = await page.evaluate(() => {
        const details = [...document.querySelectorAll<HTMLElement>('[data-testid="ai-switch-panel"] details, [data-testid^="provider-card-"] details')];
        return {
          pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          overflowingHelp: details.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent?.slice(0, 60)),
          overflowingText: details.flatMap(node => [...node.querySelectorAll<HTMLElement>("p, li, dd")])
            .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent?.slice(0, 60)),
        };
      });
      expect(layout, `${theme} ${width}px zoom ${scale}`).toEqual({ pageFits: true, overflowingHelp: [], overflowingText: [] });
      await expect(aiDetails.getByText(/Stages may call the routed models/)).toBeVisible();
      for (const details of await providerDetails.all()) await expect(details.locator("dd").last()).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "Route save failed. Retry the provider choice." })).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`expanded-control-help-${theme}-${width}-${scale}x.png`), fullPage: true });
    }
  }
  await expect(page).toHaveURL(/\/admin\/control$/);
});

test.describe("Matrix placement help", () => {
  freshWorkspace({ name: "KAN-198 matrix help", seed: async request => {
    const gap = await iegpAction(request, { action: "create_gap", name: "Matrix help gap", statement: "A comparison remains to be reviewed", domain: "comparative_effectiveness" });
    await iegpAction(request, { action: "validate_gap", gap_id: String(gap.id), note: "Ready for priority review" });
  } });

  test("opened methodology fits the active matrix without changing axes or saving", async ({ page }, testInfo) => {
    await page.goto("/?place=plan&setting=all");
    const axes = page.getByTestId("matrix-axes");
    await expect(axes).toBeVisible();
    const choices = await axes.locator("select").evaluateAll(nodes => nodes.map(node => (node as HTMLSelectElement).value));
    expect(choices).toHaveLength(2);
    const summary = page.getByText("How matrix placement works", { exact: true });
    const details = page.locator("details").filter({ has: summary });
    await expect(details).not.toHaveAttribute("open");
    let writes = 0;
    page.on("request", request => {
      if (request.method() === "POST" && request.url().endsWith("/api/plan")) writes++;
    });
    await summary.click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText(/The quadrant only suggests a priority/)).toBeVisible();

    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
      for (const [width, scale] of [[1440, 1], [390, 1], [780, 2]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(scale => { document.documentElement.style.zoom = String(scale); }, scale);
        const layout = await page.evaluate(() => {
          const help = [...document.querySelectorAll<HTMLElement>("details")]
            .find(node => node.querySelector("summary")?.textContent === "How matrix placement works");
          const text = help?.querySelector<HTMLElement>("p");
          return {
            pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
            helpFits: Boolean(help && help.scrollWidth <= help.clientWidth + 1),
            textFits: Boolean(text && text.scrollWidth <= text.clientWidth + 1),
          };
        });
        expect(layout, `${theme} ${width}px zoom ${scale}`).toEqual({ pageFits: true, helpFits: true, textFits: true });
        await expect(details.getByText(/The quadrant only suggests a priority/)).toBeVisible();
        await details.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`expanded-matrix-help-${theme}-${width}-${scale}x.png`), fullPage: true });
      }
    }
    expect(await axes.locator("select").evaluateAll(nodes => nodes.map(node => (node as HTMLSelectElement).value))).toEqual(choices);
    expect(writes).toBe(0);
    await expect(page).toHaveURL(/place=plan&setting=all/);
  });
});

test("long workspace context remains readable at phone width and 200% layout zoom", async ({ page }, testInfo) => {
  const context = "The evidence review covers long-term comparative effectiveness in moderate-to-severe psoriasis across several treatment sequences. ".repeat(2)
    + "PROTOCOL-VERY-LONG-IDENTIFIER-THAT-MUST-WRAP-WITHOUT-HIDING-THE-REST-OF-THE-DECISION-CONTEXT";
  await page.goto("/setup");
  await page.getByRole("button", { name: /Company & plan/ }).first().click();
  await expect(page.getByTestId("setup-step-company")).toBeVisible();
  await page.getByLabel("Company situation").fill(context);
  await expect(page.getByTestId("setup-saved-at")).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: /Review & finish/ }).first().click();
  await expect(page.getByTestId("setup-step-review")).toContainText(context);

  for (const [width, scale] of [[390, 1], [780, 2]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(scale => { document.documentElement.style.zoom = String(scale); }, scale);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 12).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80) })),
    }));
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth + 1);
    await expect(page.getByTestId("setup-saved-at")).toHaveText("Unsaved changes");
    await page.getByTestId("setup-summary-company").evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: testInfo.outputPath(`workspace-context-${width}-${scale}x.png`), fullPage: false });
  }
});
