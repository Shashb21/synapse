import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareReference, prepareSource } from '@/modules/development/documents';
import { DevelopmentError, type Experiment } from '@/modules/development/schema';
import * as ai from '@/modules/kernel/ai-switch';
import { noAiSections } from '@/modules/kernel/ai-sections';
import * as routing from '@/modules/kernel/routing';
import type { ResolvedRoute } from '@/modules/kernel/contracts';
import * as ledger from '@/modules/development/preparation-cost-store';

const { execute } = vi.hoisted(() => ({ execute: vi.fn().mockResolvedValue([]) }));
vi.mock('@/modules/kernel/db', () => ({ sharedDb: () => ({ execute }) }));
vi.mock('unpdf', () => ({ getDocumentProxy: vi.fn(), extractText: async () => ({ text: [source] }) }));

const draft: Experiment = { id: 'synthetic-draft', name: 'Preparation', source_workspace_id: null, owner: 'tester',
  revision: 1, status: 'draft', created_at: '', updated_at: '', documents: [] };
const preparation = { id: '00b6631c-264d-4aba-8ba0-2b775d176af4', allowance_usd: 10 };
const source = 'The fictional panel requested verified spending.';
const content = Buffer.from(source).toString('base64');
const pdfInput = { filename: 'fictional.pdf', content_base64: Buffer.from('%PDF-fictional').toString('base64'),
  format: 'pdf' as const, section: 'gap_extraction' as const, source_document_ids: [] };
const route: ResolvedRoute = {
  stage: 'S1', provider_id: 'openai', provider_label: 'OpenAI', model: 'gpt-5.1',
  auth: 'api_key', connected: true, params: { temperature: 0, max_tokens: 300 }, fallbacks: [], degraded: false, reason: null,
};
const structure = { units: [{ unit: 'u1', blocks: [{ text: source, kind: 'paragraph' }] }] };
const classification = { stakeholder_function: 'market_access', rationale: 'The panel reviews costs.' };
const expected = { version: 1, section: 'gap_extraction', source_document_ids: [], expected_answers: [] };
function responses(replies: unknown[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (!replies.length) throw new Error('Unexpected scripted request.');
    const reply = replies.shift();
    return Response.json({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }],
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 100 } });
  });
}

beforeEach(() => {
  vi.stubEnv('SYNAPSE_TEST_STUB_LLM', '0');
  vi.stubEnv('OPENAI_API_KEY', 'fictional-openai-key');
  vi.stubEnv('OPENROUTER_API_KEY', 'fictional-openrouter-key');
  vi.spyOn(ai, 'aiSections').mockResolvedValue({ ...noAiSections(), ingestion: true });
  vi.spyOn(routing, 'resolveRoute').mockResolvedValue(route);
  vi.spyOn(ledger, 'openPreparationAllowance').mockResolvedValue(preparation.id);
  vi.spyOn(ledger, 'beginPreparationCall').mockResolvedValue('reserved-call');
  vi.spyOn(ledger, 'settlePreparationCall').mockResolvedValue();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('refuses a paid source or PDF without an explicit upload authorization', async () => {
  const fetch = responses([]);
  await expect(prepareSource(draft, 'tester', 'fictional.txt', content)).rejects.toMatchObject({ code: 'preparation_not_authorized' });
  await expect(prepareReference(draft, 'tester', pdfInput)).rejects.toMatchObject({ code: 'preparation_not_authorized' });
  expect(ledger.openPreparationAllowance).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('reserves every structure, repair, classification and PDF expectation send against the same upload', async () => {
  const fetch = responses(['invalid JSON', structure, classification, expected]);
  await expect(prepareReference(draft, 'tester', { ...pdfInput, preparation })).resolves.toMatchObject({ document: { role: 'reference' } });
  expect(ledger.openPreparationAllowance).toHaveBeenCalledExactlyOnceWith(draft, 'tester', 'pdf_reference', preparation);
  expect(ledger.beginPreparationCall).toHaveBeenCalledTimes(4);
  expect(ledger.settlePreparationCall).toHaveBeenCalledTimes(4);
  expect(fetch).toHaveBeenCalledTimes(4);
  for (let index = 0; index < 4; index += 1) {
    expect(vi.mocked(ledger.beginPreparationCall).mock.invocationCallOrder[index]).toBeLessThan(fetch.mock.invocationCallOrder[index]);
  }
});

it('stops before the first request beyond the allowance and preserves the funding error', async () => {
  const fetch = responses([structure]);
  vi.mocked(ledger.beginPreparationCall).mockResolvedValueOnce('accepted').mockRejectedValueOnce(
    new DevelopmentError(409, 'preparation_allowance_exceeded', 'The next preparation request exceeds the allowance.'));
  await expect(prepareSource(draft, 'tester', 'fictional.txt', content, preparation)).rejects.toMatchObject({ code: 'preparation_allowance_exceeded' });
  expect(fetch).toHaveBeenCalledOnce();
});

it('keeps verified free parsing usable at zero and structured JSON outside the provider gate', async () => {
  vi.mocked(routing.resolveRoute).mockResolvedValue({ ...route, provider_id: 'openrouter', model: 'openrouter/free' });
  const fetch = responses([structure, classification]);
  const uploaded = await prepareSource(draft, 'tester', 'fictional.txt', content);
  expect(uploaded.document.role).toBe('source');
  expect(ledger.beginPreparationCall).toHaveBeenCalledWith(preparation.id, expect.objectContaining({ cost_usd: 0 }));
  vi.mocked(ledger.beginPreparationCall).mockClear();
  const source_document_ids = [uploaded.document.id];
  const structured = { ...expected, source_document_ids, expected_answers: [
    { id: 'g1', source_document_id: uploaded.document.id, statement: source, quote: source },
  ] };
  await expect(prepareReference({ ...draft, documents: [uploaded.document] }, 'tester', { ...pdfInput,
    filename: 'fictional.json', format: 'structured', source_document_ids,
    content_base64: Buffer.from(JSON.stringify(structured)).toString('base64'),
  })).resolves.toMatchObject({ document: { parser: { name: 'development-structured-reference' } } });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(ledger.beginPreparationCall).not.toHaveBeenCalled();
});

it('settles a truncated response with complete billing evidence before returning the parse failure', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    choices: [{ finish_reason: 'length', message: { content: '{' } }],
    usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 50 },
  }));
  await expect(prepareSource(draft, 'tester', 'fictional.txt', content, preparation)).rejects.toMatchObject({ code: 'parse_failed' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(ledger.settlePreparationCall).toHaveBeenCalledExactlyOnceWith(
    preparation.id, 'reserved-call', expect.objectContaining({ cost_usd: 0.000625 }),
  );
});

it('leaves the reservation active after a response with ambiguous billing', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    choices: [{ finish_reason: 'length', message: { content: '{' } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }));
  await expect(prepareSource(draft, 'tester', 'fictional.txt', content, preparation)).rejects.toMatchObject({ code: 'parse_failed' });
  expect(ledger.beginPreparationCall).toHaveBeenCalledOnce();
  expect(ledger.settlePreparationCall).not.toHaveBeenCalled();
});
