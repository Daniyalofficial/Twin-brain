/**
 * On-device web search. The service worker's host_permissions let it fetch
 * cross-origin without CORS, so the extension needs no backend and no API key.
 * DuckDuckGo's no-JS HTML endpoint is parsed with DOMParser; result URLs are
 * unwrapped from DDG's redirect. Everything is budgeted and audited locally.
 */

const ENDPOINT = 'https://html.duckduckgo.com/html/?q=';
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

/** Budgeted outbound search. `audit` is a callback the caller persists. */
export async function searchWeb(query, { limit = 6, audit = null } = {}) {
  const started = Date.now();
  const entry = { query, provider: 'duckduckgo', kind: 'answer',
                  created_at: new Date().toISOString(), status: 'ok', results: [] };
  try {
    const res = await fetch(ENDPOINT + encodeURIComponent(query),
      { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const html = await res.text();
    entry.results = parseDdgHtml(html, limit);
    if (!entry.results.length) entry.status = 'no_results';
  } catch (error) {
    entry.status = `error: ${String(error.message || error).slice(0, 120)}`;
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
