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
