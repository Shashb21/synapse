/** UI-10 keyboard disclosures and retained evidence; all saved runs are scripted, with no provider calls. */
import { expect, test } from '@playwright/test';
import { developmentDetails, developmentStep } from '../support/development-workflow';

test('empty and selected experiments keep management optional, focused and guarded', async ({ page }) => {
  // Arrange an empty list without changing shared test data.
  await page.route('**/api/admin/development', route => route.fulfill({ json: { experiments: [] } }));
  await page.goto('/admin/development');
  const creation = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^New experiment$/ }) });
  await expect(creation).toHaveAttribute('open', '');
  await expect(page.getByLabel('New experiment name')).toBeVisible();
  await expect(page.getByText('No drafts yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading experiments…', { exact: true })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: /^New experiment$/ })).toHaveAttribute('aria-disabled', 'false');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: test.info().outputPath(`empty-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.unroute('**/api/admin/development');
  const created = await page.request.post('/api/admin/development', { data: { name: `UI10 selected ${Date.now()}`, source_workspace_id: null } });
  expect(created.ok()).toBe(true);
  const { experiment } = await created.json();
  await page.reload();
  await expect(creation).not.toHaveAttribute('open', '');
  const newSummary = page.locator('summary').filter({ hasText: /^New experiment$/ });
  await newSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('New experiment name')).toBeFocused();
  await page.getByLabel('New experiment name').fill('Keep new name');
  await newSummary.click();
  await newSummary.click();
  await expect(page.getByLabel('New experiment name')).toHaveValue('Keep new name');
  await newSummary.click();
  await page.getByRole('button', { name: `Open ${experiment.name}`, exact: true }).click();
  const name = page.getByLabel('Experiment name', { exact: true });
  await expect(name).toBeHidden();
  const rename = page.getByRole('button', { name: 'Rename', exact: true });
  // Keyboard focus does not wait for the draft/source request to enable Rename.
  await expect(rename).toBeEnabled();
  await rename.focus();
  await page.keyboard.press('Enter');
  await expect(name).toBeFocused();
  await name.fill('Unsaved experiment name');
  await expect(page.getByRole('button', { name: `Open ${experiment.name}`, exact: true })).toBeDisabled();
  await expect(newSummary).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Cancel rename', exact: true }).click();
  await expect(rename).toBeFocused();
  await expect(name).toBeHidden();
  await rename.click();
  await expect(name).toHaveValue(experiment.name);
  await page.getByRole('button', { name: 'Cancel rename', exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: test.info().outputPath(`selected-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('long output, multiple comparison pairs and paused spending disclose exact saved evidence', async ({ page }) => {
  const created = await page.request.post('/api/admin/development', { data: { name: `UI10 evidence ${Date.now()}`, source_workspace_id: null } });
  expect(created.ok()).toBe(true);
  const { experiment } = await created.json();
  const resultName = 'Long preserved output '.repeat(16).trim();
  const compatibility = { controlled: false, blockers: ['source_content'], missing_evidence: [], varying_factors: [] };
  const cost = { execution_id: 'ui10-run', currency: 'USD', allowance_usd: 2, unknown_acknowledged: false, override_enabled: true, paused: true, pause_reason: 'Uncertain send: inspect saved accounting.', estimate: { currency: 'USD', total_usd: null, uncertainty: ['Pricing unavailable.'], categories: [], http_max_attempts: 1 }, reserved_usd: 0.5, generation_usage_usd: 0.12, evaluation_usage_usd: 0.03, unknown_usage_calls: 1, unknown_active_reservations: 1, reported_total: null, events: [], reservations: [] };
  const execution = { id: 'ui10-run', experiment_id: experiment.id, created_at: '2026-11-04', updated_at: '2026-11-04', generation_status: 'succeeded', evaluation_status: 'not_requested', error: null, manifest: { revision: 1, config: { mode: 'standard' }, routes: {}, sources: [], references: [] }, sections: [{ id: 'ui10-attempt', section: 'gap_extraction', status: 'succeeded', prerequisites: {}, result: { output_id: 'a'.repeat(64), candidates: [], output: { accepted: [{ id: 'saved-record-id', name: resultName, source_quote: 'The exact saved quotation.', custom_evidence: 'Every original field stays available.' }], rejected: [] } } }], calls: [], cost };
  await page.route(`**/api/admin/development/${experiment.id}/executions**`, route => route.fulfill({ json: { executions: [execution], next_cursor: null, history: {}, delivery: { available: true } } }));
  await page.route('**/api/admin/development/comparison?**', route => route.fulfill({ json: { comparison: { left: { execution, evaluations: [] }, right: { execution, evaluations: [] }, compatibility, trial_note: 'Each saved execution is one trial.', sections: [{ section: 'gap_extraction', compatibility, evaluation_pairs: [1, 2, 3].map(index => ({ left_evaluation_id: `left-pair-${index}`, right_evaluation_id: `right-pair-${index}`, quality_available: index === 1, compatibility: { controlled: false, blockers: [], missing_evidence: index === 1 ? [] : ['reference_identity'], varying_factors: [] } })) }] } } }));
  await page.goto('/admin/development');
  await page.getByRole('button', { name: `Open ${experiment.name}`, exact: true }).click();
  await developmentStep(page, 'Results');
  const output = page.getByRole('region', { name: 'Execution', exact: true }).locator('summary').filter({ hasText: resultName }).first();
  await expect(output.locator('..')).not.toHaveAttribute('open', '');
  await output.focus();
  await page.keyboard.press('Enter');
  await expect(output.locator('..').getByText('The exact saved quotation.', { exact: true })).toBeVisible();
  await expect(output.locator('..').getByText('Every original field stays available.', { exact: true })).toBeVisible();
  const evaluation = page.getByRole('region', { name: 'Evaluation', exact: true });
  await expect(evaluation.getByText(/Generated output review state: unreviewed/)).toBeVisible();
  const savedOutput = evaluation.locator('summary').filter({ hasText: /^Saved output details$/ });
  await expect(savedOutput.locator('..')).not.toHaveAttribute('open', '');
  await savedOutput.click();
  await expect(savedOutput.locator('..')).toContainText(`Selected output SHA-256: ${'a'.repeat(64)}`);
  const spending = page.getByRole('region', { name: 'Execution spending' });
  await expect(spending.getByText(/Spending paused: Uncertain send/)).toBeVisible();
  await expect(spending.getByText(/Override removes the allowance check/)).toBeVisible();
  await expect(spending.getByText(/Known usage is a subtotal/)).toBeVisible();
  await expect(spending.getByText('Generation known usage: USD 0.12')).toBeVisible();
  await expect(spending.locator('summary').filter({ hasText: /^Spending details$/ }).locator('..')).not.toHaveAttribute('open', '');
  const comparison = page.getByRole('region', { name: 'Saved comparison' });
  for (const side of ['Left', 'Right']) {
    await comparison.getByRole('combobox', { name: `${side} experiment`, exact: true }).selectOption(experiment.id);
    await comparison.getByRole('combobox', { name: `${side} saved execution`, exact: true }).selectOption(execution.id);
  }
  await expect(comparison.getByText('Quality comparison is not controlled.', { exact: true })).toHaveCount(1);
  await expect(comparison.getByText(/One trial cannot establish statistical superiority/)).toBeVisible();
  await expect(comparison.getByText(/none recorded/)).toHaveCount(0);
  const pairs = comparison.locator('summary').filter({ hasText: /^Evaluation pair details$/ });
  await expect(pairs).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(pairs.nth(index).locator('..')).not.toHaveAttribute('open', '');
    await pairs.nth(index).click();
    await expect(pairs.nth(index).locator('..')).toContainText(`left-pair-${index + 1} / right-pair-${index + 1}`);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`output-comparison-spending-${width}.png`), fullPage: true });
  }
  await developmentDetails(page, 'Spending details');
  await expect(spending.getByText(/Unknown active reservations: 1 · Known reserved: USD 0.5/)).toBeVisible();
});
