/**
 * Backend client.
 *
 * Every call:
 *   - attaches the shared token
 *   - attaches X-Requested-With (the server's CSRF guard for browser contexts)
 *   - times out fast, so a stopped backend never stalls the browser
 *   - on failure, queues the payload locally instead of dropping it
 */

import * as store from './store.js';
import { getSettings, clearCache } from './settings.js';

const TIMEOUT_MS = 12000;
let backendOk = null;          // null = unknown, true/false
let backendCheckedAt = 0;

export function backendStatus() {
  return { ok: backendOk === true, checkedAt: backendCheckedAt };
}

async function base() {
  const settings = await getSettings();
  return String(settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
}

async function headers(extra = {}) {
  const settings = await getSettings();
  const out = Object.assign({
    'Content-Type': 'application/json',
    'X-Requested-With': 'TwinBrain',
    'X-TwinBrain-Client': 'extension'
  }, extra);
  if (settings.token) out['X-TwinBrain-Token'] = settings.token;
  return out;
}

export async function request(path, { method = 'GET', body = null, timeout = TIMEOUT_MS,
                                      raw = false } = {}) {
  const url = `${await base()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      headers: await headers(),
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store'
    });
    backendOk = true;
    backendCheckedAt = Date.now();
    if (raw) return response;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) {
      const err = new Error((data && (data.error || data.detail)) || `HTTP ${response.status}`);
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (error) {
    if (error && (error.name === 'AbortError' || /Failed to fetch|NetworkError/i.test(String(error.message)))) {
      backendOk = false;
      backendCheckedAt = Date.now();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Try to obtain the token from a local backend that allows auto-pairing. */
export async function pair() {
  const settings = await getSettings();
  if (settings.token) return settings.token;
  try {
    const data = await request('/api/token', { timeout: 4000 });
    if (data && data.token) {
      clearCache();
      await chrome.storage.local.set({
        settings: Object.assign({}, settings, { token: data.token })
      });
      clearCache();
      return data.token;
    }
  } catch (error) {
    // no local backend or pairing disabled — the options page shows how to do it
  }
  return '';
}

export async function ping() {
  try {
    const data = await request('/api/health', { timeout: 5000 });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
}

// ---------------------------------------------------------------------------
// capture (with offline queue)
// ---------------------------------------------------------------------------

export async function capture(payload) {
  try {
    const data = await request('/api/capture', { method: 'POST', body: payload });
    await store.cachePage(Object.assign({}, payload, { mode: payload.mode || 'full' }));
    return { ok: true, data };
  } catch (error) {
    await store.enqueue('capture', payload);
    return { ok: false, queued: true, error: String(error && error.message || error) };
  }
}

export async function recordVisit(payload) {
  try {
    const data = await request('/api/capture/visit', { method: 'POST', body: payload });
    await store.cachePage(Object.assign({}, payload, { text: '' }));
    return { ok: true, data };
  } catch (error) {
    await store.enqueue('visit', payload);
    return { ok: false, queued: true, error: String(error && error.message || error) };
  }
}

export async function flushQueue(limit = 40) {
  const pending = await store.queueItems(limit);
  if (!pending.length) return { flushed: 0, remaining: await store.queueLength() };
  let flushed = 0;
  for (const item of pending) {
    const endpoint = item.kind === 'visit' ? '/api/capture/visit' : '/api/capture';
    try {
      await request(endpoint, { method: 'POST', body: item.payload });
      await store.removeQueued(item.id);
      flushed += 1;
    } catch (error) {
      await store.markTried(item.id);
      // drop hopeless items so the queue cannot grow forever
      if ((item.tries || 0) > 40) await store.removeQueued(item.id);
      break;
    }
  }
  return { flushed, remaining: await store.queueLength() };
}

// ---------------------------------------------------------------------------
// queries & memory
// ---------------------------------------------------------------------------

export function query(text, opts = {}) {
  return request('/api/query', {
    method: 'POST',
    body: Object.assign({ query: text }, opts),
    timeout: 90000
  });
}

export function search(text, opts = {}) {
  return request('/api/search', {
    method: 'POST',
    body: Object.assign({ query: text }, opts),
    timeout: 20000
  });
}

export function heartbeat(payload = {}) {
  return request('/api/heartbeat', { method: 'POST', body: payload, timeout: 8000 });
}

export function forget(target) {
  return request('/api/forget', { method: 'POST', body: target });
}

export function setDomainModeOnServer(domain, mode) {
  return request('/api/domains/mode', { method: 'POST', body: { domain, mode } });
}

export function fetchDomains(query = '') {
  return request(`/api/domains${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

export function fetchSettings() {
  return request('/api/settings');
}

export function updateSettings(settings) {
  return request('/api/settings', { method: 'POST', body: { settings } });
}

export function fetchPages(params = {}) {
  const search = new URLSearchParams(params).toString();
  return request(`/api/pages${search ? `?${search}` : ''}`);
}

export function fetchPage(pageId) {
  return request(`/api/pages/${encodeURIComponent(pageId)}`);
}

export function fetchInterests() {
  return request('/api/interests');
}

export function fetchDigest(day) {
  return request(`/api/digest${day ? `?day=${encodeURIComponent(day)}` : ''}`);
}

export function fetchInsights(unseen = false) {
  return request(`/api/insights${unseen ? '?unseen=1' : ''}`);
}

export function markInsightSeen(id, dismissed = false) {
  return request(`/api/insights/${encodeURIComponent(id)}/seen`,
                 { method: 'POST', body: { dismissed } });
}

export function drainNotifications() {
  return request('/api/notifications');
}

export function runEnrichment(daily = false) {
  return request('/api/enrichment/run', { method: 'POST', body: { daily }, timeout: 90000 });
}

export function fetchStats() {
  return request('/api/stats');
}

export function fetchSuggestions() {
  return request('/api/suggestions');
}

export function exportMemory(includeText = true) {
  return request(`/api/export?include_text=${includeText ? 1 : 0}`, { timeout: 120000 });
}

export function wipeMemory(confirmText, keepSettings = true) {
  return request('/api/wipe', { method: 'POST',
                                body: { confirm: confirmText, keep_settings: keepSettings } });
}

export function webSearch(text) {
  return request(`/api/web?q=${encodeURIComponent(text)}`, { timeout: 30000 });
}

export function runJob(name) {
  return request(`/api/jobs/run/${encodeURIComponent(name)}`, { method: 'POST', timeout: 180000 });
}

export function switchProvider(provider) {
  return request('/api/llm/provider', { method: 'POST', body: { provider } });
}

export function importDump(dump, embed = true) {
  return request('/api/import', { method: 'POST', body: { dump, embed }, timeout: 300000 });
}

export function fetchAudit() {
  return request('/api/enrichment');
}

export function fetchEngine() {
  return request('/api/engine');
}

export function saveWebResult(payload) {
  return request('/api/web/save', { method: 'POST', body: payload, timeout: 60000 });
}
