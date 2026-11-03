/** Real owner pages/live routes and draft persistence; execution responses stay scripted offline. */
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ExecutionConfig, ExecutionRoute } from '../../src/modules/development/execution-schema';
import type { CostControls } from '../../src/modules/development/cost-schema';

type LiveRoute = { stage: string; provider_id: string; model: string; params: { temperature?: number; max_tokens?: number }; fallbacks: string[] };

/** Compare effective live choices, including stages that rely on normal defaults. */
async function liveRoutes(request: APIRequestContext) {
  const response = await request.get('/api/control');
  expect(response.ok()).toBe(true);
  const body = await response.json() as { routes: LiveRoute[] };
  return body.routes.map(({ stage, provider_id, model, params, fallbacks }) => ({
    stage, provider_id, model, params: { temperature: params.temperature, max_tokens: params.max_tokens }, fallbacks,
  })).sort((left, right) => left.stage.localeCompare(right.stage));
}

test('owner discovers historical tools with readable layouts and keyboard navigation', async ({ page }, testInfo) => {
  await page.goto('/admin/development');
  const tools = page.getByRole('link', { name: 'Evaluation tools and historical benchmarks', exact: true }).first();
  await expect(tools).toBeVisible();
  await tools.focus();
  await expect(tools).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/development\/evaluation-tools$/);
  await expect(page.getByRole('heading', { name: 'Historical benchmark', exact: true })).toBeVisible();
  await expect(page.getByText(/These results do not validate the current customer pipeline/)).toBeVisible();
  await expect(page.getByText('need_extract', { exact: true })).toBeVisible();
  await expect(page.getByText('inventory_extract', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reference packs', exact: true })).toBeVisible();
  await expect(page.locator('main button, main input')).toHaveCount(0);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach(`evaluation-tools-${viewport.width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }
  const back = page.getByRole('link', { name: 'Back to Development', exact: true });
  await back.focus();
  await expect(back).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/development$/);
});

test('non-owner cannot read historical evaluation tools', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'synapse_test_as', value: 'customer', url: baseURL! }]);
  await page.goto('/admin/development/evaluation-tools');
  await expect(page.getByRole('heading', { name: /owner only/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historical benchmark', exact: true })).toHaveCount(0);
});

test('experiment route and budget interactions preserve effective live settings', async ({ page }) => {
  // Arrange: draft/source APIs and live snapshot are real. Only execution delivery is scripted.
  const before = await liveRoutes(page.request);
  expect(before.length).toBeGreaterThan(0);
  let controlWrites = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/control' && request.method() === 'POST') controlWrites++;
  });
  let posted: { revision: number; config: ExecutionConfig; cost_controls: CostControls } | undefined;
  const allowance = 7.25;
  const saved: Record<string, unknown> = {};
  await page.route('**/api/admin/development/*/executions**', async route => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      const selected = posted!.config.stages.gap_extraction.route;
      Object.assign(saved, {
        id: 'kan210-scripted-run', experiment_id: 'scripted', created_at: '2026-11-03', updated_at: '2026-11-03',
        generation_status: 'succeeded', evaluation_status: 'not_requested', error: null, calls: [], sections: [],
        manifest: { revision: posted!.revision, config: posted!.config, routes: { gap_extraction: { proposer: { requested: selected, actual: { provider_id: selected.provider_id, model: selected.model, reason: null }, actual_temperature: selected.temperature } } } },
        cost: { execution_id: 'kan210-scripted-run', currency: 'USD', ...posted!.cost_controls, override_enabled: false, paused: false, pause_reason: null, estimate: { total_usd: null, uncertainty: [], categories: [] }, reserved_usd: 0, generation_usage_usd: 0, evaluation_usage_usd: 0, unknown_usage_calls: 0, unknown_active_reservations: 0, reported_total: null, events: [], reservations: [] },
      });
      await route.fulfill({ status: 202, json: { execution: saved } });
    } else if (route.request().url().endsWith('/costs')) await route.fulfill({ json: { account: saved.cost } });
    else await route.fulfill({ json: { executions: saved.id ? [saved] : [], execution: saved, delivery: { available: true, transport: 'scripted', reason: null } } });
  });
  await page.goto('/admin/development');
  const name = `KAN210 settings isolation ${Date.now()}`;
  await page.getByLabel('New experiment name').fill(name);
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/development' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create experiment', exact: true }).click();
  const created = await (await createdResponse).json();
  const id = created.experiment.id as string;
  await page.getByLabel('Private source file').setInputFiles({ name: 'kan210-synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic source: comparative outcomes remain uncertain.') });
  await page.getByRole('button', { name: 'Upload source', exact: true }).click();
  await expect(page.getByText('kan210-synthetic.txt', { exact: true })).toBeVisible();
  const persisted = await page.request.get(`/api/admin/development/${id}`);
  expect(persisted.ok()).toBe(true);
  const draft = (await persisted.json()).experiment;
  expect(draft.name).toBe(name);
  expect(draft.documents.some((document: { filename: string; role: string }) => document.filename === 'kan210-synthetic.txt' && document.role === 'source')).toBe(true);

  // Act: deliberately change every requested experiment choice from the UI defaults.
  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  await execution.getByLabel('Execution mode').selectOption('single_pass');
  const section = execution.locator('details').filter({ has: page.locator('summary', { hasText: /^Gap extraction route and roles$/ }) });
  await section.locator('summary').click();
  const providerSelect = section.getByRole('combobox', { name: 'Provider', exact: true });
  const modelSelect = section.getByRole('combobox', { name: 'Model', exact: true });
  const initialProvider = await providerSelect.inputValue();
  const providerOptions = await providerSelect.locator('option').evaluateAll(options => options.map(option => ({ id: (option as HTMLOptionElement).value, label: option.textContent ?? '' })));
  const chosen = providerOptions.find(option => option.id !== initialProvider)!;
  expect(chosen).toBeDefined();
  await providerSelect.selectOption(chosen.id);
  const models = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  const model = models.at(-1)!;
  await modelSelect.selectOption(model);
  await section.getByLabel('Temperature', { exact: true }).fill('0.7');
  await section.getByLabel('Maximum output tokens', { exact: true }).fill('2048');
  const fallbacks = section.getByRole('group', { name: 'Allowed fallbacks (in listed order)' });
  for (const checkbox of await fallbacks.getByRole('checkbox').all()) await checkbox.uncheck();
  const fallback = providerOptions.find(option => option.id !== chosen.id && option.id !== initialProvider) ?? providerOptions.find(option => option.id !== chosen.id)!;
  await fallbacks.getByRole('checkbox', { name: fallback.label.replace(/ \((?:key present|no key)\)$/, ''), exact: true }).check();
  await execution.getByLabel('Generation allowance (USD)').fill(String(allowance));
  await execution.getByLabel(/I acknowledge unknown provider charges for this new execution/).check();
  await execution.getByRole('button', { name: 'Run Gap extraction', exact: true }).click();

  // Assert: scripted saved state reflects the requested changes; real live routes remain equal.
  await expect.poll(() => posted).toBeDefined();
  const expected: ExecutionRoute = { provider_id: chosen.id, model, temperature: 0.7, max_tokens: 2048, fallbacks: [fallback.id] };
  expect(posted!.config.stages.gap_extraction.route).toEqual(expected);
  expect(posted!.cost_controls).toEqual({ allowance_usd: allowance, unknown_acknowledged: true });
  const returned = await page.evaluate(async url => (await fetch(url)).json(), `/api/admin/development/${id}/executions/kan210-scripted-run`);
  expect(returned.execution.manifest.routes.gap_extraction.proposer.requested).toEqual(expected);
  const costs = await page.evaluate(async url => (await fetch(url)).json(), `/api/admin/development/${id}/executions/kan210-scripted-run/costs`);
  expect(costs.account.allowance_usd).toBe(allowance);
  expect(costs.account.unknown_acknowledged).toBe(true);
  await expect(execution.getByText('Allowance: USD 7.25', { exact: true })).toBeVisible();
  expect(await liveRoutes(page.request)).toEqual(before);
  expect(controlWrites).toBe(0);
});
