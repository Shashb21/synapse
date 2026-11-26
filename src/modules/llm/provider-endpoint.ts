/** Standard endpoints for which the published direct-provider rates apply. */
const ENDPOINTS = {
  'xai-grok': ['XAI_BASE_URL', 'https://api.x.ai/v1'],
  'anthropic-claude': ['ANTHROPIC_BASE_URL', 'https://api.anthropic.com'],
  openai: ['OPENAI_BASE_URL', 'https://api.openai.com/v1'],
  'google-gemini': ['GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'],
  openrouter: ['OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'],
} as const;

type StandardProvider = keyof typeof ENDPOINTS;

export function providerBaseUrl(id: StandardProvider): string {
  const [envName, standard] = ENDPOINTS[id];
  return process.env[envName]?.trim() || standard;
}

export function usesStandardProviderEndpoint(id: string): boolean {
  if (!Object.hasOwn(ENDPOINTS, id)) return false;
  const provider = id as StandardProvider;
  return providerBaseUrl(provider).replace(/\/$/, '') === ENDPOINTS[provider][1];
}
