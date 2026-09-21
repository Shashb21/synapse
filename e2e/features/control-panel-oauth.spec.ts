import { expect, test } from "@playwright/test";
import {
  controlAction,
  controlActionExpectingError,
  controlState,
  runStage,
  seedParsed,
} from "../support/synapse";

const LOCKED_PROVIDERS = [
  "xai-grok",
  "anthropic-claude",
  "openai",
  "google-gemini",
  "openrouter",
] as const;

test.describe.configure({ mode: "serial" });

test.describe("Control panel OAuth routing", () => {
  test("offers the five locked providers, each with its own OAuth login", async ({ page, request }) => {
    const state = await controlState(request);
    for (const provider of LOCKED_PROVIDERS) {
      expect(state.providers.map((row) => row.id)).toContain(provider);
      expect(state.connections.find((row) => row.provider_id === provider)!.auth).toBe("oauth");
    }
    expect(state.defaults).toEqual({ primary: "xai-grok", alternate: "anthropic-claude" });

    await page.goto("/control");
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
    await expect(page.getByRole("button", { name: /log in with xAI/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /log in with Anthropic/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /log in with OpenRouter/i })).toBeVisible();
  });

  test("never asks for an API key", async ({ page }) => {
    await page.goto("/control");
    await expect(page.getByText(/Synapse never asks you for an API key/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: /api key|secret|credential/i })).toHaveCount(0);
    await expect(page.getByPlaceholder(/api key|secret|sk-/i)).toHaveCount(0);
  });

  test("switches every stage to Claude and back to Grok in one click", async ({ page, request }) => {
    await page.goto("/control");
    await page.getByRole("button", { name: "Anthropic · Claude", exact: true }).click();
    await expect
      .poll(async () => (await controlState(request)).routes.every((route) => route.provider_id === "anthropic-claude"))
      .toBe(true);
    const claude = await controlState(request);
    // The other first-class default stays as the first fallback.
    expect(claude.routes[0]!.fallbacks[0]).toBe("xai-grok");

    await page.reload();
    await page.getByRole("button", { name: "xAI · Grok", exact: true }).click();
    await expect
      .poll(async () => (await controlState(request)).routes.every((route) => route.provider_id === "xai-grok"))
      .toBe(true);
    const grok = await controlState(request);
    expect(grok.routes[0]!.fallbacks).toContain("anthropic-claude");
    expect(grok.routes[0]!.fallbacks).toContain("deterministic-local");
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

  test("a provider with no OAuth client cannot be connected, and says why", async ({ request }) => {
    const failed = await controlActionExpectingError(request, {
      action: "connect_provider",
      provider_id: "xai-grok",
    });
    expect(failed.status).toBe(400);
    expect(failed.error).toMatch(/XAI_OAUTH_CLIENT_ID/);
  });

  test("an unconnected route degrades to the deterministic path and records the reason", async ({ request }) => {
    await controlAction(request, {
      action: "set_default_provider",
      provider_id: "xai-grok",
    });
    await seedParsed(request);
    const extract = await runStage(request, "S2", { dry_run: true });
    const response = await request.get(`/api/runs/${extract.run_id}`);
    const { run } = (await response.json()) as {
      run: { route: { provider_id: string; degraded: boolean; reason: string | null } };
    };
    expect(run.route.provider_id).toBe("deterministic-local");
    expect(run.route.degraded).toBe(true);
    expect(run.route.reason).toMatch(/OAuth client not configured/);
    // The stage still ran its three exchanges on the offline route.
    expect(extract.mode).toBe("deterministic");
  });
});
