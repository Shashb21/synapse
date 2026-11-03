/** Readiness flow uses scripted execution responses and never calls a model. */
import { expect, test } from '@playwright/test';
import { developmentStep } from '../support/development-workflow';

test('explains readiness and an active execution', async ({ page, request }) => {
  let execution: Record<string, unknown> | null = null;
  let posts = 0;
  await page.route('**/api/control', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.provider_keys = body.provider_keys.map((provider: Record<string, unknown>) => ({ ...provider, status: 'configured' }));
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/admin/development/*/executions*', async route => {
    if (route.request().method() === 'POST') {
      posts++;
      if (posts > 1) { await route.fulfill({ status: 409, json: { code: 'stale_revision', error: 'The draft changed. Reload it before starting an execution.' } }); return; }
      const body = route.request().postDataJSON();
      execution = { id: 'queued-test', created_at: '2026-11-03', generation_status: 'queued', sections: [], manifest: { config: body.config, revision: body.revision }, calls: [] };
      await route.fulfill({ status: 202, json: { execution } });
    } else await route.fulfill({ json: { executions: execution ? [execution] : [], history: {}, delivery: { available: true, reason: null } } });
  });
  await page.goto('/admin/development');
  const name = `Readiness ${Date.now()}`;
  await page.getByLabel('New experiment name').fill(name);
  await page.getByRole('button', { name: 'Create experiment' }).click();
  await developmentStep(page, 'Run');
  const run = page.getByRole('button', { name: 'Run all sections' });
  await expect(run).toBeDisabled();
  await expect(page.locator('#run-readiness')).toContainText('Add a source');
  await expect(run).toHaveAttribute('aria-describedby', 'run-readiness');
  await page.getByRole('button', { name: 'Go to Documents to add or review sources' }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('File to add to this experiment').setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('Evidence for testing.') });
  await page.getByRole('button', { name: 'Upload experiment document', exact: true }).click();
  await expect(page.getByText('source.txt', { exact: true })).toBeVisible();
  await developmentStep(page, 'Test settings');
  await page.getByLabel('Execution mode').selectOption('single_pass');
  await page.getByText('Gap extraction route and roles').click();
  const critic = page.getByRole('checkbox', { name: 'Critic override' }).first();
  await expect(critic).toBeDisabled();
  await expect(critic).toHaveAttribute('aria-describedby', 'single-pass-explanation');
  await expect(page.locator('#single-pass-explanation')).toContainText('omits critique');
  await developmentStep(page, 'Run');
  await expect(run).toBeEnabled();
  await page.screenshot({ path: '.superpowers/sdd/2026-11-03-ui-5-action-readiness/desktop.png', fullPage: true });
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(run).toBeDisabled();
  await expect(page.locator('#run-readiness')).toContainText('active execution');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.superpowers/sdd/2026-11-03-ui-5-action-readiness/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  execution = { ...execution!, generation_status: 'failed' };
  await developmentStep(page, 'Results');
  await page.getByRole('button', { name: 'Reload history', exact: true }).click();
  await developmentStep(page, 'Run');
  await expect(run).toBeEnabled();
  const response = await request.get('/api/admin/development');
  expect(response.ok(), `List experiments: ${response.status()}`).toBe(true);
  expect(response.headers()['content-type']).toContain('application/json');
  const list = await response.json();
  const draft = list.experiments.find((item: { name: string }) => item.name === name);
  const changed = await request.patch(`/api/admin/development/${draft.id}`, { data: { name: `${draft.name} elsewhere`, revision: draft.revision } });
  expect(changed.ok()).toBe(true);
  await run.click();
  await expect(page.getByRole('alert').filter({ hasText: /draft changed/i })).toBeVisible();
  await expect(run).toBeDisabled();
  await page.getByLabel('Experiment name', { exact: true }).fill('Unsaved local name');
  await page.getByRole('button', { name: 'Reload saved draft' }).click();
  await expect(page.getByLabel('Experiment name', { exact: true })).toHaveValue('Unsaved local name');
  await expect(run).toBeDisabled();
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(run).toBeEnabled();
  expect(posts).toBe(2);
});
