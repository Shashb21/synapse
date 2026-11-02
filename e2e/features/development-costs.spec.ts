/** Spending controls use scripted owner APIs and never contact a provider. */
import { test, expect, type Page } from '@playwright/test';

async function arrange(page: Page) {
  const created = await page.request.post('/api/admin/development', { data: { name: `Costs ${Date.now()}`, source_workspace_id: null } });
  const draft = (await created.json()).experiment;
  await page.request.post(`/api/admin/development/${draft.id}/source-upload`, { data: { revision: draft.revision, filename: 'cost-source.txt', content_base64: Buffer.from('Saved evidence.').toString('base64') } });
  const estimate = { currency: 'USD', total_usd: null, uncertainty: ['Dynamic requests have unknown cost.'], http_max_attempts: 1, categories: [{ category: 'proposer', calls_min: 1, calls_max: null, cost_usd: null, reason: 'Dynamic prompts' }] };
  const account = { execution_id: 'cost-run', currency: 'USD', allowance_usd: 2, unknown_acknowledged: false, override_enabled: false, paused: true, pause_reason: 'Increase or acknowledge, then resume.', estimate, reserved_usd: 0, generation_usage_usd: 0.12, evaluation_usage_usd: 0.03, unknown_usage_calls: 1, unknown_active_reservations: 0, reported_total: null as unknown, events: [] as unknown[], reservations: [] };
  const run = { id: 'cost-run', experiment_id: draft.id, created_at: '2026-10-30', updated_at: '2026-10-30', generation_status: 'succeeded', manifest: { revision: 1, config: { mode: 'standard' }, routes: {} }, sections: [{ id: 'attempt', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'a'.repeat(64), candidates: [{ statement: 'Preserved candidate' }], output: { accepted: [] } }, prerequisites: {} }], calls: [], cost: account };
  const actions: Record<string, unknown>[] = [];
  const starts: Record<string, unknown>[] = [];
  await page.route(`**/api/admin/development/${draft.id}/executions**`, async route => {
    if (route.request().method() === 'POST') starts.push(route.request().postDataJSON());
    await route.fulfill({ json: { executions: [run], execution: { ...run, id: 'new-cost-run' }, delivery: { available: true } } });
  });
  await page.route(`**/api/admin/development/${draft.id}/executions/cost-run/costs`, async route => {
    const action = route.request().postDataJSON(); actions.push(action);
    if (action.action === 'increase') account.allowance_usd += action.amount_usd;
    if (action.action === 'override') account.override_enabled = action.enabled;
    if (action.action === 'acknowledge_unknown') account.unknown_acknowledged = true;
    if (action.action === 'resume') { account.paused = false; account.pause_reason = ''; }
    if (action.action === 'report') { account.reported_total = { ...action, actor: 'owner', at: '2026-10-30' }; account.events.push({ id: String(actions.length), action: 'report', detail: action, actor: 'owner', at: '2026-10-30' }); }
    await route.fulfill({ json: { account } });
  });
  await page.route(`**/api/admin/development/${draft.id}/cost-estimate`, route => route.fulfill({ json: { estimate: { ...estimate, uncertainty: ['Fetched preview has unknown pricing.'] } } }));
  await page.goto('/admin/development');
  await page.getByRole('button', { name: `Open ${draft.name}` }).click();
  return { actions, starts, draft };
}

test('shows uncertain preview, separate usage, explicit spending actions and preserved outputs', async ({ page }) => {
  const { actions } = await arrange(page);
  await expect(page.getByText('Fetched preview has unknown pricing.', { exact: true })).toHaveCount(0);
  const previewRequest = page.waitForRequest(request => request.url().endsWith('/cost-estimate'));
  await page.getByRole('button', { name: 'Preview generation cost' }).click();
  expect((await previewRequest).postDataJSON()).toEqual({ mode: 'standard', evaluation_only: false });
  await expect(page.getByText('Estimated total: unknown', { exact: true })).toBeVisible();
  await page.getByText('Estimate categories', { exact: true }).click();
  await expect(page.getByText('proposer: 1–unknown calls · unknown · Dynamic prompts', { exact: true })).toBeVisible();
  await expect(page.getByText('Fetched preview has unknown pricing.', { exact: true })).toBeVisible();
  const costs = page.getByRole('region', { name: 'Execution spending' });
  await expect(costs.getByText('Generation known usage: USD 0.12')).toBeVisible();
  await expect(costs.getByText('Evaluation known usage: USD 0.03')).toBeVisible();
  await costs.getByLabel('Increase allowance (USD)').fill('3');
  await costs.getByRole('button', { name: 'Increase allowance', exact: true }).click();
  await expect(costs.getByText('Allowance: USD 5')).toBeVisible();
  expect(actions.map(a => a.action)).toEqual(['increase']);
  await expect(costs.getByText(/Spending paused/)).toBeVisible();
  await costs.getByRole('button', { name: 'Enable allowance override' }).click();
  await costs.getByRole('button', { name: 'Acknowledge unknown charges for this execution' }).click();
  expect(actions.map(a => a.action)).toEqual(['increase', 'override', 'acknowledge_unknown']);
  await costs.getByRole('button', { name: 'Resume spending' }).click();
  await expect(costs.getByText('Spending authorized')).toBeVisible();
  await page.getByText('View generated output', { exact: true }).click();
  await expect(page.getByText(/Preserved candidate/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-206-cost-controls/task-2-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-206-cost-controls/task-2-mobile.png', fullPage: true });
});

test('rejects invalid reported spend and appends corrections without allocating totals', async ({ page }) => {
  const { actions } = await arrange(page);
  const costs = page.getByRole('region', { name: 'Execution spending' });
  await costs.getByLabel('Reported total amount').fill('-1');
  await costs.getByRole('button', { name: 'Save reported total' }).click();
  await expect(costs.getByRole('alert')).toContainText('finite nonnegative');
  await costs.getByLabel('Reported total amount').fill('8');
  await costs.getByLabel('Reported currency').fill('ZZZ');
  await costs.getByRole('button', { name: 'Save reported total' }).click();
  await expect(costs.getByRole('alert')).toContainText('supported ISO currency');
  expect(actions).toHaveLength(0);
  await costs.getByLabel('Reported currency').fill('GBP');
  await costs.getByRole('button', { name: 'Save reported total' }).click();
  await expect(costs.getByText('Owner-reported total: GBP 8')).toBeVisible();
  await costs.getByLabel('Reported total amount').fill('9');
  await costs.getByLabel('Correction note').fill('Corrected invoice total');
  await costs.getByRole('button', { name: 'Save reported total' }).click();
  await costs.getByText('Spending action and correction history').click();
  await expect(costs.getByText(/Corrected invoice total/)).toBeVisible();
  expect(actions.filter(a => a.action === 'report')).toHaveLength(2);
  await expect(costs.getByText('Generation known usage: USD 0.12')).toBeVisible();
});


test('new execution authorization starts unchecked and does not carry into the next run', async ({ page }) => {
  const { starts } = await arrange(page);
  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  const acknowledgment = execution.getByLabel(/I acknowledge unknown provider charges/).first();
  await expect(acknowledgment).not.toBeChecked();
  await execution.getByLabel('Generation allowance (USD)').fill('-2');
  await execution.getByRole('button', { name: 'Run all sections' }).click();
  await expect(execution.getByRole('alert').first()).toContainText('finite nonnegative generation allowance');
  expect(starts).toHaveLength(0);
  await execution.getByLabel('Generation allowance (USD)').fill('2');
  await acknowledgment.check();
  await execution.getByRole('button', { name: 'Run all sections' }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0].cost_controls).toEqual({ allowance_usd: 2, unknown_acknowledged: true });
  await expect(acknowledgment).not.toBeChecked();
});

test('failed preview can be retried without showing saved estimates as a fetched preview', async ({ page }) => {
  const { draft } = await arrange(page);
  let requests = 0;
  await page.route(`**/api/admin/development/${draft.id}/cost-estimate`, route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 503, json: { error: 'Estimate unavailable. Try preview again.' } }) : route.fulfill({ json: { estimate: { total_usd: null, uncertainty: ['Recovered preview.'], categories: [] } } });
  });
  const preview = page.getByRole('button', { name: 'Preview generation cost' });
  await preview.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Estimate unavailable. Try preview again.' })).toBeVisible();
  await expect(page.getByText('Estimated total: unknown', { exact: true })).toHaveCount(0);
  await preview.click();
  await expect(page.getByText('Recovered preview.', { exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

test('lost spending action response explains uncertainty before manual retry', async ({ page }) => {
  const { draft } = await arrange(page);
  let actions = 0;
  await page.route(`**/api/admin/development/${draft.id}/executions/cost-run/costs`, route => { actions++; return route.abort('failed'); });
  const costs = page.getByRole('region', { name: 'Execution spending' });
  await costs.getByLabel('Increase allowance (USD)').fill('3');
  await costs.getByRole('button', { name: 'Increase allowance', exact: true }).click();
  await expect(costs.getByRole('alert')).toContainText('The action may have been saved. Reload history before retrying.');
  expect(actions).toBe(1);
  await expect(costs.getByText('Allowance: USD 2', { exact: true })).toBeVisible();
});
