/** Reopened history uses scripted execution data and the isolated draft API. */
import { expect, test } from '@playwright/test';

test('reopens historical attempts with independent freshness and call details', async ({ page }) => {
  const name = `History detail ${Date.now()}`;
  const route = { provider_id: 'xai-grok', model: 'grok-4', temperature: 0.2, max_tokens: 16000, fallbacks: [] };
  const sections = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
  const config = { mode: 'single_pass', stages: Object.fromEntries(sections.map((id) => [id, { route, overrides: {} }])), evaluator: route };
  const old = { id: 'old', created_at: '2026-10-29', updated_at: '2026-10-29', generation_status: 'succeeded', evaluation_status: 'not_requested', error: null, manifest: { revision: 1, config, routes: {}, sources: [], references: [], retry_policy: { http_max_attempts: 1, uncertain_resend: false, user_rerun: 'fresh_attempt_may_charge' } }, sections: [{ id: 'attempt-old', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'output-old', output: {}, candidates: [] }, prerequisites: {}, started_at: 'start', finished_at: 'finish', error: null }], calls: [{ id: 'call-1', section_id: 'attempt-old', ordinal: 1, status: 'succeeded', identity: 'trace-1', request: { role: 'proposer', purpose: 'generation' }, receipt: { text: 'Role response', usage: { input_tokens: 2 }, cost_usd: null, llm_call_id: 'llm-1' }, sending_at: 'sent', settled_at: 'settled' }] };
  const metadata = { 'attempt-old': { freshness: { current: false, reasons: ['newer_attempt'] }, evaluations: [{ id: 'eval-1', status: 'succeeded', freshness: 'outdated', reasons: ['attempt_changed'], profile_id: 'profile', output_id: 'output-old', evaluator_identity: 'evaluator', reference_identity: 'reference', reference_ids: [] }] } };
  const seenModes: string[] = [];
  await page.route('**/api/admin/development/*/executions**', async (request) => {
    const raw = new URL(request.request().url()).searchParams.get('config');
    if (raw) seenModes.push(JSON.parse(raw).mode);
    await request.fulfill({ json: { executions: [old], history: metadata, next_cursor: null, delivery: { available: true, reason: null } } });
  });
  await page.goto('/admin/development');
  await page.getByLabel('New experiment name').fill(name);
  await page.getByRole('button', { name: 'Create experiment' }).click();
  await page.reload();
  await page.getByRole('button', { name: `Open ${name}` }).click();
  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  await expect(execution.getByLabel('Execution mode')).toHaveValue('single_pass');
  await expect(execution.getByText(/Generation freshness: outdated/)).toContainText('newer_attempt');
  await expect(execution.getByText(/Evaluation: succeeded/)).toContainText('attempt_changed');
  await execution.getByText('Call 1: succeeded').click();
  await expect(execution.getByText('Role response')).toBeVisible();
  await expect(execution.getByText(/Cost: unknown/)).toBeVisible();
  await expect(execution.getByText(/Role: proposer · Purpose: generation · Trace: trace-1/)).toBeVisible();
  await expect(execution.getByText(/Sent: sent · Settled: settled/)).toBeVisible();
  await expect(execution.getByText(/Usage:.*input_tokens/)).toBeVisible();
  await expect(execution.getByText(/Started: start · Finished: finish/)).toBeVisible();
  await execution.getByText('Provenance and retry policy').click();
  await expect(execution.getByText(/Interrupted or uncertain sends are not automatically resent/)).toBeVisible();
  await expect(execution.getByText(/Code version: unknown/)).toBeVisible();
  await execution.getByLabel('Execution mode').selectOption('standard');
  await expect.poll(() => seenModes).toContain('standard');
  await expect(execution.getByLabel('Selected execution')).toHaveValue('old');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-203/task-2-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.superpowers/sdd/2026-10-30-kan-203/task-2-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('loads older history while retaining the newest prerequisites and selected history', async ({ page }) => {
  const name = `Paged history ${Date.now()}`;
  const route = { provider_id: 'xai-grok', model: 'grok-4', temperature: 0.2, max_tokens: 16000, fallbacks: [] };
  const ids = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
  const config = { mode: 'standard', stages: Object.fromEntries(ids.map((id) => [id, { route, overrides: {} }])), evaluator: route };
  const attempt = (id: string, section: string, status: string) => ({ id, section, status, result: status === 'succeeded' ? { output_id: `output-${id}`, output: {}, candidates: [] } : null, prerequisites: {}, error: null });
  const base = { created_at: '2026-10-30', updated_at: '2026-10-30', generation_status: 'failed', evaluation_status: 'not_requested', error: null, manifest: { revision: 1, config, routes: {} }, calls: [] };
  const latest = { ...base, id: 'new', sections: [attempt('failed-gap', 'gap_extraction', 'failed'), attempt('tactic', 'tactic_extraction', 'succeeded')] };
  const older = { ...base, id: 'old', generation_status: 'succeeded', sections: [attempt('old-gap', 'gap_extraction', 'succeeded')] };
  let posts = 0;
  let listReads = 0;
  await page.route('**/api/admin/development/*/executions**', async (request) => {
    if (request.request().method() === 'POST') { posts++; await request.fulfill({ status: 409, json: { error: 'unexpected request' } }); return; }
    listReads++;
    const cursor = new URL(request.request().url()).searchParams.get('cursor');
    await request.fulfill({ json: { executions: cursor ? [older] : [latest], next_cursor: cursor ? null : 'new', history: {}, delivery: { available: true, reason: null } } });
  });
  await page.goto('/admin/development');
  await page.getByLabel('New experiment name').fill(name);
  await page.getByRole('button', { name: 'Create experiment' }).click();
  await expect.poll(() => listReads).toBeGreaterThan(0);
  const beforeUpload = listReads;
  await page.getByLabel('Private source file').setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('Evidence') });
  await page.getByRole('button', { name: 'Upload source', exact: true }).click();
  await expect.poll(() => listReads).toBeGreaterThan(beforeUpload);
  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  await execution.getByRole('button', { name: 'Load older executions' }).click();
  await execution.getByLabel('Selected execution').selectOption('old');
  await expect(execution.getByText('Attempt: old-gap', { exact: false })).toBeVisible();
  await execution.getByRole('button', { name: 'Run Matching and coverage' }).click();
  await expect(execution.getByRole('alert')).toContainText('Prerequisites are missing or stale');
  expect(posts).toBe(0);
  await expect(execution.getByLabel('Selected execution')).toHaveValue('old');
});

for (const outcome of ['succeeded', 'failed'] as const) {
  test(`reload refreshes retained evaluation after a newer ${outcome} attempt`, async ({ page }) => {
    const name = `Retained ${outcome} ${Date.now()}`;
    const route = { provider_id: 'xai-grok', model: 'grok-4', temperature: 0.2, max_tokens: 16000, fallbacks: [] };
    const ids = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
    const config = { mode: 'standard', stages: Object.fromEntries(ids.map((id) => [id, { route, overrides: {} }])), evaluator: route };
    const base = { created_at: '2026-10-30', updated_at: '2026-10-30', evaluation_status: 'not_requested', error: null, manifest: { revision: 1, config, routes: {} }, calls: [] };
    const old = { ...base, id: 'old-page', generation_status: 'succeeded', sections: [{ id: 'old-attempt', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'old-output', output: {}, candidates: [] }, prerequisites: {}, error: null }] };
    const other = { ...base, id: 'first-page', generation_status: 'succeeded', sections: [] };
    const newer = { ...base, id: 'newer', generation_status: outcome, sections: [{ id: 'new-attempt', section: 'gap_extraction', status: outcome, result: null, prerequisites: {}, error: null }] };
    let introduced = false;
    const metadata = () => ({ 'old-attempt': { freshness: { current: !introduced, reasons: introduced ? ['newer_attempt'] : [] }, evaluations: [{ id: 'evaluation', status: 'succeeded', freshness: introduced ? 'outdated' : 'current', reasons: introduced ? ['attempt_changed'] : [], profile_id: 'profile', output_id: 'old-output', evaluator_identity: 'evaluator', reference_identity: 'reference', reference_ids: [] }] } });
    await page.route('**/api/admin/development/*/executions**', async (request) => {
      const url = new URL(request.request().url());
      if (url.pathname.endsWith('/old-page')) {
        await request.fulfill({ json: { execution: old, history: metadata() } });
      } else if (url.searchParams.has('cursor')) {
        await request.fulfill({ json: { executions: [old], history: metadata(), next_cursor: null, delivery: { available: true, reason: null } } });
      } else {
        await request.fulfill({ json: { executions: introduced ? [newer, other] : [other], history: {}, next_cursor: 'first-page', delivery: { available: true, reason: null } } });
      }
    });
    await page.goto('/admin/development');
    await page.getByLabel('New experiment name').fill(name);
    await page.getByRole('button', { name: 'Create experiment' }).click();
    const execution = page.getByRole('region', { name: 'Execution', exact: true });
    await execution.getByRole('button', { name: 'Load older executions' }).click();
    await execution.getByLabel('Selected execution').selectOption('old-page');
    await expect(execution.getByText('Generation freshness: current')).toBeVisible();
    await expect(execution.getByText(/Evaluation: succeeded · current/)).toBeVisible();
    introduced = true;
    await execution.getByRole('button', { name: 'Reload history' }).click();
    await expect(execution.getByText(/Generation freshness: outdated/)).toContainText('newer_attempt');
    await expect(execution.getByText(/Evaluation: succeeded · outdated/)).toContainText('attempt_changed');
    await expect(execution.getByLabel('Selected execution')).toHaveValue('old-page');
  });
}

for (const change of ['controls', 'source'] as const) {
  for (const failedRead of ['list', 'detail'] as const) {
    test(`${change} refresh ${failedRead} failure removes old current claims and recovers`, async ({ page }) => {
      const name = `Unavailable ${change} ${failedRead} ${Date.now()}`;
      const route = { provider_id: 'xai-grok', model: 'grok-4', temperature: 0.2, max_tokens: 16000, fallbacks: [] };
      const ids = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
      const config = { mode: 'standard', stages: Object.fromEntries(ids.map((id) => [id, { route, overrides: {} }])), evaluator: route };
      const base = { created_at: '2026-10-30', updated_at: '2026-10-30', generation_status: 'succeeded', evaluation_status: 'not_requested', error: null, manifest: { revision: 1, config, routes: {} }, calls: [] };
      const old = { ...base, id: 'old-page', sections: [{ id: 'old-attempt', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'old-output', output: {}, candidates: [] }, prerequisites: {}, error: null }] };
      const first = { ...base, id: 'first-page', sections: [] };
      let changed = false;
      let failing = false;
      let failures = 0;
      const metadata = () => ({ 'old-attempt': { freshness: { current: !changed || change === 'controls', reasons: changed && change === 'source' ? ['generation_inputs_changed'] : [] }, evaluations: [{ id: 'evaluation', status: 'succeeded', freshness: changed ? 'outdated' : 'current', reasons: changed ? [change === 'controls' ? 'evaluator_changed' : 'attempt_changed'] : [], profile_id: 'profile', output_id: 'old-output', evaluator_identity: 'evaluator', reference_identity: 'reference', reference_ids: [] }] } });
      await page.route('**/api/admin/development/*/executions**', async (request) => {
        const url = new URL(request.request().url());
        const detail = url.pathname.endsWith('/old-page');
        if (failing && (failedRead === 'detail' ? detail : !detail)) {
          failures++;
          await request.fulfill({ status: 503, json: { error: 'Scripted unavailable' } });
        } else if (detail) {
          await request.fulfill({ json: { execution: old, history: metadata() } });
        } else {
          const older = url.searchParams.has('cursor');
          await request.fulfill({ json: { executions: older ? [old] : [first], history: older ? metadata() : {}, next_cursor: older ? null : 'first-page', delivery: { available: true, reason: null } } });
        }
      });
      await page.goto('/admin/development');
      await page.getByLabel('New experiment name').fill(name);
      await page.getByRole('button', { name: 'Create experiment' }).click();
      const execution = page.getByRole('region', { name: 'Execution', exact: true });
      await execution.getByRole('button', { name: 'Load older executions' }).click();
      await execution.getByLabel('Selected execution').selectOption('old-page');
      await expect(execution.getByText('Generation freshness: current')).toBeVisible();
      await expect(execution.getByText('Evaluation: succeeded · current', { exact: false })).toBeVisible();
      changed = true;
      failing = true;
      if (change === 'controls') {
        await execution.getByText('Legacy evaluator route (legacy history comparisons only)').click();
        await execution.getByText('Legacy evaluator route (legacy history comparisons only)').locator('..').getByLabel('Temperature', { exact: true }).fill('0.7');
      } else {
        await page.getByLabel('Private source file').setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('Changed evidence') });
        await page.getByRole('button', { name: 'Upload source', exact: true }).click();
      }
      await expect.poll(() => failures).toBeGreaterThan(0);
      await expect(execution.getByRole('alert')).toBeVisible();
      await expect(execution.getByText('Generation freshness: current')).toHaveCount(0);
      await expect(execution.getByText('Evaluation: succeeded · current', { exact: false })).toHaveCount(0);
      await expect(execution.getByText('Evaluation: unavailable', { exact: true })).toBeVisible();
      await expect(execution.getByLabel('Selected execution')).toHaveValue('old-page');
      await expect(execution.getByText('Attempt: old-attempt', { exact: false })).toBeVisible();
      failing = false;
      await execution.getByRole('button', { name: 'Reload history' }).click();
      await expect(execution.getByText(change === 'source' ? /Generation freshness: outdated/ : 'Generation freshness: current')).toBeVisible();
      await expect(execution.getByText(/Evaluation: succeeded · outdated/)).toContainText(change === 'controls' ? 'evaluator_changed' : 'attempt_changed');
      await expect(execution.getByRole('alert')).toHaveCount(0);
      await expect(execution.getByLabel('Selected execution')).toHaveValue('old-page');
    });
  }
}

test('a delayed refresh from previous controls cannot replace current comparison metadata', async ({ page }) => {
  const name = `Obsolete response ${Date.now()}`;
  const route = { provider_id: 'xai-grok', model: 'grok-4', temperature: 0.2, max_tokens: 16000, fallbacks: [] };
  const ids = ['gap_extraction', 'tactic_extraction', 'matching_coverage', 'partial_splitting'];
  const config = { mode: 'standard', stages: Object.fromEntries(ids.map((id) => [id, { route, overrides: {} }])), evaluator: route };
  const executionRecord = { id: 'saved', created_at: '2026-10-30', updated_at: '2026-10-30', generation_status: 'succeeded', evaluation_status: 'not_requested', error: null, manifest: { revision: 1, config, routes: {} }, calls: [], sections: [{ id: 'attempt', section: 'gap_extraction', status: 'succeeded', result: { output_id: 'output', output: {}, candidates: [] }, prerequisites: {}, error: null }] };
  let holdNext = false;
  let release: (() => void) | undefined;
  let settled = false;
  await page.route('**/api/admin/development/*/executions**', async (request) => {
    const raw = new URL(request.request().url()).searchParams.get('config');
    const changed = raw && JSON.parse(raw).evaluator.temperature === 0.7;
    const body = { executions: [executionRecord], history: { attempt: { freshness: { current: true, reasons: [] }, evaluations: [{ id: 'evaluation', status: 'succeeded', freshness: changed ? 'outdated' : 'current', reasons: changed ? ['evaluator_changed'] : [], profile_id: 'profile', output_id: 'output', evaluator_identity: 'evaluator', reference_identity: 'reference', reference_ids: [] }] } }, next_cursor: null, delivery: { available: true, reason: null } };
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => { release = resolve; });
      // Changing controls cancels this old browser request; still attempt its late reply.
      await request.fulfill({ json: body }).catch(() => undefined);
      settled = true;
    } else await request.fulfill({ json: body });
  });
  await page.goto('/admin/development');
  await page.getByLabel('New experiment name').fill(name);
  await page.getByRole('button', { name: 'Create experiment' }).click();
  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  await expect(execution.getByText('Evaluation: succeeded · current', { exact: false })).toBeVisible();
  await execution.getByText('Legacy evaluator route (legacy history comparisons only)').click();
  holdNext = true;
  await execution.getByRole('button', { name: 'Reload history' }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await execution.getByText('Legacy evaluator route (legacy history comparisons only)').locator('..').getByLabel('Temperature', { exact: true }).fill('0.7');
  await expect(execution.getByText(/Evaluation: succeeded · outdated/)).toContainText('evaluator_changed');
  release!();
  await expect.poll(() => settled).toBe(true);
  await expect(execution.getByText(/Evaluation: succeeded · outdated/)).toContainText('evaluator_changed');
  await expect(execution.getByText('Evaluation: succeeded · current', { exact: false })).toHaveCount(0);
  await expect(execution.getByLabel('Selected execution')).toHaveValue('saved');
});
