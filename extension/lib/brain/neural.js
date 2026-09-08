/**
 * Neural core — real LLMs, locally.
 *
 * The extension talks to a local model server when one is running:
 *   - Ollama            http://127.0.0.1:11434  (ollama.com — llama3.2, qwen,
 *                                                gemma, phi… or YOUR OWN
 *                                                "twinbrain" Modelfile)
 *   - OpenAI-compatible llama.cpp server, LM Studio, vLLM, Oobabooga — or a
 *                        cloud key if the user pastes one (privacy-gated by
 *                        policy.js before any memory leaves the machine)
 *
 * No local model? detectProvider returns null and the on-device persona brain
 * answers instead — the AI never breaks, it just downgrades gracefully.
 *
 * Streaming: async generators yield token strings; the service worker
 * broadcasts them so the popup renders a REAL model typing live.
 */

import { memoryAllowedFor } from './policy.js';

/** Preference order when the user leaves the model on "auto". */
export const MODEL_PREFERENCE = [
  'twinbrain',                    // the user's own grown Modelfile (growth.js)
  'llama3.2', 'llama3.1', 'llama3',
  'qwen2.5', 'qwen2', 'qwen',
  'gemma2', 'gemma',
  'phi3', 'phi',
  'mistral', 'mixtral',
];

const DETECT_TIMEOUT_MS = 1500;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Pure: parse one Ollama NDJSON chunk. -> {token, done} */
export function parseOllamaChunk(line) {
  if (!line || !line.trim()) return null;
  try {
    const data = JSON.parse(line);
    const token = (data.message && typeof data.message.content === 'string')
      ? data.message.content : '';
    return { token, done: Boolean(data.done), error: data.error || null };
  } catch {
    return null;
  }
}

/** Pure: parse one OpenAI-compatible SSE line. -> {token, done} */
export function parseSSELine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return { token: '', done: true };
  try {
    const data = JSON.parse(payload);
    const choice = (data.choices || [])[0] || {};
    const token = (choice.delta && choice.delta.content) || choice.text || '';
    return { token, done: Boolean(choice.finish_reason) || Boolean(data.done) };
  } catch {
    return null;
  }
}

/** Pure: pick the best model from an Ollama /api/tags payload. */
export function pickModel(tagsPayload, requested) {
  const models = ((tagsPayload && tagsPayload.models) || [])
    .map((m) => String(m.name || ''))
    .filter(Boolean);
  if (!models.length) return null;
  if (requested && requested !== 'auto') {
    const exact = models.find((name) => name === requested ||
      name.split(':')[0] === requested.split(':')[0]);
    if (exact) return exact;
  }
  for (const preferred of MODEL_PREFERENCE) {
    const found = models.find((name) => name.split(':')[0].startsWith(preferred));
    if (found) return found;
  }
  return models[0];
}

/**
 * Probe the configured providers. Returns a provider handle or null.
 * {kind:'ollama'|'openai', baseUrl, model, label, local:boolean}
 */
export async function detectProvider(settings = {}) {
  const backend = settings.neuralBackend || 'auto';
  if (settings.neuralEnabled === false || backend === 'off') return null;

  if (backend === 'auto' || backend === 'ollama') {
    const base = String(settings.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const tags = await withTimeout(
      fetch(`${base}/api/tags`).then((res) => (res.ok ? res.json() : null)).catch(() => null),
      DETECT_TIMEOUT_MS);
    const model = pickModel(tags, settings.ollamaModel);
    if (model) {
      return { kind: 'ollama', baseUrl: base, model, local: true,
               label: `ollama · ${model}` };
    }
  }

  if ((backend === 'auto' || backend === 'openai') && settings.openaiUrl) {
    const base = String(settings.openaiUrl).replace(/\/+$/, '');
    const probe = await withTimeout(
      fetch(`${base}/models`, {
        headers: settings.openaiKey ? { Authorization: `Bearer ${settings.openaiKey}` } : {},
      }).then((res) => (res.ok ? res.json() : null)).catch(() => null),
      DETECT_TIMEOUT_MS);
    const models = ((probe && probe.data) || []).map((m) => m.id).filter(Boolean);
    const model = settings.openaiModel || models[0];
    if (model) {
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|[a-z0-9-]+\.local)/i.test(base);
      return { kind: 'openai', baseUrl: base, model, local,
               label: `openai-compat · ${model}` };
    }
  }
  return null;
}

/**
 * Stream a chat completion. Yields token strings.
 * messages: [{role:'system'|'user'|'assistant', content}]
 */
export async function* streamChat(provider, messages, options = {}) {
  if (!provider) return;
  if (provider.kind === 'ollama') {
    const res = await fetch(`${provider.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        options: Object.assign({ temperature: 0.7, num_ctx: 8192 }, options.parameters || {}),
      }),
      signal: options.signal,
    });
    if (!res.ok || !res.body) throw new Error(`ollama http ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const parsed = parseOllamaChunk(line);
        if (!parsed) continue;
        if (parsed.error) throw new Error(String(parsed.error).slice(0, 200));
        if (parsed.token) yield parsed.token;
        if (parsed.done) return;
      }
    }
    return;
  }

  // openai-compatible
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      options.key ? { Authorization: `Bearer ${options.key}` } : {}),
    body: JSON.stringify({
      model: provider.model,
      messages,
      stream: true,
      temperature: options.temperature !== undefined ? options.temperature : 0.7,
    }),
    signal: options.signal,
  });
  if (!res.ok || !res.body) throw new Error(`openai-compat http ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const parsed = parseSSELine(line);
      if (!parsed) continue;
      if (parsed.token) yield parsed.token;
      if (parsed.done) return;
    }
  }
}

/** Non-streaming collect — handy for tools and tests with mocked fetch. */
export async function complete(provider, messages, options = {}) {
  let out = '';
  for await (const token of streamChat(provider, messages, options)) out += token;
  return out;
}

/**
 * Privacy filter for prompt building: when the provider is a remote/cloud one
 * and the user did NOT allow memory to leave the machine, memory slices are
 * stripped from the prompt (the model still chats, it just loses the library).
 */
export function promptAllowsMemory(provider, settings) {
  return memoryAllowedFor(provider ? provider.kind : 'local', settings);
}
