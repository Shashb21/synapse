import { expect, test, type Page } from "@playwright/test";
import { iegpAction } from "../support/synapse";

/**
 * Room is a PowerPoint-style presenter view over the real app pages: the
 * consultant drives (and edits) the live page, the audience window follows.
 */

async function startAtFirstSlide(page: Page) {
  await page.goto("/room");
  await expect(page.getByTestId("presenter-console")).toBeVisible();
  // Home jumps to the first slide (the slide list does the same with a click).
  await page.keyboard.press("Home");
  await expect(page.getByTestId("room-slide-position")).toHaveText("1 / 7");
}

test("/presentation redirects to the Room presenter view", async ({ page }) => {
  await page.goto("/presentation");
  await expect(page).toHaveURL(/\/room$/);
  await expect(page.getByTestId("presenter-console")).toBeVisible();
});

test("keyboard moves between the real pages, chrome-free", async ({ page }) => {
  await startAtFirstSlide(page);
  const current = page.getByTestId("room-current-frame");
  await expect(current).toHaveAttribute("src", "/setup?present=1");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("room-slide-position")).toHaveText("2 / 7");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Gaps");
  await expect(current).toHaveAttribute("src", "/?place=gaps&present=1");
  await expect(page.getByTestId("room-next-frame")).toHaveAttribute("data-href", "/mappings");

  // The live page is the real one, with the app nav hidden.
  const frame = page.frameLocator('[data-testid="room-current-frame"]');
  await expect(frame.locator("main")).toBeVisible();
  await expect(frame.locator("aside").first()).toBeHidden();

  await page.keyboard.press("PageDown");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Mappings");
  await page.keyboard.press(" ");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Prioritize");
  await page.keyboard.press("PageUp");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Mappings");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Gaps");
  await page.getByRole("button", { name: "Next slide" }).click();
  await expect(page.getByTestId("room-slide-title")).toHaveText("Mappings");
  // Wait for the server to have the move before reloading.
  await expect
    .poll(async () => ((await (await page.request.get("/api/room")).json()) as { state: { slide_id: string } }).state.slide_id)
    .toBe("mappings");

  // The current slide survives a reload (stored per workspace).
  await page.reload();
  await expect(page.getByTestId("room-slide-title")).toHaveText("Mappings");
});

test("speaker notes save per slide", async ({ page }) => {
  await startAtFirstSlide(page);
  await page.keyboard.press("ArrowRight");
  const text = `Lead with the elderly RWD gap ${Date.now()}`;
  const notes = page.getByTestId("room-notes");
  await notes.fill(text);
  await expect(page.getByTestId("room-notes-status")).toHaveText("Saved");
  // Arrow keys inside the notes do not change slide.
  await notes.press("ArrowRight");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Gaps");

  await page.reload();
  await expect(page.getByTestId("room-slide-title")).toHaveText("Gaps");
  await expect(page.getByTestId("room-notes")).toHaveValue(text);
  await page.getByRole("button", { name: "Next slide" }).click();
  await expect(page.getByTestId("room-notes")).toHaveValue("");
});

test("the audience window follows the presenter and picks up edits", async ({ page, context }) => {
  await startAtFirstSlide(page);
  const [audience] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Open audience window" }).click(),
  ]);
  await audience.waitForLoadState();
  await expect(audience).toHaveURL(/\/room\/audience$/);
  const shown = audience.getByTestId("audience-frame");
  await expect(shown).toHaveAttribute("data-href", "/setup");
  await expect(audience.getByText("Speaker notes")).toHaveCount(0);

  await page.bringToFront();
  await page.keyboard.press("ArrowRight");
  await expect(shown).toHaveAttribute("data-href", "/?place=gaps");
  await page.keyboard.press("ArrowRight");
  await expect(shown).toHaveAttribute("data-href", "/mappings");

  // The audience page is chrome-free too.
  const audienceFrame = audience.frameLocator('[data-testid="audience-frame"]');
  await expect(audienceFrame.locator("main")).toBeVisible();
  await expect(audienceFrame.locator("aside").first()).toBeHidden();

  // An edit made in the presenter's live page reloads the audience's copy.
  await audience.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="audience-frame"]');
    (frame!.contentWindow as Window & { __stale?: boolean }).__stale = true;
  });
  const presenterFrame = page.frame({ url: /\/mappings\?present=1/ });
  expect(presenterFrame).not.toBeNull();
  await presenterFrame!.evaluate(async () => {
    await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create_breakout_group",
        name: `Edited live ${Date.now()}`,
        actor_name: "Room E2E",
        actor_function: "medical_affairs",
      }),
    });
  });
  await expect
    .poll(
      () =>
        audience.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>('[data-testid="audience-frame"]');
          return Boolean((frame?.contentWindow as (Window & { __stale?: boolean }) | null)?.__stale);
        }),
      { timeout: 15_000 },
    )
    .toBe(false);
  await expect(shown).toHaveAttribute("data-href", "/mappings");
});

test("Breakouts are one tab away, and a breakout room switches back to Room", async ({ page, request }) => {
  const name = `Room breakout ${Date.now()}`;
  await iegpAction(request, { action: "create_breakout_group", name });

  await page.goto("/room");
  await page.getByRole("button", { name: "Breakouts" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();
  const href = await row.getByRole("link", { name: /Open room/ }).getAttribute("href");
  expect(href).toMatch(/^\/breakouts\//);

  await page.goto(href!);
  await page.getByRole("link", { name: /Switch to presentation/ }).click();
  await expect(page).toHaveURL(/\/room$/);

  await page.getByRole("button", { name: "Breakouts" }).click();
  await page.getByRole("link", { name: "Manage breakout groups" }).click();
  await expect(page).toHaveURL(/\/breakouts$/);
});

test("Esc ends the show and returns to Prep", async ({ page }) => {
  await page.goto("/room");
  await expect(page.getByTestId("presenter-console")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/(\?.*)?$/);
});
