/**
 * On-device web search. The service worker's host_permissions let it fetch
 * cross-origin without CORS, so the extension needs no backend and no API key.
 * DuckDuckGo's no-JS HTML endpoint is parsed with DOMParser; result URLs are
 * unwrapped from DDG's redirect. Everything is budgeted and audited locally.
 */

/** Search endpoints tried in order until one returns usable results.
 *  Any single endpoint can rate-limit or change markup — the fallbacks make
 *  "search the web" actually work in the field. */
const ENDPOINTS = [
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${q}`, parse: (html, limit) => parseDdgHtml(html, limit) },
  { name: 'duckduckgo-lite', url: (q) => `https://lite.duckduckgo.com/lite/?q=${q}`, parse: (html, limit) => parseDdgLiteHtml(html, limit) },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${q}&count=10`, parse: (html, limit) => parseBingHtml(html, limit) },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36 TwinBrain/1.0';

/** Pure parser — unit-testable with a fixture string. */
export function parseDdgHtml(html, limit = 8) {
  const results = [];
  if (!html) return results;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return results;
  }
  const anchors = doc.querySelectorAll('a.result__a, a[data-resultad], a[href*="uddg="]');
  const seen = new Set();
  for (const a of Array.from(anchors)) {
    if (results.length >= limit) break;
    const href = unwrap(a.getAttribute('href') || '');
    if (!href || !/^https?:\/\//.test(href)) continue;
    if (seen.has(href)) continue;
    if (/duckduckgo\.com|duck\.duckgo\.com/.test(href)) continue;
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue;
    let snippet = '';
    const block = a.closest('.result, .result__body, tr, div');
    if (block) {
      const snip = block.querySelector('.result__snippet, .result-snippet, td');
      if (snip) snippet = (snip.textContent || '').replace(/\s+/g, ' ').trim();
    }
    seen.add(href);
    results.push({ title, url: href, snippet: snippet.slice(0, 400) });
  }
  return results;
}

/** DuckDuckGo Lite parser (table layout). */
export function parseDdgLiteHtml(html, limit = 8) {
  const results = [];
  if (!html) return results;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return results;
  }
  const anchors = doc.querySelectorAll('a.result-link, a[href*="uddg="]');
  const seen = new Set();
  for (const a of Array.from(anchors)) {
    if (results.length >= limit) break;
    const href = unwrap(a.getAttribute('href') || '');
    if (!href || !/^https?:\/\//.test(href) || seen.has(href)) continue;
    if (/duckduckgo\.com/.test(href)) continue;
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue;
    let snippet = '';
    const row = a.closest('tr');
    const next = row && row.nextElementSibling;
    if (next) {
      const cell = next.querySelector('td.result-snippet') || next.querySelector('td');
      if (cell) snippet = (cell.textContent || '').replace(/\s+/g, ' ').trim();
    }
    seen.add(href);
    results.push({ title, url: href, snippet: snippet.slice(0, 400) });
  }
  return results;
}

/** Bing parser (b_algo blocks). */
export function parseBingHtml(html, limit = 8) {
  const results = [];
  if (!html) return results;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return results;
  }
  const blocks = doc.querySelectorAll('li.b_algo');
  const seen = new Set();
  for (const block of Array.from(blocks)) {
    if (results.length >= limit) break;
    const a = block.querySelector('h2 a') || block.querySelector('a');
    if (!a) continue;
    const href = unwrap(a.getAttribute('href') || '');
    if (!href || !/^https?:\/\//.test(href) || seen.has(href)) continue;
    if (/bing\.com|microsoft\.com/.test(href)) continue;
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue;
    const snip = block.querySelector('p, .b_caption p, .b_lineclamp2');
    const snippet = snip ? (snip.textContent || '').replace(/\s+/g, ' ').trim() : '';
    seen.add(href);
    results.push({ title, url: href, snippet: snippet.slice(0, 400) });
  }
  return results;
}

export function unwrap(href) {
  if (!href) return '';
  let url = href;
  if (url.startsWith('//')) url = `https:${url}`;
  const match = /[?&]uddg=([^&]+)/.exec(url);
  if (match) {
    try { return decodeURIComponent(match[1].replace(/\+/g, ' ')); } catch { /* keep */ }
  }
  return url;
}

/** Budgeted outbound search with provider fallback. One call = one budget unit. */
export async function searchWeb(query, { limit = 6, audit = null } = {}) {
  const started = Date.now();
  const entry = { query, provider: 'none', kind: 'answer',
                  created_at: new Date().toISOString(), status: 'no_results', results: [] };
  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint.url(encodeURIComponent(query)),
        { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
      if (!res.ok) { lastError = `${endpoint.name} http ${res.status}`; continue; }
      const html = await res.text();
      const results = endpoint.parse(html, limit);
      if (results.length) {
        entry.provider = endpoint.name;
        entry.results = results;
        entry.status = 'ok';
        break;
      }
      lastError = `${endpoint.name}: no parseable results`;
    } catch (error) {
      lastError = `${endpoint.name}: ${String(error.message || error).slice(0, 80)}`;
    }
  }
  if (entry.status !== 'ok') {
    entry.status = lastError && lastError.includes('http')
      ? `error: ${lastError.slice(0, 120)}` : 'no_results';
  }
  entry.took_ms = Date.now() - started;
  if (audit) { try { await audit(entry); } catch { /* never break the answer */ } }
  return entry;
}

/** Read a page the user (or the AI, with permission) pointed at, on-device. */
export async function fetchPageText(url, maxChars = 20000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('html') && !type.includes('text')) {
    throw new Error(`unsupported content type ${type}`);
  }
  const html = await res.text();
  return extractFromHtml(html, maxChars);
}

/** Dependency-free readability-lite: paragraphs + headings, noise stripped. */
export function extractFromHtml(html, maxChars = 20000) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  } catch {
    return { title: '', text: '' };
  }
  const title = (doc.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
  for (const selector of ['script', 'style', 'noscript', 'template', 'svg', 'form',
                          'nav', 'footer', 'header', 'aside', 'iframe']) {
    for (const node of Array.from(doc.querySelectorAll(selector))) node.remove();
  }
  const main = doc.querySelector('article') || doc.querySelector('main') || doc.body || doc;
  const pieces = [];
  for (const node of Array.from(main.querySelectorAll('p, li, blockquote, h2, h3, pre'))) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 60 || (text.length >= 20 && /^H[23]$/.test(node.tagName))) {
      pieces.push(text);
    }
    if (pieces.join(' ').length > maxChars) break;
  }
  let text = pieces.join('\n\n');
  if (text.length < 400) {
    text = (main.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  }
  return { title, text: text.slice(0, maxChars) };
}
