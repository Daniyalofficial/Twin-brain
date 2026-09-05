/**
 * Twin-Brain background service worker (Manifest V3).
 *
 * Responsibilities
 *   1. exclusion gate — checked BEFORE any script is injected into a page
 *   2. dwell/scroll tracking and capture triggering (with a link-only fallback
 *      for pages where injection is impossible: PDFs, restricted origins)
 *   3. offline outbox — nothing you read is lost if the backend is asleep
 *   4. context menus, keyboard shortcuts, badge state
 *   5. budgeted notifications from the backend's daily insight sweep
 *   6. settings sync with the backend (one source of truth for both)
 *
 * MV3 note: a service worker can be terminated at any moment, so all durable
 * state lives in chrome.storage (session for tab timings, local for settings).
 */

import * as api from './lib/api.js';
import * as store from './lib/store.js';
import {
  DEFAULT_SETTINGS, DOMAIN_MODES
} from './lib/defaults.js';
import {
  getSettings, saveSettings, classifyUrl, normalizeUrl, domainOf, registrableDomain,
  forgetUrl, forgetDomain, setDomainMode, isForgotten, noteSeenDomain, clearCache
} from './lib/settings.js';

const TICK_ALARM = 'tb-tick';
const HEARTBEAT_ALARM = 'tb-heartbeat';
const FLUSH_ALARM = 'tb-flush';
const SESSION_KEY = 'tabState';
const COUNTS_KEY = 'counts';

/** @type {Map<number, object>} */
let tabs = new Map();
let restoring = null;
let lastBadge = '';

// ---------------------------------------------------------------------------
// tab state (persisted to session storage so a worker restart loses nothing)
// ---------------------------------------------------------------------------

function blankTab(tabId, url, title, incognito) {
  return {
    tabId,
    url: url || '',
    normalized: normalizeUrl(url || ''),
    title: title || '',
    incognito: Boolean(incognito),
    startedAt: Date.now(),
    activeMs: 0,
    lastTick: Date.now(),
    maxScroll: 0,
    captured: false,
    linkRecorded: false,
    observing: false,
    injectFailed: false,
    verdict: null
  };
}

async function snapshot() {
  const plain = {};
  tabs.forEach((value, key) => { plain[key] = value; });
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: plain });
  } catch (error) { /* session storage unavailable — timings just restart */ }
}

async function restore() {
  if (restoring) return restoring;
  restoring = (async () => {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const plain = stored[SESSION_KEY] || {};
      tabs = new Map();
      Object.keys(plain).forEach((key) => {
        const value = plain[key];
        if (value && value.url) {
          value.lastTick = Date.now();     // don't credit time the worker was dead
          tabs.set(Number(key), value);
        }
      });
    } catch (error) {
      tabs = new Map();
    }
    // reconcile with the tabs Chrome actually has open
    try {
      const open = await chrome.tabs.query({});
      const live = new Set();
      open.forEach((tab) => {
        live.add(tab.id);
        const known = tabs.get(tab.id);
        if (!known || known.url !== tab.url) {
          tabs.set(tab.id, blankTab(tab.id, tab.url, tab.title, tab.incognito));
        } else {
          known.title = tab.title || known.title;
          known.incognito = Boolean(tab.incognito);
        }
      });
      Array.from(tabs.keys()).forEach((id) => { if (!live.has(id)) tabs.delete(id); });
    } catch (error) { /* ignore */ }
    return true;
  })();
  return restoring;
}

async function bumpCounts(kind) {
  const stored = await chrome.storage.local.get(COUNTS_KEY);
  const counts = Object.assign({ captured: 0, skipped: 0, queued: 0, day: '' },
                               stored[COUNTS_KEY] || {});
  const today = new Date().toISOString().slice(0, 10);
  if (counts.day !== today) {
    counts.day = today; counts.captured = 0; counts.skipped = 0;
  }
  counts[kind] = (counts[kind] || 0) + 1;
  await chrome.storage.local.set({ [COUNTS_KEY]: counts });
  return counts;
}

async function getCounts() {
  const stored = await chrome.storage.local.get(COUNTS_KEY);
  const counts = Object.assign({ captured: 0, skipped: 0, queued: 0, day: '' },
                               stored[COUNTS_KEY] || {});
  const today = new Date().toISOString().slice(0, 10);
  if (counts.day !== today) { counts.day = today; counts.captured = 0; counts.skipped = 0; }
  counts.queued = await store.queueLength();
  return counts;
}

// ---------------------------------------------------------------------------
// badge — capture state must be visible at a glance
// ---------------------------------------------------------------------------

async function updateBadge() {
  const settings = await getSettings();
  let text = '';
  let color = '#2f6f4f';
  let title = 'Twin-Brain';
  if (settings.globalPause || !settings.captureEnabled) {
    text = 'OFF';
    color = '#8a2b2b';
    title = 'Twin-Brain — capture is PAUSED (nothing is being recorded)';
  } else {
    const counts = await getCounts();
    const status = api.backendStatus();
    if (counts.queued > 0) {
      text = String(Math.min(counts.queued, 99));
      color = '#8a6d2b';
      title = `Twin-Brain — ${counts.queued} capture(s) waiting for the backend`;
    } else if (!status.ok && status.checkedAt) {
      text = '!';
      color = '#8a6d2b';
      title = 'Twin-Brain — backend unreachable; captures are queued locally';
    } else if (settings.showBadgeCount && counts.captured > 0) {
      text = String(Math.min(counts.captured, 99));
      color = '#2f6f4f';
      title = `Twin-Brain — ${counts.captured} page(s) remembered today`;
    } else {
      text = '';
      color = '#2f6f4f';
      title = 'Twin-Brain — capturing';
    }
  }
  const key = `${text}|${color}|${title}`;
  if (key === lastBadge) return;
  lastBadge = key;
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
  } catch (error) { /* action may be unavailable during install */ }
}

// ---------------------------------------------------------------------------
// the exclusion gate + injection
// ---------------------------------------------------------------------------

async function shouldObserve(tab) {
  if (!tab || !tab.url) return { allowed: false, reason: 'no url' };
  if (tab.incognito) return { allowed: false, reason: 'incognito window (never captured)' };
  if (await isForgotten(tab.url)) return { allowed: false, reason: 'you forgot this page' };
  const settings = await getSettings();
  const verdict = classifyUrl(tab.url, settings);
  if (!verdict.allowed) return { allowed: false, reason: verdict.reason, verdict };
  if (verdict.domain) await noteSeenDomain(verdict.domain, verdict.mode);
  return { allowed: true, verdict };
}

async function inject(tabId, url) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content/extractor.js', 'content/observer.js'],
      injectImmediately: false
    });
    return true;
  } catch (error) {
    return false;
  }
}

/** Called on every main-frame navigation. The gate runs BEFORE injection. */
async function onNavigated(tab, reason) {
  await restore();
  if (!tab || !tab.id) return;
  const state = blankTab(tab.id, tab.url, tab.title, tab.incognito);
  tabs.set(tab.id, state);

  const decision = await shouldObserve(tab);
  state.verdict = decision.verdict || { reason: decision.reason };
  if (!decision.allowed) {
    state.observing = false;
    await bumpCounts('skipped');
    await snapshot();
    await updateBadge();
    return;
  }

  const injected = await inject(tab.id, tab.url);
  state.observing = injected;
  state.injectFailed = !injected;
  if (!injected) {
    // PDFs, restricted origins, chrome:// — we cannot read them, but we can
    // still honour "never forget the link" with a link-only record.
    state.linkOnly = true;
  }
  await snapshot();
  await updateBadge();
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function sendCapture(payload, tabState) {
  const settings = await getSettings();
  const decision = await shouldObserve({ url: payload.url, incognito: tabState && tabState.incognito });
  if (!decision.allowed) {
    if (tabState) tabState.captured = true;      // do not keep retrying
    await bumpCounts('skipped');
    return { skipped: true, reason: decision.reason };
  }
  const mode = decision.verdict ? decision.verdict.mode : 'full';
  const body = Object.assign({}, payload, { mode });
  if (mode === 'no_ai' || !settings.captureContent) {
    body.text = '';
    body.capture_content = false;
  }
  const result = body.text ? await api.capture(body) : await api.recordVisit(body);
  if (tabState) {
    tabState.captured = true;
    tabState.activeMs = Math.max(tabState.activeMs, (payload.dwell_seconds || 0) * 1000);
    tabState.maxScroll = Math.max(tabState.maxScroll, payload.scroll_depth || 0);
  }
  await bumpCounts(result && result.ok ? 'captured' : 'queued');
  await snapshot();
  await updateBadge();
  return result;
}

async function recordLinkOnly(tabState, reason) {
  if (!tabState || tabState.captured || tabState.linkRecorded) return null;
  const decision = await shouldObserve({ url: tabState.url, incognito: tabState.incognito });
  if (!decision.allowed) return null;
  tabState.linkRecorded = true;
  const payload = {
    url: tabState.url,
    title: tabState.title,
    text: '',
    visited_at: new Date().toISOString().slice(0, 19),
    dwell_seconds: Math.round(tabState.activeMs / 1000),
    scroll_depth: Math.round(tabState.maxScroll * 1000) / 1000,
    source: 'extension',
    capture_content: false,
    link_only: true,
    reason: reason || 'content not readable'
  };
  const result = await api.recordVisit(payload);
  await bumpCounts(result && result.ok ? 'captured' : 'queued');
  await snapshot();
  await updateBadge();
  return result;
}

// ---------------------------------------------------------------------------
// periodic tick: dwell accounting, fallbacks, queue flush, notifications
// ---------------------------------------------------------------------------

async function tick() {
  await restore();
  const settings = await getSettings();
  const now = Date.now();

  let activeTabId = null;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = active ? active.id : null;
  } catch (error) { activeTabId = null; }

  tabs.forEach((state) => {
    const delta = now - (state.lastTick || now);
    state.lastTick = now;
    const counts = state.tabId === activeTabId;
    if (counts && delta > 0 && delta < 90000) state.activeMs += delta;

    const dwell = Math.round(state.activeMs / 1000);
    const min = Number(settings.minDwellSeconds || DEFAULT_SETTINGS.minDwellSeconds);

    // fallback path: pages we could not inject into still get their link saved
    if (!state.captured && dwell >= min && (state.injectFailed || state.linkOnly)) {
      recordLinkOnly(state, 'injection not possible');
    }
  });

  await snapshot();

  // flush anything queued while the backend was down
  const queued = await store.queueLength();
  if (queued > 0) {
    const result = await api.flushQueue(20);
    if (result.flushed > 0) await updateBadge();
  }
  await updateBadge();
}

async function heartbeat() {
  await restore();
  const settings = await getSettings();
  const counts = await getCounts();
  const modes = {};
  Object.keys(settings.domainModes || {}).forEach((domain) => {
    const mode = settings.domainModes[domain];
    if (mode === 'off' || mode === 'no_ai') modes[domain] = mode;
  });
  try {
    const response = await api.heartbeat({
      tz_offset_minutes: -new Date().getTimezoneOffset(),
      version: chrome.runtime.getManifest().version,
      client_id: await clientId(),
      counts,
      domain_modes: Object.keys(modes).map((domain) => ({ domain, mode: modes[domain] }))
    });
    if (response && response.settings) applyServerSettings(response.settings);
    if (response && Array.isArray(response.notifications)) {
      response.notifications.forEach(showNotification);
    } else if (response && Array.isArray(response.insights)) {
      response.insights.slice(0, 5).forEach(showNotification);
    }
    return response;
  } catch (error) {
    await updateBadge();
    return null;
  }
}

async function clientId() {
  const stored = await chrome.storage.local.get('clientId');
  if (stored.clientId) return stored.clientId;
  const id = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.local.set({ clientId: id });
  return id;
}

/**
 * Server settings win for anything both sides care about, so there is a single
 * place to change behaviour. Extension-only keys (backend URL, token, theme)
 * are never overwritten.
 */
const SERVER_TO_LOCAL = {
  capture_enabled: 'captureEnabled',
  capture_content: 'captureContent',
  min_dwell_seconds: 'minDwellSeconds',
  global_pause: 'globalPause',
  retention_days: 'retentionDays',
  skip_sensitive_urls: 'skipSensitiveUrls',
  web_search_enabled: 'webSearchEnabled',
  enrichment_enabled: 'enrichmentEnabled',
  notifications_enabled: 'notificationsEnabled',
  notification_daily_budget: 'notificationDailyBudget',
  enrichment_daily_budget: 'enrichmentDailyBudget',
  answer_style: 'answerStyle',
  top_k: 'topK'
};

let applyingServerSettings = false;
async function applyServerSettings(serverSettings) {
  if (applyingServerSettings) return;
  applyingServerSettings = true;
  try {
    const current = await getSettings(true);
    const patch = {};
    Object.keys(SERVER_TO_LOCAL).forEach((serverKey) => {
      const localKey = SERVER_TO_LOCAL[serverKey];
      const value = serverSettings[serverKey];
      if (value === undefined || value === null) return;
      if (current[localKey] !== value) patch[localKey] = value;
    });
    if (Object.keys(patch).length) await saveSettings(patch);
  } finally {
    applyingServerSettings = false;
  }
}

// ---------------------------------------------------------------------------
// notifications (budget is enforced server-side; dedupe here)
// ---------------------------------------------------------------------------

const shownNotifications = new Set();

async function showNotification(insight) {
  if (!insight || !insight.id) return;
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;
  if (shownNotifications.has(insight.id)) return;
  shownNotifications.add(insight.id);
  await rememberInsight(insight);       // so clicking it can open the source
  try {
    await chrome.notifications.create(`tb-${insight.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: (insight.title || 'Twin-Brain').slice(0, 120),
      message: String(insight.body || '').slice(0, 500),
      priority: 1,
      requireInteraction: false
    });
  } catch (error) { /* notifications permission may be blocked by policy */ }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    const insightId = notificationId.replace(/^tb-/, '');
    const settings = await getSettings();
    await api.markInsightSeen(insightId).catch(() => null);
    const data = await chrome.storage.local.get(`insight:${insightId}`);
    const insight = data[`insight:${insightId}`];
    if (insight && insight.url) await chrome.tabs.create({ url: insight.url });
    else await chrome.tabs.create({ url: `${settings.backendUrl.replace(/\/+$/, '')}/` });
    chrome.notifications.clear(notificationId);
  } catch (error) { /* ignore */ }
});

async function rememberInsight(insight) {
  if (!insight || !insight.id) return;
  await chrome.storage.local.set({ [`insight:${insight.id}`]: insight });
}

// ---------------------------------------------------------------------------
// content script messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const response = await handleMessage(message, sender);
      sendResponse(response || {});
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    }
  })();
  return true;    // keep the message channel open for the async reply
});

async function handleMessage(message, sender) {
  if (!message || !message.type) return { ok: false, error: 'bad message' };
  const tabId = sender && sender.tab ? sender.tab.id : null;
  await restore();

  switch (message.type) {
    // --- from the observer content script -------------------------------
    case 'tb-init': {
      if (sender && sender.tab && sender.tab.incognito) return { ok: false, config: null };
      const settings = await getSettings();
      const decision = await shouldObserve({ url: message.url || (sender.tab || {}).url,
                                             incognito: (sender.tab || {}).incognito });
      if (!decision.allowed) return { ok: false, reason: decision.reason };
      const state = tabId !== null ? tabs.get(tabId) : null;
      if (state) {
        state.observing = true;
        state.injectFailed = false;
        state.title = message.title || state.title;
      }
      return {
        ok: true,
        config: {
          minDwellSeconds: Number(settings.minDwellSeconds || 5),
          captureContent: Boolean(settings.captureContent) &&
            (decision.verdict ? decision.verdict.content : true),
          maxTextChars: Number(settings.maxTextChars || 120000),
          mode: decision.verdict ? decision.verdict.mode : 'full'
        }
      };
    }

    case 'tb-capture': {
      if (!message.payload || !message.payload.url) return { ok: false };
      const state = tabId !== null ? tabs.get(tabId) : null;
      if (message.payload.url !== (state ? state.url : message.payload.url)) {
        // SPA moved on while we were extracting — still store what we got
      }
      const result = await sendCapture(message.payload, state);
      if (message.payload && message.payload.title && state) state.title = message.payload.title;
      return Object.assign({ ok: true }, result || {});
    }

    case 'tb-progress': {
      const state = tabId !== null ? tabs.get(tabId) : null;
      if (state) {
        state.maxScroll = Math.max(state.maxScroll, Number(message.scroll) || 0);
        if (message.captured) state.captured = true;
        await snapshot();
      }
      return { ok: true };
    }

    case 'tb-navigated': {
      const tab = sender && sender.tab;
      if (!tab) return { ok: false };
      const fresh = { id: tab.id, url: message.to, title: tab.title, incognito: tab.incognito };
      await onNavigated(fresh, 'spa');
      return { ok: true };
    }

    // --- from the popup / options page ----------------------------------
    case 'tb-status': {
      const settings = await getSettings();
      const counts = await getCounts();
      const backend = await api.ping();
      return {
        ok: true,
        settings: publicSettings(settings),
        counts,
        backend: backend.ok ? { ok: true, stats: backend.data.counts,
                                engine: backend.data.engine, budgets: backend.data.budgets }
                            : { ok: false, error: backend.error },
        queued: counts.queued,
        modes: DOMAIN_MODES
      };
    }

    case 'tb-settings-get':
      return { ok: true, settings: publicSettings(await getSettings(true)) };

    case 'tb-settings-set': {
      const settings = await saveSettings(message.patch || {});
      await mirrorToServer(message.patch || {});
      await updateBadge();
      return { ok: true, settings: publicSettings(settings) };
    }

    case 'tb-domain-mode': {
      const domain = String(message.domain || '').toLowerCase();
      const mode = String(message.mode || 'full');
      await setDomainMode(domain, mode);
      try {
        await api.setDomainModeOnServer(domain, mode);
      } catch (error) { /* mirrored on the next heartbeat */ }
      if (mode === 'off') await forgetDomain(domain, 'extension setting');
      const settings = await getSettings(true);
      return { ok: true, settings: publicSettings(settings),
               serverMode: mode, applied: true };
    }

    case 'tb-domains': {
      try {
        const data = await api.fetchDomains(message.query || '');
        return Object.assign({ ok: true, local: await getDomainRows() }, data);
      } catch (error) {
        return { ok: true, domains: await getDomainRows(), offline: true,
                 error: String(error.message || error) };
      }
    }

    case 'tb-forget': {
      const url = message.url;
      const domain = message.domain;
      let server = null;
      if (domain) {
        await forgetDomain(domain, message.reason || 'user request');
        try { server = await api.forget({ domain, reason: message.reason }); } catch (e) { server = { ok: false, error: String(e.message || e) }; }
      } else if (url) {
        await forgetUrl(url, message.reason || 'user request');
        await store.forgetCachedUrl(normalizeUrl(url));
        const state = findStateByUrl(url);
        if (state) { state.captured = true; state.linkRecorded = true; }
        try { server = await api.forget({ url, reason: message.reason }); } catch (e) { server = { ok: false, error: String(e.message || e) }; }
      }
      await snapshot();
      await updateBadge();
      return { ok: true, server };
    }

    case 'tb-capture-now': {
      const tab = message.tabId ? await getTab(message.tabId) : await activeTab();
      if (!tab) return { ok: false, error: 'no active tab' };
      const decision = await shouldObserve(tab);
      if (!decision.allowed) return { ok: false, error: decision.reason, blocked: true };
      const injected = await inject(tab.id, tab.url);
      if (!injected) {
        const state = tabs.get(tab.id) || blankTab(tab.id, tab.url, tab.title, tab.incognito);
        tabs.set(tab.id, state);
        state.activeMs = Math.max(state.activeMs, 1000 * Number((await getSettings()).minDwellSeconds || 5));
        const result = await recordLinkOnly(state, 'saved on request');
        return { ok: true, injected: false, linkOnly: true, result };
      }
      return { ok: true, injected: true };
    }

    case 'tb-query':
      return await proxied(() => api.query(message.query, message.options || {}));

    case 'tb-search':
      return await proxied(() => api.search(message.query, message.options || {}));

    case 'tb-about-page': {
      const tab = message.tabId ? await getTab(message.tabId) : await activeTab();
      if (!tab || !tab.url) return { ok: false, error: 'no active tab' };
      const settings = await getSettings();
      return await proxied(() => api.request(
        `/api/page-by-url?url=${encodeURIComponent(tab.url)}`));
    }

    case 'tb-pages':
      return await proxied(() => api.fetchPages(message.params || {}));

    case 'tb-interests':
      return await proxied(() => api.fetchInterests());

    case 'tb-digest':
      return await proxied(() => api.fetchDigest(message.day));

    case 'tb-insights':
      return await proxied(() => api.fetchInsights(message.unseen));

    case 'tb-suggestions':
      return await proxied(() => api.fetchSuggestions());

    case 'tb-stats':
      return await proxied(() => api.fetchStats());

    case 'tb-enrich':
      return await proxied(() => api.runEnrichment(Boolean(message.daily)));

    case 'tb-web-search':
      return await proxied(() => api.webSearch(message.query));

    case 'tb-export':
      return await proxied(() => api.exportMemory(message.includeText !== false));

    case 'tb-wipe':
      return await proxied(() => api.wipeMemory(message.confirm, message.keepSettings !== false));

    case 'tb-import':
      return await proxied(() => api.importDump(message.dump, message.embed !== false));

    case 'tb-audit':
      return await proxied(() => api.fetchAudit());

    case 'tb-engine':
      return await proxied(() => api.fetchEngine());

    case 'tb-save-web':
      return await proxied(() => api.saveWebResult(message.payload || {}));

    case 'tb-run-job':
      return await proxied(() => api.runJob(message.job));

    case 'tb-flush':
      return { ok: true, ...(await api.flushQueue(50)) };

    case 'tb-pair': {
      const token = await api.pair();
      return { ok: Boolean(token), token };
    }

    case 'tb-provider':
      return await proxied(() => api.switchProvider(message.provider));

    case 'tb-open-dashboard': {
      const settings = await getSettings();
      const url = `${settings.backendUrl.replace(/\/+$/, '')}/${message.path || ''}`;
      await chrome.tabs.create({ url: message.query ? `${url}?${message.query}` : url });
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown message type ${message.type}` };
  }
}

async function proxied(fn) {
  try {
    const data = await fn();
    return Object.assign({ ok: true }, data && typeof data === 'object' ? data : { data });
  } catch (error) {
    return { ok: false, offline: !api.backendStatus().ok,
             error: String(error && error.message || error) };
  }
}

function publicSettings(settings) {
  const out = Object.assign({}, settings);
  out.token = settings.token ? `${String(settings.token).slice(0, 4)}…(${String(settings.token).length})` : '';
  out.tokenSet = Boolean(settings.token);
  out.domainModeCount = Object.keys(settings.domainModes || {}).length;
  delete out.domainModes;
  return out;
}

async function getDomainRows() {
  const [settings, seen] = await Promise.all([getSettings(), (async () => {
    const stored = await chrome.storage.local.get('seenDomains');
    return stored.seenDomains || {};
  })()]);
  return Object.keys(seen).map((domain) => ({
    domain,
    label: domain.replace(/^www\./, ''),
    registrable: registrableDomain(domain),
    mode: settings.domainModes[domain] || 'full',
    visits: seen[domain].visits || 0,
    last_seen: new Date(seen[domain].last || Date.now()).toISOString().slice(0, 19),
    in_memory: false,
    local: true
  })).sort((a, b) => (b.visits || 0) - (a.visits || 0));
}

async function mirrorToServer(patch) {
  const mapping = Object.fromEntries(Object.entries(SERVER_TO_LOCAL).map(([s, l]) => [l, s]));
  const body = {};
  Object.keys(patch || {}).forEach((key) => {
    if (mapping[key]) body[mapping[key]] = patch[key];
  });
  if (Object.keys(body).length) {
    try { await api.updateSettings(body); } catch (error) { /* next heartbeat */ }
  }
}

function findStateByUrl(url) {
  const normalized = normalizeUrl(url || '');
  let found = null;
  tabs.forEach((state) => { if (state.normalized === normalized) found = state; });
  return found;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch (error) { return null; }
}

// ---------------------------------------------------------------------------
// context menu
// ---------------------------------------------------------------------------

const MENU_IDS = ['tb-ask', 'tb-forget-page', 'tb-forget-domain', 'tb-save-now',
                  'tb-search-selection', 'tb-pause', 'tb-open'];

function buildMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'tb-ask', title: 'Ask Twin-Brain about this page',
                                   contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'tb-search-selection',
                                   title: 'Search my memory for “%s”',
                                   contexts: ['selection'] });
      chrome.contextMenus.create({ id: 'tb-save-now', title: 'Remember this page now',
                                   contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'tb-forget-page',
                                   title: "Forget this page (don't remember it)",
                                   contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'tb-forget-domain', title: 'Forget this whole site',
                                   contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'tb-pause', title: 'Pause / resume capturing',
                                   contexts: ['action'] });
      chrome.contextMenus.create({ id: 'tb-open', title: 'Open the Twin-Brain dashboard',
                                   contexts: ['action'] });
    });
  } catch (error) { /* menus unavailable */ }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await getSettings();
  const base = settings.backendUrl.replace(/\/+$/, '');
  switch (info.menuItemId) {
    case 'tb-ask': {
      const url = (tab && tab.url) || info.pageUrl;
      const q = url ? `What do I know about ${url}` : 'What did I read today?';
      await chrome.tabs.create({ url: `${base}/?ask=${encodeURIComponent(q)}` });
      break;
    }
    case 'tb-search-selection': {
      const text = String(info.selectionText || '').trim().slice(0, 200);
      if (text) await chrome.tabs.create({ url: `${base}/?ask=${encodeURIComponent(text)}` });
      break;
    }
    case 'tb-save-now':
      await handleMessage({ type: 'tb-capture-now', tabId: tab && tab.id }, {});
      break;
    case 'tb-forget-page': {
      const url = (tab && tab.url) || info.pageUrl;
      if (url) await handleMessage({ type: 'tb-forget', url, reason: 'context menu' }, {});
      break;
    }
    case 'tb-forget-domain': {
      const url = (tab && tab.url) || info.pageUrl;
      const domain = registrableDomain(domainOf(url || ''));
      if (domain) {
        await handleMessage({ type: 'tb-forget', domain, reason: 'context menu' }, {});
      }
      break;
    }
    case 'tb-pause':
      await saveSettings({ globalPause: !settings.globalPause });
      await mirrorToServer({ globalPause: !settings.globalPause });
      await updateBadge();
      break;
    case 'tb-open':
      await chrome.tabs.create({ url: `${base}/` });
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// keyboard shortcuts
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-pause') {
    const settings = await getSettings();
    await saveSettings({ globalPause: !settings.globalPause });
    await mirrorToServer({ globalPause: !settings.globalPause });
    await updateBadge();
  } else if (command === 'forget-page') {
    const tab = await activeTab();
    if (tab && tab.url) await handleMessage({ type: 'tb-forget', url: tab.url,
                                              reason: 'keyboard shortcut' }, {});
  } else if (command === 'ask-about-page') {
    const settings = await getSettings();
    const tab = await activeTab();
    const base = settings.backendUrl.replace(/\/+$/, '');
    const q = tab && tab.url ? `What do I know about ${tab.url}` : 'What did I read today?';
    await chrome.tabs.create({ url: `${base}/?ask=${encodeURIComponent(q)}` });
  }
});

// ---------------------------------------------------------------------------
// browser events
// ---------------------------------------------------------------------------

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const tab = await getTab(details.tabId);
  await onNavigated(tab || { id: details.tabId, url: details.url, title: '',
                             incognito: false }, 'navigation');
}, { url: [{ schemes: ['http', 'https'] }] });

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await restore();
  const state = tabs.get(details.tabId);
  if (!state || normalizeUrl(state.url) === normalizeUrl(details.url)) return;
  const tab = await getTab(details.tabId);
  await onNavigated(tab || { id: details.tabId, url: details.url, title: '',
                             incognito: false }, 'history');
}, { url: [{ schemes: ['http', 'https'] }] });

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await restore();
  if (changeInfo.status === 'complete' && changeInfo.url) {
    await onNavigated(tab, 'tab-updated');
    return;
  }
  const state = tabs.get(tabId);
  if (state) {
    if (changeInfo.title) state.title = changeInfo.title;
    if (changeInfo.url && normalizeUrl(changeInfo.url) !== state.normalized) {
      await onNavigated(tab, 'url-change');
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restore();
  const state = tabs.get(tabId);
  if (state) {
    // final flush for a page that was open long enough but never reported
    const settings = await getSettings();
    const dwell = Math.round(state.activeMs / 1000);
    if (!state.captured && dwell >= Number(settings.minDwellSeconds || 5) && state.verdict &&
        state.verdict.allowed !== false) {
      if (state.observing === false) await recordLinkOnly(state, 'tab closed');
    }
    tabs.delete(tabId);
    await snapshot();
    await updateBadge();
  }
});

chrome.tabs.onActivated.addListener(async () => { await tick(); });
chrome.windows.onFocusChanged.addListener(async () => { await tick(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK_ALARM) await tick();
  else if (alarm.name === HEARTBEAT_ALARM) await heartbeat();
  else if (alarm.name === FLUSH_ALARM) await api.flushQueue(30);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.settings || changes.domainModes) {
    clearCache();
    await updateBadge();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  buildMenus();
  await ensureAlarms();
  await restore();
  const settings = await getSettings(true);
  if (!settings.token && settings.autoPair) await api.pair();
  await updateBadge();
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  buildMenus();
  await ensureAlarms();
  await restore();
  await updateBadge();
  await heartbeat();
});

async function ensureAlarms() {
  const existing = await chrome.alarms.getAll();
  const names = new Set(existing.map((alarm) => alarm.name));
  if (!names.has(TICK_ALARM)) {
    chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  }
  if (!names.has(HEARTBEAT_ALARM)) {
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 });
  }
  if (!names.has(FLUSH_ALARM)) {
    chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 2 });
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function boot() {
  await restore();
  buildMenus();
  await ensureAlarms();
  const settings = await getSettings(true);
  if (!settings.token && settings.autoPair) await api.pair();
  await updateBadge();
  heartbeat();
})();
