import { expect, test } from "@playwright/test";
import {
  controlAction,
  controlActionExpectingError,
  controlState,
} from "../support/synapse";

const LOCKED_PROVIDERS = [
  ["xai-grok", "XAI_API_KEY"],
  ["anthropic-claude", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["google-gemini", "GEMINI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
] as const;

test.describe.configure({ mode: "serial" });

/*
 * KAN-65: every provider authenticates with an API key from the server
 * environment. The Playwright web server blanks every provider key, so each
 * card reads "No key" here.
 */
test.describe("Control panel provider key status", () => {
  test("shows the five locked providers, each with its key status and env var", async ({ page, request }) => {
    const state = await controlState(request);
    for (const [provider, env] of LOCKED_PROVIDERS) {
      expect(state.providers.map((row) => row.id)).toContain(provider);
      const key = state.provider_keys.find((row) => row.provider_id === provider)!;
      expect(key.auth).toBe("api_key");
      expect(key.status).toBe("missing");
      expect(key.key_env).toBe(env);
    }
    expect(state.defaults).toEqual({ primary: "xai-grok", alternate: "anthropic-claude" });

    await page.goto("/admin/control");
    await expect(page.getByRole("heading", { name: /^control panel$/i })).toBeVisible();
    for (const label of [
      "xAI · Grok",
      "Anthropic · Claude",
      "OpenAI · ChatGPT",
      "Google · Gemini",
      "OpenRouter",
    ]) {
      await expect(page.getByRole("heading", { name: label })).toBeVisible();
    }
    await expect(page.getByText("Default route", { exact: true })).toBeVisible();
    await expect(page.getByText("One-click alternate", { exact: true })).toBeVisible();
    for (const [provider, env] of LOCKED_PROVIDERS) {
      const card = page.getByTestId(`provider-card-${provider}`);
      await expect(card.getByTestId("provider-key-status")).toHaveText("No key");
      await expect(card.getByTestId("provider-key-env")).toHaveText(`${env} (server environment)`);
    }
  });

  test("has no login buttons and never asks for a key", async ({ page }) => {
    await page.goto("/admin/control");
    await expect(page.getByText(/Each provider uses an API key set in the server environment/)).toBeVisible();
    await expect(page.getByText(/Keys are never shown or entered here/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /log in with|re-authorize|disconnect/i })).toHaveCount(0);
    await expect(page.getByText(/OAuth client|Signed in by/)).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: /api key|secret|credential/i })).toHaveCount(0);
    await expect(page.getByPlaceholder(/api key|secret|sk-/i)).toHaveCount(0);
  });

  test("connect_provider and disconnect_provider are gone", async ({ request }) => {
    for (const action of ["connect_provider", "disconnect_provider"]) {
      const error = await controlActionExpectingError(request, { action, provider_id: "xai-grok" });
      expect(error.error).toBe(`Unknown action ${action}`);
    }
  });

  test("switches every stage to Claude and back to Grok in one click", async ({ page, request }) => {
    await page.goto("/admin/control");
    await page.getByRole("button", { name: "Anthropic · Claude", exact: true }).click();
    await expect
      .poll(async () => (await controlState(request)).routes.every((route) => route.provider_id === "anthropic-claude"))
      .toBe(true);
    const claude = await controlState(request);
    // The other first-class default stays as the first fallback.
    expect(claude.routes[0]!.fallbacks[0]).toBe("xai-grok");
    await page.reload();
    await expect(page.getByTestId("providers-routed-to")).toHaveText("Every stage routes to Anthropic · Claude.");

    await page.getByRole("button", { name: "xAI · Grok", exact: true }).click();
    await expect
      .poll(async () => (await controlState(request)).routes.every((route) => route.provider_id === "xai-grok"))
      .toBe(true);
    const grok = await controlState(request);
    expect(grok.routes[0]!.fallbacks).toContain("anthropic-claude");
    expect(grok.routes[0]!.fallbacks).not.toContain("deterministic-local");
  });

  test("routes one stage on its own without touching its neighbours", async ({ request }) => {
    await controlAction(request, {
      action: "set_route",
      stage: "S2",
      provider_id: "openrouter",
      model: "x-ai/grok-4",
      temperature: 0.2,
      max_tokens: 4096,
    });
    const state = await controlState(request);
    expect(state.routes.find((route) => route.stage === "S2")!.provider_id).toBe("openrouter");
    expect(state.routes.find((route) => route.stage === "S3")!.provider_id).toBe("xai-grok");

    const badModel = await controlActionExpectingError(request, {
      action: "set_route",
      stage: "S2",
      provider_id: "xai-grok",
      model: "gpt-4o",
    });
    expect(badModel.error).toMatch(/does not serve/i);
  });

  /*
   * The 409 no_llm itself cannot happen here: under SYNAPSE_TEST_STUB_LLM every
   * run is handed the stub model, so the API side is locked in vitest
   * (tests/no-llm-message.test.ts, tests/kan-65-provider-api-keys.test.ts).
   * What the running app does show without a key is the route preview, which
   * is resolved for real: the stage names the env var to set.
   */
  test("an agentic stage with no key names the env var to set", async ({ page, request }) => {
    await controlAction(request, {
      action: "set_default_provider",
      provider_id: "xai-grok",
    });

    await page.goto("/admin/pipeline");
    const s2 = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "S2 · Evidence gap extraction", exact: true }) });
    await expect(s2.getByText("xAI · Grok · ", { exact: false })).toBeVisible();
    const reason = s2.getByText(/^xAI · Grok: /);
    await expect(reason).toBeVisible();
    await expect(reason).toContainText("XAI_API_KEY");
    await expect(reason).toContainText("server environment");
    await expect(reason).not.toContainText(/log in|OAuth/i);
  });
});

// KAN-109: browser proof covers persisted refreshes as well as the API response.
test("bulk routing updates an unsaved stage form without a page reload", async ({ page }) => {
  await page.goto("/admin/control");
  const stage = page.locator("article").filter({ has: page.getByRole("heading", { name: "S2 · Evidence gap extraction", exact: true }) });
  await stage.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await page.getByRole("button", { name: "Anthropic · Claude", exact: true }).click();
  await expect(stage.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("anthropic-claude");
  await page.getByRole("button", { name: "xAI · Grok", exact: true }).click();
  await expect(stage.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("xai-grok");
});

test("Control Panel fits phone, tablet and desktop in both themes", async ({ page }, testInfo) => {
  await page.goto("/admin/control");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const overflow = await page.evaluate(() => {
        const panel = document.querySelector(".control-panel")!;
        return {
          page: document.documentElement.scrollWidth > window.innerWidth,
          cards: [...panel.querySelectorAll("article")].some(card => card.scrollWidth > card.clientWidth + 1),
        };
      });
      expect(overflow).toEqual({ page: false, cards: false });
      for (const toggle of await page.getByRole("switch").all()) {
        const bounds = await toggle.boundingBox();
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: testInfo.outputPath(`control-${theme}-${width}.png`), fullPage: true });
    }
  }
  const providers = page.getByRole("region", { name: "LLM providers" });
  await providers.screenshot({ path: testInfo.outputPath("providers-desktop-dark.png") });
});

// KAN-192: only the disposable suite database is changed, always restored in finally.
// A temporary column rename causes real settings-read failures without production hooks.
test("keyboard retry preserves drafts through a real settings outage and confirms recovery", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const { default: postgres } = await import("postgres");
  const { requireDisposableDatabase } = await import("../support/disposable-database");
  const pg = postgres(requireDisposableDatabase(process.env.E2E_DATABASE_URL), { max: 1 });
  let renamed = false;
  try {
    await controlAction(request, { action: "set_ai_enabled", enabled: true });
    await page.goto("/admin/control");
    const stage = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "S2 · Evidence gap extraction", exact: true }) });
    const provider = stage.getByRole("combobox", { name: "Provider", exact: true });
    await provider.selectOption("openai");
    await pg`alter table public.platform_settings rename column value to kan192_test_unavailable_value`;
    renamed = true;
    await page.getByRole("button", { name: "Refresh configuration", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("ai-switch-state")).toContainText("Master AI switch unavailable");
    await expect(provider).toHaveValue("openai");
    await expect(stage.getByRole("button", { name: "Save route" })).toBeEnabled();
    await expect(page.getByTestId("provider-card-xai-grok").getByTestId("provider-key-env")).toContainText("XAI_API_KEY");
    await expect(page.getByTestId("providers-ai-off")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Configuration is still unavailable" })).toBeVisible();
    await page.getByRole("button", { name: "Retry configuration", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Retry configuration", exact: true })).toBeEnabled();
    await expect(provider).toHaveValue("openai");
    await page.screenshot({ path: testInfo.outputPath("configuration-unavailable-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("configuration-unavailable-narrow.png"), fullPage: true });
    await pg`alter table public.platform_settings rename column kan192_test_unavailable_value to value`;
    renamed = false;
    await page.getByRole("button", { name: "Retry configuration", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Configuration refreshed. Saved settings are available." })).toBeVisible();
    await expect(page.getByTestId("ai-switch-state")).toContainText("AI is on");
    await expect(provider).toHaveValue("openai");
    await page.screenshot({ path: testInfo.outputPath("configuration-recovered-narrow.png"), fullPage: true });
  } finally {
    if (renamed) await pg`alter table public.platform_settings rename column kan192_test_unavailable_value to value`;
    await pg.end({ timeout: 5 });
  }
});
