'use strict';

/**
 * AI providers the assistant can use. Claude goes through Anthropic's SDK
 * (with web research); every other provider speaks the OpenAI Chat
 * Completions format with function calling. Whichever one is picked, the
 * assistant has the same tools, the same allow-list and the same approval
 * step for every change.
 *
 * `open: true` marks open-weight models people can also download and run
 * themselves. `local: true` runs on this computer, so nothing leaves it.
 */
const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    group: 'recommended',
    kind: 'anthropic',
    model: 'claude-opus-5-5',
    needsKey: true,
    keyPage: 'https://console.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    open: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    group: 'open',
    kind: 'openai',
    baseURL: 'https://api.deepseek.com',
    // deepseek-chat and deepseek-reasoner were retired in July 2026.
    model: 'deepseek-flash',
    needsKey: true,
    keyPage: 'https://platform.deepseek.com/api_keys',
    envKey: 'DEEPSEEK_API_KEY',
    open: true,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    group: 'open',
    kind: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest',
    needsKey: true,
    keyPage: 'https://console.mistral.ai/api-keys',
    envKey: 'MISTRAL_API_KEY',
    open: true,
  },
  {
    id: 'groq',
    label: 'Groq (Llama, Qwen, gpt-oss)',
    group: 'open',
    kind: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    needsKey: true,
    keyPage: 'https://console.groq.com/keys',
    envKey: 'GROQ_API_KEY',
    open: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (many open and closed models)',
    group: 'open',
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    // Only route to hosts of the model that can actually call tools.
    body: { provider: { require_parameters: true } },
    // Reasoning models there need their reasoning back, in OpenRouter's fields.
    echo: ['reasoning', 'reasoning_details'],
    needsKey: true,
    keyPage: 'https://openrouter.ai/keys',
    envKey: 'OPENROUTER_API_KEY',
    open: true,
    headers: { 'HTTP-Referer': 'https://github.com/katesaikishore/plug-doctor', 'X-Title': 'Plug Doctor' },
  },
  {
    id: 'together',
    label: 'Together AI',
    group: 'open',
    kind: 'openai',
    baseURL: 'https://api.together.ai/v1',
    model: 'zai-org/GLM-5.3-Flash',
    needsKey: true,
    keyPage: 'https://api.together.ai/settings/projects/~current/api-keys',
    envKey: 'TOGETHER_API_KEY',
    open: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (on this computer)',
    group: 'local',
    kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen3',
    needsKey: false,
    keyPage: 'https://ollama.com/download',
    open: true,
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (on this computer)',
    group: 'local',
    kind: 'openai',
    baseURL: 'http://localhost:1234/v1',
    model: 'qwen/qwen3-8b',
    needsKey: false,
    keyPage: 'https://lmstudio.ai',
    open: true,
    local: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'closed',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-6-sol',
    // Chat Completions only lets GPT-6 models call tools with reasoning off.
    body: { reasoning_effort: 'none' },
    needsKey: true,
    keyPage: 'https://platform.openai.com/api-keys',
    envKey: 'OPENAI_API_KEY',
    open: false,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    group: 'closed',
    kind: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    needsKey: true,
    keyPage: 'https://aistudio.google.com/apikey',
    envKey: 'GEMINI_API_KEY',
    open: false,
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    group: 'closed',
    kind: 'openai',
    baseURL: 'https://api.x.ai/v1',
    model: 'grok-4.7',
    // Grok 4.7 thinks hard by default; low keeps a chat about a device quick.
    body: { reasoning_effort: 'low' },
    needsKey: true,
    keyPage: 'https://console.x.ai',
    envKey: 'XAI_API_KEY',
    open: false,
  },
  {
    id: 'custom',
    label: 'Another OpenAI-compatible server',
    group: 'other',
    kind: 'openai',
    baseURL: '',
    model: '',
    needsKey: false,
    custom: true,
    open: false,
  },
];

const GROUPS = {
  recommended: 'Recommended',
  open: 'Open models',
  local: 'On this computer (nothing leaves it)',
  closed: 'Other closed models',
  other: 'Other',
};

function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** What the page may know about providers: no keys, no headers. */
function publicProviders() {
  return PROVIDERS.map(({ id, label, group, kind, model, needsKey, keyPage, open, local, custom, baseURL }) => ({
    id,
    label,
    group,
    groupLabel: GROUPS[group],
    kind,
    model,
    needsKey,
    keyPage: keyPage ?? null,
    open: Boolean(open),
    local: Boolean(local),
    custom: Boolean(custom),
    baseURL: baseURL ?? '',
  }));
}

/** A server address the person typed: http(s) only. Plain http is only allowed for this computer. */
function validBaseUrl(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.toString().replace(/\/+$/, '');
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.toString().replace(/\/+$/, '');
  return null;
}

module.exports = { PROVIDERS, GROUPS, providerById, publicProviders, validBaseUrl };
