import { developmentStep } from "../support/development-workflow";
/** Saved results and comparison use scripted replies, never paid model calls. */
import { expect, test, type Page } from '@playwright/test';
const sectionIds = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
const route = { provider_id: 'xai-grok', model: 'grok-4', temperature: 0.37, max_tokens: 12000, fallbacks: [] };
const config = (mode: string) => ({ mode, stages: Object.fromEntries(sectionIds.map(section => [section, { route, overrides: {} }])), evaluator: route });
const attempt = (section: string, output: unknown, candidates: unknown[] = [], status = 'succeeded') => ({ id: `attempt-${section}`, section, status, result: { output_id: 'a'.repeat(64), output, candidates, reason: null }, prerequisites: {}, error: null });
const base = { created_at: '2026-10-30', updated_at: '2026-10-30', generation_status: 'failed', evaluation_status: 'not_requested', error: 'Retained provider failure', calls: [] };
const saved = { ...base, id: 'saved', manifest: { revision: 1, config: config('single_pass'), routes: {}, sources: [], references: [] }, sections: [attempt('gap_extraction', { accepted: [], rejected: [{ name: '<script>untrusted()</script>', source_quote: 'Missing comparative outcomes', duplicate_of: 'gap-previous', critic_note: 'Rejected due to overlap' }] }, [], 'rejected'), attempt('tactic_extraction', { accepted: [{ name: 'Evidence study', evidence_question: 'Compare outcomes', source_quote: 'Study protocol', status: 'planned' }], rejected: [] }), attempt('matching_coverage', { rows: [{ gap_id: 'gap-one', gap_name: 'Comparative need', mappings: [{ tactic_id: 'tactic-one', coverage: 'partially_addressed', rationale: 'Study is planned', dimensions: { population: 'partial' }, references: [{ entity_type: 'source', entity_id: 'source-one', reason: 'Protocol' }] }] }] }), attempt('partial_splitting', { proposals: [] }, [], 'not_applicable')] };
const older = { ...saved, id: 'older', manifest: { ...saved.manifest, config: config('standard') }, sections: [attempt('gap_extraction', '<img src=x onerror=untrusted()>', [], 'failed')] };
async function arrange(page: Page, generationStatus?: string) {
  // These saved-output scenarios assume a configured evaluator. Script availability
  // like the execution replies below; no real credentials or provider calls are used.
  await page.route('**/api/control', async intercepted => {
    const response = await intercepted.fetch();
    const body = await response.json();
    body.provider_keys = body.provider_keys.map((provider: Record<string, unknown>) => ({ ...provider, status: 'configured' }));
    await intercepted.fulfill({ response, json: body });
  });
  const name = `KAN205 results ${Date.now()}`;
  const response = await page.request.post('/api/admin/development', { data: { name, source_workspace_id: null } });
  expect(response.ok(), `Create experiment: ${response.status()} ${await response.text()}`).toBe(true);
  const draft = (await response.json()).experiment;
  let posts = 0;
  await page.route('**/api/admin/development/*/executions**', async intercepted => {
    if (intercepted.request().method() === 'POST') posts++;
    await intercepted.fulfill({ json: { executions: generationStatus ? [{ ...saved, generation_status: generationStatus, error: generationStatus === 'failed' ? 'Generation provider unavailable' : null, sections: [{ ...saved.sections[0], status: generationStatus, result: null }] }] : [saved, older], next_cursor: null, history: Object.fromEntries(saved.sections.map(item => [item.id, { freshness: { current: false, reasons: ['source_changed'] }, evaluations: [] }])), delivery: { available: true, reason: null } } });
  });
  await page.goto('/admin/development');
  await page.getByRole('button', { name: `Open ${name}` }).click();
  return { draft, posts: () => posts, region: page.getByRole('region', { name: 'Execution', exact: true }) };
}
test('all four sections preserve evidence, malformed history, explicit configuration copy and not-applicable evaluation', async ({ page }) => {
  let evaluationPosts = 0;
  await page.route('**/api/admin/development/*/evaluations', async intercepted => {
    if (intercepted.request().method() === 'POST') evaluationPosts++;
    await intercepted.fulfill({ json: { evaluations: [], delivery: { available: true, reason: null } } });
  });
  const { region, posts } = await arrange(page);
  await expect(region.getByText('Missing comparative outcomes', { exact: true })).toBeVisible();
  await expect(region.getByText('Study protocol', { exact: true })).toBeVisible();
  await expect(region.getByText(/Relevance: inspect/)).toBeVisible();
  await expect(region.getByText(/Design fit: inspect/)).toBeVisible();
  await expect(region.getByText(/Delivered evidence coverage: a relevant/)).toBeVisible();
  await expect(region.locator('summary').filter({ hasText: '<script>untrusted()</script>' })).toBeVisible();
  expect(await page.locator('script').filter({ hasText: 'untrusted()' }).count()).toBe(0);
  await developmentStep(page, "Results");
  await expect(region.getByText(/Generation freshness: outdated/).first()).toContainText('Source documents changed');
  const evaluation = page.getByRole('region', { name: 'Evaluation', exact: true });
  await expect(evaluation.getByRole('button', { name: 'Evaluate saved output', exact: true })).toBeEnabled();
  await evaluation.getByRole('combobox', { name: 'Selected saved output', exact: true }).selectOption('attempt-partial_splitting');
  await expect(evaluation.getByText('Not applicable: no eligible partial gap. Evaluation is disabled; no quality score is assigned.')).toBeVisible();
  await expect(evaluation.getByRole('button', { name: 'Evaluate saved output', exact: true })).toBeDisabled();
  await developmentStep(page, "Results");
  await region.getByRole('combobox', { name: 'Selected execution', exact: true }).selectOption('older');
  await expect(region.getByText(/Structured evidence unavailable/)).toBeVisible();
  await developmentStep(page, "Results");
  const outputDisclosure = region.locator('summary').filter({ hasText: /^View generated output$/ });
  await outputDisclosure.focus();
  await expect(outputDisclosure).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(outputDisclosure.locator('..')).toHaveAttribute('open', '');
  await expect(region.getByText(/<img src=x onerror=untrusted\(\)>/)).toBeVisible();
  await developmentStep(page, "Results");
  await region.getByRole('button', { name: 'Copy selected configuration' }).click();
  await developmentStep(page, "Test settings");
  await expect(region.getByLabel('Execution mode')).toHaveValue('standard');
  await expect(region.getByRole('status').filter({ hasText: 'Copied configuration from execution older' })).toContainText('explicitly Run');
  await developmentStep(page, "Test settings");
  await region.getByText('Gap extraction route and roles').click();
  await expect(region.getByText('Gap extraction route and roles').locator('..').getByLabel('Temperature', { exact: true }).first()).toHaveValue('0.37');
  expect(posts()).toBe(0);
  expect(evaluationPosts).toBe(0);
  await developmentStep(page, "Results");
  await region.getByRole('combobox', { name: 'Selected execution', exact: true }).selectOption('saved');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await region.getByRole('heading', { name: 'Results', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-205/results-desktop.png', fullPage: false });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(region.getByRole('combobox', { name: 'Selected execution', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await region.getByRole('heading', { name: 'Results', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.superpowers/sdd/ui-6-results-zoom.png', fullPage: false });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 390, height: 844 });
  await region.getByRole('heading', { name: 'Results', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-205/results-mobile.png', fullPage: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('compares saved modes and blocks differing input and rubric claims without publishing a stale response', async ({ page }) => {
  const { draft, posts } = await arrange(page);
  let release: (() => void) | undefined;
  let settled = false;
  await page.route('**/api/admin/development/comparison?**', async intercepted => {
    const old = new URL(intercepted.request().url()).searchParams.get('right_execution_id') === 'saved';
    if (old) await new Promise<void>(resolve => { release = resolve; });
    const compatibility = { controlled: old, blockers: old ? [] : ['source_content', 'profile_version', 'evaluator_configuration', 'reference_identity'], missing_evidence: [], varying_factors: ['generation_mode', 'generation_routes'] };
    await intercepted.fulfill({ json: { comparison: { left: { execution: saved, evaluations: [] }, right: { execution: older, evaluations: [] }, compatibility, sections: [], trial_note: 'Each execution is one trial.' } } }).catch(() => undefined);
    if (old) settled = true;
  });
  const comparison = page.getByRole('region', { name: 'Saved comparison', exact: true });
  await comparison.getByRole('combobox', { name: 'Left experiment', exact: true }).selectOption(draft.id);
  await comparison.getByRole('combobox', { name: 'Right experiment', exact: true }).selectOption(draft.id);
  await comparison.getByRole('combobox', { name: 'Left saved execution', exact: true }).selectOption('saved');
  await comparison.getByRole('combobox', { name: 'Right saved execution', exact: true }).selectOption('saved');
  await expect.poll(() => !!release).toBe(true);
  await comparison.getByRole('combobox', { name: 'Right saved execution', exact: true }).selectOption('older');
  await expect(comparison.getByText('Quality comparison is not controlled.')).toBeVisible();
  release!(); await expect.poll(() => settled).toBe(true);
  await expect(comparison.getByText('Quality comparison is not controlled.')).toBeVisible();
  await expect(comparison.getByText(/Differences: Source document content/)).toContainText('Evaluation profile version');
  await expect(comparison.getByText(/Varying factors:/)).toContainText('Generation mode');
  await expect(comparison.getByText(/One trial cannot establish statistical superiority/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(comparison).toBeVisible();
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-205/comparison-desktop.png', fullPage: true });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(comparison).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.superpowers/sdd/ui-6-comparison-zoom.png', fullPage: true });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(comparison).toBeVisible();
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-205/comparison-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await comparison.getByRole('button', { name: 'Copy right configuration' }).click();
  await developmentStep(page, "Test settings");
  await expect(page.getByLabel('Execution mode')).toHaveValue('standard');
  expect(posts()).toBe(0);
});

for (const status of ['queued', 'running', 'failed']) {
  test(`UI-6 ${status} generation has no invented output or automatic resend`, async ({ page }) => {
    const { region, posts } = await arrange(page, status);
    await developmentStep(page, 'Results');
    await expect(region.getByText(/Viewing a saved run/)).toBeVisible();
    await expect(region.getByText(new RegExp(`Generation status: ${status}`))).toContainText('No saved output');
    await expect(region.getByText('Generated output: unreviewed', { exact: true })).toHaveCount(0);
    if (status === 'failed') await expect(region.getByText('Generation provider unavailable')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Optional evaluation', exact: true })).toBeVisible();
    await expect(page.getByText(/Gold standards are expected answers/)).toBeVisible();
    expect(posts()).toBe(0);
  });
}
