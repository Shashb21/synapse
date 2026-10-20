import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test, type Page } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, iegpAction, runStage, seedMapped, validateBandHigh } from "../support/synapse";
import { openIdeationCard } from "../support/ideation";

test.describe.configure({ mode: "serial" });

// KAN-50: the design's tactic edit side panel on Tactic Ideation.
test.describe("tactic side panel", () => {
  let gapId = "";
  freshWorkspace({
    name: "KAN-50",
    seed: async (request) => {
      await seedMapped(request);
      await runStage(request, "S8");
      const gap = await firstOpenGap(request);
      gapId = gap.gap_id;
      await validateBandHigh(request, gap.gap_id, "High for the side panel test");
      // A proposed tactic mapped onto the gap, for the panel to edit.
      await iegpAction(request, {
        action: "create_tactic",
        origin: "tactics",
        gap_id: gap.gap_id,
        name: "Panel test registry study",
        rationale: "Record the study relationship for shared panel review",
        type: "registry",
        evidence_question: "What is 12-month persistence in routine care?",
        status: "proposed",
        actor_name: "Feature E2E",
        actor_function: "medical_affairs",
      });
    },
  });

  async function openFirstLinked(page: Page) {
    await page.goto("/?place=tactics");
    const card = await openIdeationCard(page, gapId);
    const panel = page.getByTestId("tactic-panel");
    const row = card.getByRole("list").first().getByRole("button").first();
    await expect(async () => {
      await row.click({ timeout: 5_000 });
      await expect(panel).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    return { card, panel };
  }

  test("shows current details before collapsed shared history and a full-record route", async ({ page }) => {
    const { panel } = await openFirstLinked(page);
    await expect(panel.getByRole("link", { name: "Open full record", exact: true })).toHaveAttribute("href", /\/tactics\//);
    await expect(panel.getByRole("term").filter({ hasText: /^Type$/ })).toBeVisible();
    await expect(panel.locator("dl").first()).toContainText("Registry");
    const history = panel.getByRole("group", { name: "History", exact: true });
    await expect(history).not.toHaveAttribute("open");
    await expect(panel.getByRole("region", { name: "Gaps this tactic is mapped to" })).toBeVisible();
    await history.locator("summary").first().click();
    await expect(history).toContainText("Read-only, newest first");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("asks for a change and a rationale before saving", async ({ page }) => {
    test.setTimeout(90_000);
    const { panel } = await openFirstLinked(page);
    await panel.getByRole("button", { name: /^save changes$/i }).click();
    await expect(panel.getByRole("alert")).toHaveText("Nothing changed.");
    await panel.getByLabel(/^budget$/i).fill("$480K");
    await panel.getByRole("button", { name: /^save changes$/i }).click();
    await expect(panel.getByRole("alert")).toContainText(/rationale is required/i);
    page.once("dialog", dialog => dialog.accept());
    await panel.getByRole("button", { name: /^cancel$/i }).click();
    await expect(panel).toBeHidden();
  });

  test("saves budget, lead and status without leaving the page", async ({ page }) => {
    test.setTimeout(90_000);
    const { panel } = await openFirstLinked(page);
    const name = await panel.getByLabel(/^tactic name$/i).inputValue();
    await panel.getByLabel(/^budget$/i).fill("$480K");
    await panel.getByLabel(/^lead \(owner\)$/i).fill("A. Rao");
    await panel.getByRole("combobox", { name: "Status" }).selectOption("planned");
    await panel.getByLabel(/why\? \(required\)/i).fill("Budget approved at the Q3 review");
    await panel.getByRole("button", { name: /^save changes$/i }).click();
    // The panel closes once the refreshed page data is in, which a dev server can take a while to render.
    await expect(panel).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(/place=tactics/);

    // Planned counts toward addressing, so the gap may leave Tactic Ideation; the library keeps the tactic.
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await library.getByRole("button", { name: /tactic library/i }).click();
    const item = library.getByRole("listitem").filter({ hasText: name });
    await expect(item).toContainText("planned");
    await item.getByRole("button", { name: /✎ edit/i }).click();
    await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$480K");
    await expect(panel.getByLabel(/^lead \(owner\)$/i)).toHaveValue("A. Rao");
    await expect(panel.getByRole("combobox", { name: "Status" })).toHaveValue("planned");
    const history = panel.getByRole("group", { name: "History", exact: true });
    await history.locator("summary").first().click();
    await expect(history).toContainText("Budget approved at the Q3 review");
    await expect(history).toContainText("Feature E2E");
    await expect(history).toContainText("proposed");
    await expect(history).toContainText("$480K");
  });

  test("opens from the Tactic Library too", async ({ page }) => {
    await page.goto("/?place=tactics");
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await expect(async () => {
      await library.getByRole("button", { name: /tactic library/i }).click({ timeout: 5_000 });
      await expect(library.getByRole("searchbox", { name: /search library/i })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await library.getByRole("button", { name: /✎ edit/i }).first().click();
    await expect(page.getByTestId("tactic-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tactic-panel")).toBeHidden();
  });

  async function openLibraryPanel(page: Page) {
    await page.goto("/?place=tactics");
    await page.getByPlaceholder("Search gaps…").fill("Retained board filter");
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await library.getByRole("button", { name: /tactic library/i }).click();
    await library.getByRole("searchbox", { name: "Search library" }).fill("Panel test registry");
    const trigger = library.getByRole("button", { name: /✎ edit/i }).first();
    await trigger.focus();
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("tactic-panel");
    await expect(panel.getByLabel(/^tactic name$/i)).toHaveValue("Panel test registry study");
    return { library, trigger, panel, scrollY };
  }

  test("narrow-screen keyboard inspection returns focus, filters and position", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { library, trigger, panel, scrollY } = await openLibraryPanel(page);
    const dialog = page.getByRole("dialog", { name: "Tactic details", exact: true });
    const bounds = await dialog.boundingBox();
    expect(bounds?.width).toBeCloseTo(390, 0);
    expect(bounds?.height).toBeCloseTo(844, 0);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    const history = panel.getByRole("group", { name: "History", exact: true });
    await history.locator("summary").first().focus();
    await page.keyboard.press("Enter");
    await expect(history).toHaveAttribute("open");
    await dialog.screenshot({ path: testInfo.outputPath("tactic-panel-narrow.png") });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await expect(library.getByRole("searchbox")).toHaveValue("Panel test registry");
    await expect(page.getByPlaceholder("Search gaps…")).toHaveValue("Retained board filter");
    await expect(page).toHaveURL(/place=tactics/);
  });

  test("keeps drafts through dirty Escape, failed save and detail refresh, then retries the same submission", async ({ page }) => {
    test.setTimeout(90_000);
    const { panel, trigger } = await openLibraryPanel(page);
    await panel.getByLabel(/^budget$/i).fill("$510K");
    const reason = panel.getByLabel(/why\? \(required\)/i);
    await reason.fill("Retain this draft and opening version through failures");
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/iegp", async route => {
      if (route.request().method() === "POST" && route.request().postDataJSON().action === "modify_tactic") {
        bodies.push(route.request().postDataJSON());
        if (bodies.length === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Save failed; retry the same draft" }) });
      }
      await route.continue();
    });
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Save failed");
    page.once("dialog", dialog => dialog.dismiss());
    await page.keyboard.press("Escape");
    await expect(reason).toHaveValue("Retain this draft and opening version through failures");
    await page.route("**/api/tactics/*", route => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await panel.getByRole("button", { name: "Refresh tactic details" }).click();
    await expect(panel.getByRole("alert").filter({ hasText: "could not be loaded" })).toBeVisible();
    await expect(panel).toContainText("Showing previously loaded details");
    await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$510K");
    await page.unroute("**/api/tactics/*");
    await panel.getByRole("button", { name: "Retry tactic details" }).click();
    await expect(panel.getByRole("button", { name: "Retry tactic details" })).toHaveCount(0);
    await expect(reason).toHaveValue("Retain this draft and opening version through failures");
    const retryResponse = page.waitForResponse(response => response.url().endsWith("/api/iegp") && response.request().method() === "POST");
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    const saved = await retryResponse;
    expect(saved.ok(), await saved.text()).toBe(true);
    await expect(panel).toBeHidden({ timeout: 30_000 });
    expect(bodies[1]).toEqual(bodies[0]);
    await expect(trigger).toBeFocused();
  });

  test("revalidates current details without replacing an open draft or its stale-write token", async ({ page, request }) => {
    const { panel } = await openLibraryPanel(page);
    const href = await panel.getByRole("link", { name: "Open full record", exact: true }).getAttribute("href");
    const tacticId = href!.split("/").pop()!;
    await panel.getByLabel(/^lead \(owner\)$/i).fill("Unsaved draft lead");
    await panel.getByLabel(/why\? \(required\)/i).fill("Keep this concurrent edit draft");
    const colleagueOpening = await (await request.get(`/api/tactics/${tacticId}`)).json();
    await iegpAction(request, { action: "modify_tactic", tactic_id: tacticId, expected_tactic: colleagueOpening.version, budget: "$620K", rationale: "Concurrent budget review by a colleague" });
    await panel.getByRole("button", { name: "Refresh tactic details" }).click();
    await expect(panel.getByRole("definition").filter({ hasText: "$620K" })).toBeVisible();
    await expect(panel.getByLabel(/^lead \(owner\)$/i)).toHaveValue("Unsaved draft lead");
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Tactic changed since you opened it");
    await expect(panel.getByLabel(/why\? \(required\)/i)).toHaveValue("Keep this concurrent edit draft");
    page.once("dialog", dialog => dialog.dismiss());
    await panel.getByRole("link", { name: "Open full record", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/place=tactics/);
    page.once("dialog", dialog => dialog.accept());
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    const saved = await request.get(`/api/tactics/${tacticId}`).then(response => response.json());
    expect(saved.tactic.owner).toBe("A. Rao");
    expect(saved.tactic.budget).toBe("$620K");
  });

  test("linked-record navigation opens the same panel, preserves new tabs, and shares the full-record editor", async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.goto(`/gaps/${gapId}`);
    const trigger = page.getByRole("link", { name: "Panel test registry study", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("tactic-panel");
    await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$620K");
    const href = await panel.getByRole("link", { name: "Open full record", exact: true }).getAttribute("href");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const nextPage = context.waitForEvent("page");
    await trigger.click({ button: "middle" });
    const full = await nextPage;
    try {
      await expect(full).toHaveURL(new RegExp(href!));
      await full.bringToFront();
      const form = full.getByRole("form", { name: /Edit Panel test registry/ });
      await expect(async () => {
        if (!await form.isVisible()) await full.getByRole("button", { name: "Edit tactic", exact: true }).click({ timeout: 3_000 });
        await expect(form).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await form.getByText("Study details", { exact: true }).click();
      await form.getByLabel("Population", { exact: true }).fill("Adults in routine care");
      await form.getByLabel(/why\? \(required\)/i).fill("Clarify the population in the shared editor");
      await form.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(form).toBeHidden();
      await expect(full.getByRole("definition").filter({ hasText: "Adults in routine care" })).toBeVisible();
      const history = full.getByRole("group", { name: "History", exact: true });
      await expect(history).not.toHaveAttribute("open");
      await history.locator("summary").first().click();
      await expect(history).toContainText("Clarify the population in the shared editor");
    } finally { await full.close(); }
  });

  test("unavailable initial details keep selection, focus and the full-record route until retry", async ({ page }) => {
    await page.route("**/api/tactics/*", route => route.fulfill({ status: 403, contentType: "application/json", body: "{}" }));
    await page.goto("/?place=tactics");
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await library.getByRole("button", { name: /tactic library/i }).click();
    const trigger = library.getByRole("button", { name: /✎ edit/i }).first();
    await trigger.click();
    const panel = page.getByTestId("tactic-panel");
    await expect(panel.getByRole("alert")).toContainText("do not currently have access");
    await expect(panel.getByRole("link", { name: "Open full record", exact: true })).toBeVisible();
    await page.unroute("**/api/tactics/*");
    await panel.getByRole("button", { name: "Retry tactic details" }).click();
    await expect(panel.getByRole("form")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });


  test("navigation guard keeps full-record drafts when mapped-gap and application navigation are dismissed", async ({ page }) => {
    const { panel } = await openLibraryPanel(page);
    const href = await panel.getByRole("link", { name: "Open full record", exact: true }).getAttribute("href");
    await page.keyboard.press("Escape");
    await page.goto(href!);
    const form = page.getByRole("form", { name: /Edit Panel test registry/ });
    await expect(async () => {
      if (!await form.isVisible()) await page.getByRole("button", { name: "Edit tactic", exact: true }).click({ timeout: 3_000 });
      await expect(form).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await form.getByLabel(/^budget$/i).fill("$811K");
    const reason = form.getByLabel(/why\? \(required\)/i);
    await reason.fill("Keep this full-record budget and reason");
    const prompts: string[] = [];
    page.on("dialog", async dialog => { prompts.push(dialog.type()); await dialog.dismiss(); });
    await page.getByRole("region", { name: "Gaps this tactic is mapped to" }).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(href!));
    await expect(form.getByLabel(/^budget$/i)).toHaveValue("$811K");
    await expect(reason).toHaveValue("Keep this full-record budget and reason");
    await page.getByRole("navigation", { name: "Places", exact: true }).getByRole("link", { name: /Evidence Inventory/ }).click();
    await expect(page).toHaveURL(new RegExp(href!));
    await expect(reason).toHaveValue("Keep this full-record budget and reason");
    expect(prompts).toEqual(["confirm", "confirm"]);
    let finishSave!: () => void;
    const saveGate = new Promise<void>(resolve => { finishSave = resolve; });
    await page.route("**/api/iegp", async route => {
      await saveGate;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Navigation guard save failure" }) });
    });
    try {
      await form.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(form.getByRole("button", { name: "Saving…", exact: true })).toBeVisible();
      await page.getByRole("region", { name: "Gaps this tactic is mapped to" }).getByRole("link").first().click();
      await expect(page).toHaveURL(new RegExp(href!));
      expect(prompts).toEqual(["confirm", "confirm"]);
      finishSave();
      await expect(form.getByRole("alert")).toContainText("Navigation guard save failure");
      await expect(reason).toHaveValue("Keep this full-record budget and reason");
    } finally { finishSave(); await page.unroute("**/api/iegp"); }
    page.removeAllListeners("dialog");
    page.once("dialog", dialog => dialog.accept());
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toBeHidden();
    await page.getByRole("region", { name: "Gaps this tactic is mapped to" }).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/gaps\//);
  });

  for (const withoutNavigation of [false, true]) {
    test(`navigation guard retains a panel draft on reload and same-document browser Back${withoutNavigation ? " without Navigation API" : ""}`, async ({ page }) => {
      if (withoutNavigation) await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { value: undefined, configurable: true });
      });
      // A real client navigation gives Back a same-document application entry to traverse.
      await page.goto(`/gaps/${gapId}`);
      await page.getByRole("navigation", { name: "Places", exact: true }).getByRole("link", { name: /Tactic Ideation/ }).click();
      await expect(page).toHaveURL(/place=tactics/);
      const library = page.getByRole("region", { name: /^tactic library$/i });
      await expect(async () => {
        if (!await library.getByRole("searchbox").isVisible()) await library.getByRole("button", { name: /tactic library/i }).click({ timeout: 3_000 });
        await expect(library.getByRole("searchbox")).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await library.getByRole("searchbox").fill("Panel test registry");
      const trigger = library.getByRole("button", { name: /✎ edit/i }).first();
      await trigger.click();
      const panel = page.getByTestId("tactic-panel");
      await panel.getByLabel(/^budget$/i).fill("$812K");
      const reason = panel.getByLabel(/why\? \(required\)/i);
      await reason.fill("Keep this panel budget and reason through browser navigation");
      let unloads = 0;
      const dismissUnload = async (dialog: import("@playwright/test").Dialog) => { unloads++; expect(dialog.type()).toBe("beforeunload"); await dialog.dismiss(); };
      page.on("dialog", dismissUnload);
      // Chromium rejects a cancelled reload with ERR_ABORTED; the retained document is the assertion.
      await page.reload({ timeout: 5_000 }).catch(() => null);
      expect(unloads).toBe(1);
      page.off("dialog", dismissUnload);
      await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$812K");
      await expect(reason).toHaveValue("Keep this panel budget and reason through browser navigation");
      const backDialog = page.waitForEvent("dialog");
      const back = page.goBack({ timeout: 5_000 }).catch(() => null);
      const confirm = await backDialog;
      expect(confirm.type()).toBe("confirm");
      await confirm.dismiss();
      await back;
      await expect(page).toHaveURL(/place=tactics/);
      await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$812K");
      await expect(reason).toHaveValue("Keep this panel budget and reason through browser navigation");
      // Accepting Back navigates once. Opening a new panel on that gap must also guard Forward.
      page.once("dialog", dialog => dialog.accept());
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/gaps/${gapId}$`));
      await page.getByRole("link", { name: "Panel test registry study", exact: true }).click();
      await panel.getByLabel(/^budget$/i).fill("$813K");
      await reason.fill("Keep the new linked-panel draft on Forward");
      const forwardDialog = page.waitForEvent("dialog");
      const forward = page.goForward({ timeout: 5_000 }).catch(() => null);
      await (await forwardDialog).dismiss();
      await forward;
      await expect(page).toHaveURL(new RegExp(`/gaps/${gapId}$`));
      await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$813K");
      await expect(reason).toHaveValue("Keep the new linked-panel draft on Forward");
      page.once("dialog", dialog => dialog.accept());
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("link", { name: "Panel test registry study", exact: true })).toBeFocused();
      await page.goForward();
      await expect(page).toHaveURL(/place=tactics/);
    });
  }

  for (const withoutNavigation of [false, true, "without-randomUUID"] as const) {
    test(`native fragment helper restores the exact entry and permits another cancelled traversal${withoutNavigation ? ` without Navigation API${withoutNavigation === "without-randomUUID" ? " or randomUUID" : ""}` : ""}`, async ({ page }) => {
      if (withoutNavigation) await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined, configurable: true }));
      if (withoutNavigation === "without-randomUUID") await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true }));
      await page.route("**/tactic-history-probe", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><input aria-label='Draft'></body></html>" }));
      await page.goto("/tactic-history-probe");
      // Execute the actual public helper against browser history, without Next repairing entries.
      const helper = ts.transpileModule(readFileSync("src/lib/tactic-draft-navigation.ts", "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
      }).outputText;
      await page.addScriptTag({ content: `(() => { const exports = {}; ${helper}
        window.historyProbeDenials = 0;
        exports.installTacticDraftNavigation().protect(() => { window.historyProbeDenials++; return false; });
      })();` });
      await page.evaluate(() => history.pushState({ nextKey: "preserved" }, "", "/before"));
      await page.evaluate(() => { location.hash = "native-fragment"; });
      await expect(page).toHaveURL(/\/before#native-fragment$/);
      await page.evaluate(() => history.pushState({ nextKey: "preserved" }, "", "/draft"));
      await page.getByLabel("Draft").fill("Unsaved helper probe");
      const length = await page.evaluate(() => history.length);
      const offsets = [2, 1, 2]; // Include the null-state fragment itself and a repeat after restoration.
      for (const [attempt, offset] of offsets.entries()) {
        await page.evaluate(offset => history.go(-offset), offset);
        await expect.poll(() => page.evaluate(() => (window as unknown as Window & { historyProbeDenials: number }).historyProbeDenials)).toBe(attempt + 1);
        await expect(page).toHaveURL(/\/draft$/);
        await expect(page.getByLabel("Draft")).toHaveValue("Unsaved helper probe");
        expect(await page.evaluate(() => history.state.nextKey)).toBe("preserved");
        expect(await page.evaluate(() => history.length)).toBe(length);
      }
    });
  }

  for (const withoutNavigation of [false, true]) {
    test(`native fragment entries do not misdirect cancelled multi-entry history or leave restoration armed${withoutNavigation ? " without Navigation API" : ""}`, async ({ page }) => {
      await page.addInitScript(withoutNavigation => {
        Object.defineProperty(window, "historyTestOracle", { value: (window as unknown as Window & { navigation: unknown }).navigation });
        if (withoutNavigation) Object.defineProperty(window, "navigation", { value: undefined, configurable: true });
      }, withoutNavigation);
      await page.goto(`/gaps/${gapId}`);
      await page.getByRole("navigation", { name: "Places", exact: true }).getByRole("link", { name: /Tactic Ideation/ }).click();
      await expect(page).toHaveURL(/place=tactics/);
      const before = page.url();
      await page.evaluate(() => { location.hash = "native-fragment"; });
      const fragment = `${before}#native-fragment`;
      await expect(page).toHaveURL(fragment);
      // Use actual Next links for the final entry so its URL and router state agree.
      const library = page.getByRole("region", { name: /^tactic library$/i });
      await expect(async () => {
        if (!await library.getByRole("searchbox").isVisible()) await library.getByRole("button", { name: /tactic library/i }).click({ timeout: 3_000 });
        await expect(library.getByRole("searchbox")).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await library.getByRole("link", { name: gapId, exact: true }).first().click();
      await page.getByRole("dialog", { name: "Gap details", exact: true }).getByRole("link", { name: "Open full record", exact: true }).click();
      const draft = new URL(`/gaps/${gapId}`, before).href;
      await expect(page).toHaveURL(draft);
      const draftKey = await page.evaluate(() => (window as unknown as Window & { historyTestOracle: { currentEntry: { key: string } } }).historyTestOracle.currentEntry.key);
      await page.getByRole("link", { name: "Panel test registry study", exact: true }).click();
      const panel = page.getByTestId("tactic-panel");
      await panel.getByLabel(/^budget$/i).fill("$814K");
      const reason = panel.getByLabel(/why\? \(required\)/i);
      await reason.fill("Preserve this draft across native fragment history");
      await expect(page).toHaveURL(draft);
      const entries = await page.evaluate(() => (window as unknown as Window & { historyTestOracle: { entries: () => { url: string }[] } }).historyTestOracle.entries().map(entry => entry.url));
      expect(entries.slice(-3)).toEqual([before, fragment, draft]);
      const length = await page.evaluate(() => history.length);
      for (const offset of [2, 1, 2]) {
        const prompt = page.waitForEvent("dialog", { timeout: 5_000 });
        await page.evaluate(offset => history.go(-offset), offset);
        const dialog = await prompt;
        expect(dialog.type()).toBe("confirm");
        await dialog.dismiss();
        await expect(page).toHaveURL(draft);
        expect(await page.evaluate(() => (window as unknown as Window & { historyTestOracle: { currentEntry: { key: string } } }).historyTestOracle.currentEntry.key)).toBe(draftKey);
        await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$814K");
        await expect(reason).toHaveValue("Preserve this draft across native fragment history");
        expect(await page.evaluate(() => history.length)).toBe(length);
      }
      page.once("dialog", dialog => dialog.accept());
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.goBack();
      await expect(page).toHaveURL(fragment);
      await page.goForward();
      await expect(page).toHaveURL(draft);
    });
  }

  test("legacy fragment replacement and branching preserve exact traversal after reloading an older entry", async ({ page }) => {
    const helper = ts.transpileModule(readFileSync("src/lib/tactic-draft-navigation.ts", "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    await page.addInitScript({ content: `(() => {
      Object.defineProperty(window, "navigation", { value: undefined, configurable: true });
      const exports = {}; ${helper}
      window.historyProbeDenials = 0; window.historyProbeBlocked = false;
      exports.installTacticDraftNavigation().protect(() => {
        if (!window.historyProbeBlocked) return true;
        window.historyProbeDenials++; return false;
      });
    })();` });
    await page.route("**/tactic-history-probe/**", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><input aria-label='Draft'><input aria-label='Reason'>",
    }));
    await page.goto("/tactic-history-probe/base");
    const setBlocked = (blocked: boolean) => page.evaluate(blocked => {
      (window as unknown as Window & { historyProbeBlocked: boolean }).historyProbeBlocked = blocked;
    }, blocked);
    const cancel = async (offset: number) => {
      const url = page.url();
      const length = await page.evaluate(() => history.length);
      const count = await page.evaluate(() => (window as unknown as Window & { historyProbeDenials: number }).historyProbeDenials);
      await page.evaluate(offset => history.go(offset), offset);
      await expect.poll(() => page.evaluate(() => (window as unknown as Window & { historyProbeDenials: number }).historyProbeDenials)).toBe(count + 1);
      await expect(page).toHaveURL(url);
      await expect(page.getByLabel("Draft")).toHaveValue("Keep this draft");
      await expect(page.getByLabel("Reason")).toHaveValue("Keep this reason");
      expect(await page.evaluate(() => history.length)).toBe(length);
    };
    await page.evaluate(() => history.pushState({ __NA: true, nextKey: "before" }, "", "/tactic-history-probe/before"));
    await page.evaluate(() => { location.hash = "native"; });
    await expect(page).toHaveURL(/#native$/);
    await page.evaluate(() => history.pushState({ __NA: true, nextKey: "forward" }, "", "/tactic-history-probe/forward"));
    await page.goBack();
    await expect(page).toHaveURL(/#native$/);
    // Native replace retains forward history. Engines differ on whether it retains state.
    await page.evaluate(() => location.replace("#replacement"));
    await expect(page).toHaveURL(/#replacement$/);
    await page.getByLabel("Draft").fill("Keep this draft");
    await page.getByLabel("Reason").fill("Keep this reason");
    await setBlocked(true);
    for (const offset of [1, -1, 1]) await cancel(offset);
    await setBlocked(false);
    const length = await page.evaluate(() => history.length);
    // A push at this point truncates exactly one forward entry, leaving length unchanged.
    await page.evaluate(() => { location.hash = "branch"; });
    await expect(page).toHaveURL(/#branch$/);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.evaluate(() => history.pushState({ __NA: true, nextKey: "draft" }, "", "/tactic-history-probe/draft"));
    await setBlocked(true);
    for (const offset of [-2, -1, -2]) await cancel(offset);
    await setBlocked(false);
    await page.goBack();
    await expect(page).toHaveURL(/#branch$/);
    await page.reload();
    await page.getByLabel("Draft").fill("Keep this draft");
    await page.getByLabel("Reason").fill("Keep this reason");
    await setBlocked(true);
    for (const offset of [1, -1, 1]) await cancel(offset);
  });

  test("lifecycle actions refresh linked-panel details without replacing a dirty field draft", async ({ page }) => {
    await page.goto(`/gaps/${gapId}`);
    await page.getByRole("link", { name: "Panel test registry study", exact: true }).click();
    const panel = page.getByTestId("tactic-panel");
    await panel.getByLabel(/^budget$/i).fill("$700K");
    await panel.getByLabel(/why\? \(required\)/i).fill("Keep the field draft while reviewing the tactic");
    await panel.getByRole("button", { name: "Reject tactic", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Reject tactic", exact: true });
    await review.getByLabel("Rationale (required)").fill("Reviewing the library decision separately");
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(panel.getByText("Review: rejected", { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/^budget$/i)).toHaveValue("$700K");
    await expect(panel.getByLabel(/why\? \(required\)/i)).toHaveValue("Keep the field draft while reviewing the tactic");
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Tactic changed since you opened it");
    page.once("dialog", dialog => dialog.accept());
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("board library links require a reason and retain the shared relationship event", async ({ page, request }) => {
    const readyGap = await iegpAction(request, { action: "create_gap", name: "Library reuse comparison", statement: "Comparative persistence evidence is missing", domain: "comparative_effectiveness" });
    const libraryGapId = String(readyGap.id);
    await iegpAction(request, { action: "validate_gap", gap_id: libraryGapId, note: "Confirm the remaining evidence need for library reuse" });
    await validateBandHigh(request, libraryGapId, "Review this confirmed Open need before reusing existing work");
    const created = await iegpAction(request, { action: "record_missed_tactic", name: "Board reuse cohort", type: "rwe_study", status: "ongoing", evidence_question: "What is persistence in routine care?" });
    await page.goto("/?place=tactics");
    const card = await openIdeationCard(page, libraryGapId);
    await card.getByRole("button", { name: "+ Custom tactic", exact: true }).click();
    const custom = page.getByRole("dialog", { name: "+ Custom tactic", exact: true });
    await expect(custom.getByRole("textbox", { name: "Reason (required)", exact: true })).toHaveAttribute("required", "");
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Assign from library", exact: true }).click();
    const assign = page.getByRole("dialog", { name: "Assign from library", exact: true });
    await assign.getByRole("combobox").selectOption(String(created.id));
    await assign.getByRole("button", { name: "Link as unassessed", exact: true }).click();
    await expect(assign.getByRole("alert")).toContainText("Enter a rationale of at least three characters.");
    await assign.getByRole("textbox", { name: "Rationale (required)", exact: true }).fill("Review the existing cohort against this distinct evidence need");
    await assign.getByRole("button", { name: "Link as unassessed", exact: true }).click();
    await expect(assign).toBeHidden();
    const gap = await (await request.get(`/api/gaps/${libraryGapId}`)).json();
    const tactic = await (await request.get(`/api/tactics/${created.id}`)).json();
    const event = gap.history.find((entry: { entity_type: string; rationale: string }) => entry.entity_type === "gap_tactic" && entry.rationale === "Review the existing cohort against this distinct evidence need");
    expect(event).toBeTruthy();
    expect(tactic.history.find((entry: { id: string }) => entry.id === event.id)).toBeTruthy();
    expect(tactic.coverages.find((row: { gap_id: string }) => row.gap_id === libraryGapId).overall).toBe("unassessed");
  });

});
