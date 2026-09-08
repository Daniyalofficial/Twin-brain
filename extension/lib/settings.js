/**
 * Settings + the exclusion engine.
 *
 * The single most important rule in the whole extension lives here: exclusions
 * are evaluated BEFORE anything is injected into a page. Excluded content never
 * reaches a content script, never reaches storage, and never reaches the
 * backend — not even transiently.
 */

import {
  DEFAULT_SETTINGS, DEFAULT_BLOCKLIST, SENSITIVE_URL_MARKERS, BLOCKED_SCHEMES
} from './defaults.js';

const SETTINGS_KEY = 'settings';
const MODES_KEY = 'domainModes';
const SEEN_KEY = 'seenDomains';

let cache = null;          // in-memory mirror so checks are effectively sync
let cacheAt = 0;
const CACHE_TTL = 4000;

// ---------------------------------------------------------------------------
// URL helpers (kept dependency-free: no <a> element in a service worker)
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'yclid',
  'twclid', 'ttclid', 'vero_id', 'mkt_tok', 'ref', 'ref_src', 'referrer', 'source',
  'pk_campaign', 'pk_kwd', 'spm', 'scm', 'share_token', 'si', 'feature', 'ncid'
]);

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'com.au', 'net.au',
  'org.au', 'gov.au', 'edu.au', 'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'co.za', 'org.za', 'web.za', 'com.br',
  'net.br', 'org.br', 'gov.br', 'com.mx', 'org.mx', 'gob.mx', 'co.jp', 'ne.jp',
  'or.jp', 'ac.jp', 'go.jp', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.tr',
  'org.tr', 'com.sg', 'net.sg', 'org.sg', 'com.hk', 'org.hk', 'co.kr', 'or.kr',
  'com.ar', 'gob.ar', 'com.pk', 'net.pk', 'org.pk', 'com.ua', 'org.ua', 'com.pl',
  'net.pl', 'org.pl', 'com.ru', 'net.ru', 'org.ru', 'com.sa', 'org.sa', 'gov.sa',
  'com.eg', 'gov.eg', 'co.id', 'web.id', 'or.id', 'go.id', 'com.ph', 'org.ph',
  'gov.ph', 'com.ng', 'org.ng', 'gov.ng', 'com.bd', 'org.bd', 'net.bd'
]);

export function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function domainOf(url) {
  const u = typeof url === 'string' ? parseUrl(url) : url;
  return u ? (u.hostname || '').toLowerCase().replace(/^\.+/, '') : '';
}

export function registrableDomain(host) {
  const h = (host || '').toLowerCase().replace(/^\.+/, '');
  if (!h || /^[\d.]+$/.test(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  if (MULTI_PART_SUFFIXES.has(labels.slice(-2).join('.'))) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

export function normalizeUrl(url) {
  const u = parseUrl(url);
  if (!u) return url || '';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;
  const keep = [];
  u.searchParams.forEach((value, key) => {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k) || k.startsWith('utm_')) return;
    keep.push([key, value]);
  });
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const clean = new URL(u.href);
  clean.search = '';
  clean.hash = '';
  if (keep.length) keep.forEach(([k, v]) => clean.searchParams.append(k, v));
  let path = clean.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  clean.pathname = path || '/';
  return clean.href;
}

// ---------------------------------------------------------------------------
// settings storage
// ---------------------------------------------------------------------------

export async function getSettings(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL) return cache;
  const stored = await chrome.storage.local.get([SETTINGS_KEY, MODES_KEY]);
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {});
  settings.domainModes = Object.assign({}, stored[MODES_KEY] || {});
  // the default blocklist is folded into the effective modes, but a user's
  // explicit choice always wins over the shipped default
  if (settings.respectDefaultBlocklist) {
    for (const domain of Object.keys(DEFAULT_BLOCKLIST)) {
      if (!(domain in settings.domainModes)) settings.domainModes[domain] = 'off';
    }
  }
  cache = settings;
  cacheAt = now;
  return settings;
}

export async function saveSettings(patch) {
  const current = await getSettings(true);
  const next = Object.assign({}, current);
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'domainModes') continue;
    next[key] = value;
  }
  delete next.domainModes;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  cache = null;
  return getSettings(true);
}

export async function getDomainModes() {
  const settings = await getSettings();
  return Object.assign({}, settings.domainModes);
}

export async function setDomainMode(domain, mode) {
  const d = (domain || '').toLowerCase().replace(/^\.+/, '');
  if (!d) return null;
  const stored = await chrome.storage.local.get(MODES_KEY);
  const modes = Object.assign({}, stored[MODES_KEY] || {});
  if (!mode || mode === 'full') delete modes[d];
  else modes[d] = mode;
  await chrome.storage.local.set({ [MODES_KEY]: modes });
  cache = null;
  await noteSeenDomain(d, mode);
  return getSettings(true);
}

/**
 * Domains the extension has merely *seen* (name + mode, never a URL or content).
 * This is what makes the Settings list complete: you can re-enable a domain you
 * blocked weeks ago even though nothing about it was ever captured.
 */
export async function noteSeenDomain(domain, mode) {
  const settings = await getSettings();
  if (!settings.rememberDomainNames) return;
  const reg = registrableDomain(domain);
  const stored = await chrome.storage.local.get(SEEN_KEY);
  const seen = Object.assign({}, stored[SEEN_KEY] || {});
  const entry = seen[reg] || { first: Date.now(), visits: 0 };
  entry.visits += 1;
  entry.last = Date.now();
  entry.mode = mode || 'full';
  seen[reg] = entry;
  // bound the list so it can never grow without limit
  const keys = Object.keys(seen);
  if (keys.length > 5000) {
    keys.sort((a, b) => (seen[a].last || 0) - (seen[b].last || 0))
      .slice(0, keys.length - 5000)
      .forEach((k) => delete seen[k]);
  }
  await chrome.storage.local.set({ [SEEN_KEY]: seen });
}

export async function getSeenDomains() {
  const stored = await chrome.storage.local.get(SEEN_KEY);
  return stored[SEEN_KEY] || {};
}

// ---------------------------------------------------------------------------
// the exclusion engine
// ---------------------------------------------------------------------------

/**
 * Decide what may happen with a URL.
 *
 * @returns {{allowed:boolean, mode:string, reason:string, domain:string,
 *            registrable:string, content:boolean}}
 */
export function classifyUrl(url, settings) {
  const result = { allowed: false, mode: 'off', reason: '', domain: '',
                   registrable: '', content: false };
  if (!url) return Object.assign(result, { reason: 'empty url' });

  const u = parseUrl(url);
  if (!u) return Object.assign(result, { reason: 'unparseable url' });

  const scheme = (u.protocol || '').toLowerCase();
  if (BLOCKED_SCHEMES.includes(scheme)) {
    return Object.assign(result, { reason: `blocked scheme ${scheme}` });
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    return Object.assign(result, { reason: 'not a web page' });
  }

  const host = domainOf(u);
  const reg = registrableDomain(host);
  result.domain = host;
  result.registrable = reg;
  if (!host) return Object.assign(result, { reason: 'no host' });

  // local/internal pages carry no knowledge worth keeping
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
      host === '::1' || host.endsWith('.local')) {
    return Object.assign(result, { reason: 'local address' });
  }

  if (settings.globalPause) {
    return Object.assign(result, { reason: 'capture is paused' });
  }
  if (!settings.captureEnabled) {
    return Object.assign(result, { reason: 'capture is off' });
  }

  // exact host, then every parent domain — so blocking "example.com" also
  // covers "news.example.com"
  const modes = settings.domainModes || {};
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i += 1) {
    const candidate = labels.slice(i).join('.');
    if (modes[candidate] === 'off') {
      return Object.assign(result, { mode: 'off', reason: `blocked domain ${candidate}` });
    }
    if (modes[candidate] === 'no_ai') {
      return Object.assign(result, { allowed: true, mode: 'no_ai', content: false,
                                     reason: 'hidden from AI (link only)' });
    }
  }

  const lowered = url.toLowerCase();
  if (settings.skipSensitiveUrls !== false) {
    for (const marker of SENSITIVE_URL_MARKERS) {
      if (lowered.includes(marker)) {
        return Object.assign(result, { reason: `sensitive url pattern ${marker}` });
      }
    }
  }

  // Search-result pages are what you SEARCHED, not what you LEARNED: keep the
  // link ("you searched tarzan history"), but their scraped snippets must never
  // enter the AI's knowledge or pollute answers.
  if (isSearchResultsPage(u, lowered)) {
    return Object.assign(result, { allowed: true, mode: 'no_ai', content: false,
                                   reason: 'search results page (link only)' });
  }

  return Object.assign(result, { allowed: true, mode: 'full', content: true,
                                 reason: 'ok' });
}

const SEARCH_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|startpage|search\.brave|qwant)\.[a-z.]{2,}$/;

export function isSearchResultsPage(u, lowered) {
  const host = (u && u.hostname) || '';
  if (/youtube\.com$/.test(host) && lowered.includes('/results')) return true;
  if (!SEARCH_HOSTS.test(host)) return false;
  const path = (u && u.pathname) || '';
  // google.com/search?q=…, bing.com/search?q=…, duckduckgo.com/?q=…
  return /[?&](q|query|text|search_query|wd)=/.test(lowered) ||
         path === '/search' || path.startsWith('/search/');
}

/** Convenience wrapper used by the background worker before any injection. */
export async function mayCapture(url) {
  const settings = await getSettings();
  return classifyUrl(url, settings);
}

export function forgetListKey(url) {
  return `forget:${normalizeUrl(url)}`;
}

// ---------------------------------------------------------------------------
// local "forgotten" list — durable, and enforced before the backend is reached
// ---------------------------------------------------------------------------

const FORGOTTEN_KEY = 'forgotten';

export async function getForgotten() {
  const stored = await chrome.storage.local.get(FORGOTTEN_KEY);
  return stored[FORGOTTEN_KEY] || { urls: {}, domains: {} };
}

export async function forgetUrl(url, reason = 'user request') {
  const stored = await chrome.storage.local.get(FORGOTTEN_KEY);
  const forgotten = Object.assign({ urls: {}, domains: {} }, stored[FORGOTTEN_KEY] || {});
  forgotten.urls[normalizeUrl(url)] = { at: Date.now(), reason };
  await chrome.storage.local.set({ [FORGOTTEN_KEY]: forgotten });
  return forgotten;
}

export async function forgetDomain(domain, reason = 'user request') {
  const stored = await chrome.storage.local.get(FORGOTTEN_KEY);
  const forgotten = Object.assign({ urls: {}, domains: {} }, stored[FORGOTTEN_KEY] || {});
  forgotten.domains[registrableDomain(domain)] = { at: Date.now(), reason };
  await chrome.storage.local.set({ [FORGOTTEN_KEY]: forgotten });
  await setDomainMode(registrableDomain(domain), 'off');
  return forgotten;
}

export async function isForgotten(url) {
  const forgotten = await getForgotten();
  if (forgotten.urls[normalizeUrl(url)]) return true;
  const reg = registrableDomain(domainOf(url));
  return Boolean(reg && forgotten.domains[reg]);
}

export function clearCache() {
  cache = null;
  cacheAt = 0;
}

// Keep the cache honest when settings change in another context (options page).
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[SETTINGS_KEY] || changes[MODES_KEY] ||
                             changes[FORGOTTEN_KEY])) {
      clearCache();
    }
  });
}
