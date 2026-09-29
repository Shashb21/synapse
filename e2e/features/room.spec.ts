import { expect, test, type Page } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction } from "../support/synapse";

// Room is out of the app for now (owner, KAN-52; src/lib/room/enabled.ts). These specs
// come back with it.
test.skip(true, "Room is turned off for now (ROOM_ENABLED = false)");

/**
 * Room is a PowerPoint-style presenter view over the real app pages: the
 * consultant drives (and edits) the live page, the audience window follows.
 *
 * Every wait here is on a condition, never a sleep:
 * - The console and audience pages embed live app pages in iframes, and a
 *   page's "load" waits for every frame, which a busy dev server can take past
 *   the test timeout to serve. Navigation waits for the DOM only; each check
 *   then waits for what it needs.
 * - A key pressed before hydration does nothing, so the specs wait for the
 *   console's (and audience's) `data-ready`, set once its listeners are on.
 * - The audience only moves once the presenter's save has returned and the
 *   next page has loaded in its hidden frame, so those checks allow a page load.
 */

/** Waits long enough for a live app page to load inside a frame on a busy dev server. */
const FRAME_LOAD = { timeout: 30_000 };

// Room state (current slide, notes) is stored per workspace: start from a new one.
freshWorkspace({ name: "Room" });

async function openRoom(page: Page) {
  await page.goto("/room", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("presenter-console")).toHaveAttribute("data-ready", "true", FRAME_LOAD);
}

async function reloadRoom(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("presenter-console")).toHaveAttribute("data-ready", "true", FRAME_LOAD);
}

/** The slide the server has, which is what a reload or a projector elsewhere sees. */
async function serverSlide(page: Page): Promise<string> {
  const res = await page.request.get("/api/room");
  return ((await res.json()) as { state: { slide_id: string } }).state.slide_id;
}

async function startAtFirstSlide(page: Page) {
  await openRoom(page);
  // Home jumps to the first slide (the slide list does the same with a click).
  await page.keyboard.press("Home");
  await expect(page.getByTestId("room-slide-position")).toHaveText("1 / 7");
}

test("/presentation redirects to the Room presenter view", async ({ page }) => {
  await page.goto("/presentation", { waitUntil: "domcontentloaded" });
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
  await expect(frame.locator("main")).toBeVisible(FRAME_LOAD);
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
  // Moves are saved one at a time, in order; wait for the server to have the last one.
  await expect.poll(() => serverSlide(page), FRAME_LOAD).toBe("mappings");

  // The current slide survives a reload (stored per workspace).
  await reloadRoom(page);
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

  await expect.poll(() => serverSlide(page), FRAME_LOAD).toBe("gaps");
  await reloadRoom(page);
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
  await audience.waitForLoadState("domcontentloaded");
  await expect(audience).toHaveURL(/\/room\/audience$/);
  await expect(audience.getByTestId("audience-view")).toHaveAttribute("data-ready", "true", FRAME_LOAD);
  const shown = audience.getByTestId("audience-frame");
  // The audience asks the presenter for the current slide as it opens.
  for (let i = 0; i < 20; i++) { if (i > 3 && (await shown.getAttribute("data-href")) === "/setup") break;
    const info = await audience.evaluate(() => ({
      vis: document.visibilityState,
      frames: [...document.querySelectorAll("iframe")].map((f) => ({
        id: f.dataset.testid, href: f.dataset.href, rs: (() => { try { return f.contentDocument?.readyState + " " + f.contentWindow?.location.href; } catch (e) { return String(e); } })(),
      })),
    }));
    const pinfo = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.dataset.testid + " " + (f.contentDocument?.readyState) + " " + f.contentWindow?.location.href));
    console.log("DBG", i, JSON.stringify(info), JSON.stringify(pinfo));
    await page.waitForTimeout(2500);
  }
  await expect(shown).toHaveAttribute("data-href", "/setup", FRAME_LOAD);
  await expect(audience.getByText("Speaker notes")).toHaveCount(0);

  await page.bringToFront();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Gaps");
  await expect(shown).toHaveAttribute("data-href", "/?place=gaps", FRAME_LOAD);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("room-slide-title")).toHaveText("Mappings");
  await expect(shown).toHaveAttribute("data-href", "/mappings", FRAME_LOAD);

  // The audience page is chrome-free too.
  const audienceFrame = audience.frameLocator('[data-testid="audience-frame"]');
  await expect(audienceFrame.locator("main")).toBeVisible(FRAME_LOAD);
  await expect(audienceFrame.locator("aside").first()).toBeHidden();

  // An edit made in the presenter's live page reloads the audience's copy.
  await audience.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="audience-frame"]');
    (frame!.contentWindow as Window & { __stale?: boolean }).__stale = true;
  });
  // The presenter's live frame has the Mappings page once it has navigated there.
  await expect(page.frameLocator('[data-testid="room-current-frame"]').locator("main")).toBeVisible(FRAME_LOAD);
  await expect.poll(() => page.frame({ url: /\/mappings\?present=1/ }) !== null, FRAME_LOAD).toBe(true);
  const presenterFrame = page.frame({ url: /\/mappings\?present=1/ })!;
  await presenterFrame.evaluate(async () => {
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
      FRAME_LOAD,
    )
    .toBe(false);
  await expect(shown).toHaveAttribute("data-href", "/mappings");
});

test("Breakouts are one tab away, and a breakout room switches back to Room", async ({ page, request }) => {
  const name = `Room breakout ${Date.now()}`;
  await iegpAction(request, { action: "create_breakout_group", name });

  await openRoom(page);
  await page.getByRole("button", { name: "Breakouts" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();
  const href = await row.getByRole("link", { name: /Open room/ }).getAttribute("href");
  expect(href).toMatch(/^\/breakouts\//);

  await page.goto(href!, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /Switch to presentation/ }).click();
  await expect(page).toHaveURL(/\/room$/, FRAME_LOAD);
  await expect(page.getByTestId("presenter-console")).toHaveAttribute("data-ready", "true", FRAME_LOAD);

  await page.getByRole("button", { name: "Breakouts" }).click();
  await page.getByRole("link", { name: "Manage breakout groups" }).click();
  // A first visit compiles /breakouts on the dev server.
  await expect(page).toHaveURL(/\/breakouts$/, FRAME_LOAD);
});

test("Esc ends the show and returns to Prep", async ({ page }) => {
  await openRoom(page);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/:\d+\/(\?.*)?$/, FRAME_LOAD);
});
