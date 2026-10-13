/** Pure native Anthropic protocol rules, aligned with modules/llm/provider.ts.
 * Kept local to the benchmark to avoid production environment loading/retries.
 */
export function anthropicSampling(model: string, temperature: unknown): { temperature?: unknown } {
  return /^claude-(?:(?:opus|sonnet|fable|mythos)-5|opus-4-[78])(?:-|$)/.test(model)
    ? {} : { temperature };
}
/** Join only answer text without separators; reject refusal, truncation and empty answers.
 * Callers retain raw responses and usage before interpreting this nullable result.
 */
export function anthropicAnswer(payload: Record<string, unknown>): string | null {
  if (payload.stop_reason === 'refusal' || payload.stop_reason === 'max_tokens') return null;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const answer = content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const value = block as Record<string, unknown>;
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
  }).join('');
  return answer.trim() ? answer : null;
}
