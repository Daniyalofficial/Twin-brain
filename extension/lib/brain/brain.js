/**
 * The on-device brain: your second brain lives in the extension now.
 *
 *  - capture -> chunk -> embed -> IndexedDB, all inside the browser
 *  - answers come from hybrid retrieval over YOUR pages, explained like a
 *    teacher, with citations and further reading
 *  - the web is consulted ONLY with permission (ask / always / never), is
 *    budgeted per day, and every outbound query is audited locally
 *  - interests, digests and notifications are computed on-device, so the whole
 *    thing keeps working with no backend and no internet
 */

import * as store from '../store.js';
import { embed, embedQuery } from './embed.js';
import { LexicalIndex } from './lexical.js';
import { retrieve, relatedPages } from './retrieve.js';
import { explain, advice, smalltalk } from './explain.js';
import { searchWeb, fetchPageText } from './websearch.js';
import {
  contentWords, queryTerms, splitSentences, stem, humanTime, fmtDuration, truncate,
} from './text.js';

const state = {
  chunks: [],
  pages: new Map(),          // pageId -> page meta
  index: new LexicalIndex(),
  interests: [],
  loaded: false,
  loading: null,
};

// ---------------------------------------------------------------------------
// loading + ingestion
// ---------------------------------------------------------------------------

export async function ensureLoaded() {
  if (state.loaded) return state;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    const chunks = await store.getAllChunks();
    state.chunks = chunks;
    state.index.clear();
    for (const chunk of chunks) {
      state.index.add(chunk.id, chunk.title, chunk.text);
      if (!state.pages.has(chunk.pageId)) {
        state.pages.set(chunk.pageId, chunk);
      }
    }
    state.interests = await store.getInterests();
    state.loaded = true;
    return state;
  })();
  return state.loading;
}

/** Sentence-aware chunking, same shape as server/text.py chunk_text. */
export function chunkText(text, target = 900, overlap = 120) {
  const sentences = splitSentences(text);
  if (!sentences.length) return text ? [text.slice(0, target)] : [];
  const chunks = [];
  let current = [];
  let length = 0;
  for (const sentence of sentences) {
    current.push(sentence);
    length += sentence.length;
    if (length >= target) {
      chunks.push(current.join(' '));
      const tail = [];
      let tailLen = 0;
      for (let i = current.length - 1; i >= 0 && tailLen < overlap; i -= 1) {
        tail.unshift(current[i]);
        tailLen += current[i].length;
      }
      current = tail;
      length = tailLen;
    }
  }
  if (current.join(' ').trim().length > 60) chunks.push(current.join(' '));
  return chunks.slice(0, 60);
}

/**
 * Store a page in the on-device brain. `page`:
 * {url, title, text, domain, domainLabel, visitedAt, dwellSeconds, visitCount,
 *  source ('extension'|'web_enrichment')}
 */
export async function ingestPage(page) {
  await ensureLoaded();
  const pageId = page.pageId || hashId(page.url);
  await store.deleteChunksByPage(pageId);
  for (let i = state.chunks.length - 1; i >= 0; i -= 1) {
    if (state.chunks[i].pageId === pageId) state.chunks.splice(i, 1);
  }

  const texts = chunkText(page.text || '');
  const records = texts.map((text, i) => ({
    id: `${pageId}:${i}`,
    pageId,
    url: page.url,
    title: page.title || page.url,
    domain: page.domain || '',
    domainLabel: page.domainLabel || page.domain || '',
    visitedAt: page.visitedAt || new Date().toISOString(),
    dwellSeconds: page.dwellSeconds || 0,
    visitCount: page.visitCount || 1,
    source: page.source || 'extension',
    text,
    pageText: page.text || '',
    vec: embed(`${page.title || ''}\n${text}`),
  }));
  if (records.length) {
    await store.putChunks(records);
    for (const record of records) {
      state.chunks.push(record);
      state.index.add(record.id, record.title, record.text);
    }
  }
  state.pages.set(pageId, Object.assign({ pageId }, page));
  await learnInterests(page);
  return { pageId, chunks: records.length };
}

export async function forgetPage(pageIdOrUrl) {
  await ensureLoaded();
  const pageId = state.pages.has(pageIdOrUrl)
    ? pageIdOrUrl
    : [...state.pages.values()].find((p) => p.url === pageIdOrUrl)?.pageId;
  if (!pageId) return false;
  await store.deleteChunksByPage(pageId);
  state.chunks = state.chunks.filter((c) => c.pageId !== pageId);
  state.index.clear();
  for (const chunk of state.chunks) state.index.add(chunk.id, chunk.title, chunk.text);
  state.pages.delete(pageId);
  return true;
}

// ---------------------------------------------------------------------------
// interests — the brain teaching itself from YOUR browsing only
// ---------------------------------------------------------------------------

const GENERIC = new Set(['page', 'http', 'https', 'com', 'www', 'html', 'web',
  'site', 'article', 'blog', 'post', 'video', 'watch', 'free', 'online']);

export async function learnInterests(page) {
  await ensureLoaded();
  const byTopic = new Map(state.interests.map((row) => [row.topic, row]));
  const weights = new Map();
  const titleWords = contentWords(page.title || '');
  const bodyWords = contentWords((page.text || '').slice(0, 3000));
  const dwellBoost = 1 + Math.min(3, (page.dwellSeconds || 0) / 300);
  for (const word of titleWords) weights.set(word, (weights.get(word) || 0) + 2.2 * dwellBoost);
  const counts = new Map();
  for (const word of bodyWords) counts.set(word, (counts.get(word) || 0) + 1);
  for (const [word, count] of counts) {
    if (GENERIC.has(word) || count < 2) continue;
    weights.set(word, (weights.get(word) || 0) + Math.log1p(count) * dwellBoost);
  }
  const pageId = page.pageId || hashId(page.url);
  for (const [topic, weight] of weights) {
    if (weight < 2.5) continue;
    const row = byTopic.get(topic) || { topic, weight: 0, pages: [], lastAgo: '' };
    row.weight = Math.round((row.weight + weight) * 100) / 100;
    if (!row.pages.includes(pageId)) row.pages.push(pageId);
    row.lastAgo = humanTime(page.visitedAt || Date.now());
    byTopic.set(topic, row);
  }
  state.interests = [...byTopic.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 60)
    .map((row) => ({ topic: row.topic, weight: row.weight,
                     pages: row.pages.length, lastAgo: row.lastAgo }));
  await store.putInterests(state.interests);
  return state.interests;
}

// ---------------------------------------------------------------------------
// answering
// ---------------------------------------------------------------------------

const CONTINUATION = /^(tell me more|more|go on|continue|explain more|and then|why\??)$/i;
const ADVICE = /\b(should i|what should|advice|recommend|best way|how do i choose|worth it)\b/i;
const SMALLTALK = /^(hi|hey|hello|yo|sup|how are you|good (morning|evening|afternoon)|thanks|thank you|who are you|what are you)\b/i;
const META = /\b(my day|today|this week|how much have i read|my stats|summar[i]se my|reading time|how many pages)\b/i;
const WANTS_WEB = /^(web|search the web|google)[:! ]/i;

export function classify(query) {
  const q = (query || '').trim();
  if (SMALLTALK.test(q)) return 'smalltalk';
  if (META.test(q)) return 'meta';
  if (ADVICE.test(q)) return 'advice';
  if (WANTS_WEB.test(q)) return 'web';
  return 'knowledge';
}

export async function answer(query, options = {}, settings = {}) {
  await ensureLoaded();
  const permission = settings.webPermission || 'ask';
  let effective = (query || '').trim();

  // follow-ups: "tell me more" continues the last question
  if (CONTINUATION.test(effective)) {
    const history = await store.recentConversations(2);
    if (history.length) effective = `${history[history.length - 1].query} ${effective}`;
  }

  const intent = classify(effective);
  const stats = await brainStats();

  if (intent === 'smalltalk') {
    const text = smalltalk(effective, stats, state.interests);
    await store.putConversation({ query: effective, mode: 'smalltalk', answer: text });
    return { mode: 'chat', text, grounded: true, citations: [], followups: [] };
  }

  if (intent === 'meta') {
    const text = metaAnswer(stats);
    await store.putConversation({ query: effective, mode: 'meta', answer: text });
    return { mode: 'chat', text, grounded: true, citations: [], followups: [] };
  }

  const result = retrieve(state.chunks, state.index, effective,
    { topK: options.topK || 8 });

  let webResults = [];
  let usedWeb = false;
  let webDenied = Boolean(options.denied);
  let needsPermission = false;

  const explicitWeb = intent === 'web' || options.useWeb === true;
  if (!result.grounded || explicitWeb) {
    if (permission === 'never' || webDenied) {
      webDenied = true;
    } else if (permission === 'always' || explicitWeb || options.useWeb === true) {
      const web = await runWebSearch(effective, settings);
      webResults = web.results || [];
      usedWeb = webResults.length > 0;
      if (usedWeb && settings.webDeepRead !== false) {
        await deepReadTopResult(webResults[0], effective);
      }
    } else {
      needsPermission = true;
    }
  }

  // after a permitted deep read, retrieve again so the lesson uses full pages
  const finalResult = usedWeb && settings.webDeepRead !== false
    ? retrieve(state.chunks, state.index, effective, { topK: options.topK || 8 })
    : result;

  if (needsPermission) {
    const partial = explain({
      query: effective, result: finalResult, webResults: [], usedWeb: false,
      webDenied: false, related: [], interests: state.interests,
      talkative: settings.talkativeness !== 'quiet',
    });
    return { mode: 'needs_permission', question: effective, explanation: partial,
             grounded: false, citations: [] };
  }

  const related = finalResult.matches[0]
    ? relatedPages(state.chunks, queryTerms(effective), finalResult.matches[0].pageId, 3)
        .map((item) => ({ title: item.title, url: item.url,
                          why: `you read this ${item.visitedAgo}` }))
    : [];

  const explanation = explain({
    query: effective, result: finalResult, webResults, usedWeb, webDenied,
    related, interests: state.interests,
    talkative: settings.talkativeness !== 'quiet',
  });

  let text = null;
  if (intent === 'advice') {
    text = advice(effective, state.interests, finalResult.matches);
  }

  await store.putConversation({
    query: effective, mode: intent, grounded: explanation.grounded,
    answer: explanation.simple || text || '',
  });

  return {
    mode: intent === 'advice' ? 'advice' : 'explain',
    adviceText: text,
    explanation,
    grounded: explanation.grounded,
    citations: explanation.citations,
    usedWeb,
    webDenied,
    retrieval: {
      count: finalResult.matches.length, tookMs: finalResult.tookMs,
      bestRelevance: finalResult.bestRelevance, evidence: finalResult.evidence,
      engine: 'on-device hybrid (hash-v1 + BM25)',
    },
  };
}

async function runWebSearch(query, settings) {
  const budget = await webBudget(settings);
  if (budget.remaining <= 0) return { results: [], status: 'budget' };
  const extra = state.interests
    .map((i) => i.topic)
    .filter((topic) => topic && !query.toLowerCase().includes(topic))
    .slice(0, 3);
  const built = `${query.replace(WANTS_WEB, '')} ${extra.join(' ')}`.trim().slice(0, 140);
  const entry = await searchWeb(built, { audit: (audit) => store.addAudit(audit) });
  await bumpWebBudget();
  return entry;
}

async function deepReadTopResult(result, topic) {
  if (!result || !result.url) return null;
  try {
    const { title, text } = await fetchPageText(result.url, 16000);
    if (!text || text.length < 300) return null;
    const url = new URL(result.url);
    await ingestPage({
      url: result.url,
      title: title || result.title,
      text,
      domain: url.hostname,
      domainLabel: url.hostname.replace(/^www\./, ''),
      visitedAt: new Date().toISOString(),
      dwellSeconds: 0,
      source: 'web_enrichment',
    });
    await store.addAudit({ kind: 'deep_read', query: topic, provider: result.url,
                           status: 'stored' });
    return true;
  } catch (error) {
    await store.addAudit({ kind: 'deep_read', query: topic, provider: result.url,
                           status: `error: ${String(error.message).slice(0, 100)}` });
    return null;
  }
}

// ---------------------------------------------------------------------------
// budgets, stats, digests, self-learning
// ---------------------------------------------------------------------------

function today() { return new Date().toISOString().slice(0, 10); }

export async function webBudget(settings) {
  const cap = Number(settings.webSearchDailyBudget || 40);
  const saved = (await store.getMeta('webBudget')) || { day: today(), used: 0 };
  if (saved.day !== today()) return { day: today(), used: 0, budget: cap, remaining: cap };
  return { day: saved.day, used: saved.used, budget: cap,
           remaining: Math.max(0, cap - saved.used) };
}

async function bumpWebBudget() {
  const saved = (await store.getMeta('webBudget')) || { day: today(), used: 0 };
  const used = saved.day === today() ? saved.used + 1 : 1;
  await store.setMeta('webBudget', { day: today(), used });
}

export async function brainStats() {
  await ensureLoaded();
  const pages = [...state.pages.values()];
  const dwell = pages.reduce((sum, p) => sum + (p.dwellSeconds || 0), 0);
  return {
    pages: pages.length,
    chunks: state.chunks.length,
    visits: pages.reduce((sum, p) => sum + (p.visitCount || 1), 0),
    words: pages.reduce((sum, p) => sum + ((p.text || '').split(/\s+/).length), 0),
    dwellSeconds: dwell,
    interests: state.interests.length,
    engine: 'on-device',
  };
}

function metaAnswer(stats) {
  const lines = [
    `Here's your second brain, live from this browser:`,
    `• ${stats.pages} page(s) remembered, ${stats.visits} visit(s), ${fmtDuration(stats.dwellSeconds)} of reading.`,
    `• ${stats.chunks} memory slices indexed on-device — no server involved.`,
  ];
  if (state.interests.length) {
    lines.push(`• Your strongest interests right now: ${state.interests.slice(0, 5).map((i) => i.topic).join(', ')}.`);
  }
  lines.push('• Ask me about any of it, or say “summarise my day”.');
  return lines.join('\n');
}

export async function buildDigest(settings = {}, { notify = true } = {}) {
  await ensureLoaded();
  const day = today();
  const pages = [...state.pages.values()]
    .filter((p) => (p.visitedAt || '').slice(0, 10) === day);
  if (!pages.length) return null;
  const dwell = pages.reduce((sum, p) => sum + (p.dwellSeconds || 0), 0);
  const domains = new Map();
  for (const page of pages) {
    const key = page.domainLabel || page.domain || 'unknown';
    domains.set(key, (domains.get(key) || 0) + 1);
  }
  const topDomains = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topics = state.interests.slice(0, 5).map((i) => i.topic);
  const deep = pages.filter((p) => (p.dwellSeconds || 0) >= 120)
    .sort((a, b) => b.dwellSeconds - a.dwellSeconds).slice(0, 3);
  const text = [
    `Your reading day: ${pages.length} page(s), ${fmtDuration(dwell)} on the page.`,
    topDomains.length ? `Most time on: ${topDomains.map(([d, n]) => `${d} (${n})`).join(', ')}.` : '',
    topics.length ? `Themes building up: ${topics.join(', ')}.` : '',
    deep.length ? `Deep reads: ${deep.map((p) => `“${truncate(p.title, 60)}” (${fmtDuration(p.dwellSeconds)})`).join('; ')}.` : '',
  ].filter(Boolean).join(' ');

  if (notify) await maybeNotify(settings, {
    title: 'Twin-Brain daily recap',
    message: text,
  });
  return text;
}

export async function maybeNotify(settings, { title, message }) {
  const cap = Number(settings.notificationDailyBudget || 5);
  const saved = (await store.getMeta('noteBudget')) || { day: today(), used: 0 };
  const used = saved.day === today() ? saved.used : 0;
  if (used >= cap) return false;
  if (settings.notificationsEnabled === false) return false;
  try {
    chrome.notifications.create(`tb-${Date.now()}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title, message,
    });
  } catch { /* notifications unavailable */ }
  await store.setMeta('noteBudget', { day: today(), used: used + 1 });
  return true;
}

/** Daily self-training: refresh interests, recap the day, and (only when the
 *  user chose "always allow web") enrich the top topic with fresh reading. */
export async function selfLearn(settings = {}) {
  await ensureLoaded();
  const pages = [...state.pages.values()];
  for (const page of pages.slice(0, 200)) await learnInterests(page);
  await buildDigest(settings);
  if ((settings.webPermission || 'ask') === 'always' && settings.autoEnrich !== false) {
    const budget = (await store.getMeta('enrichBudget')) || { day: today(), used: 0 };
    const cap = Number(settings.enrichmentDailyBudget || 5);
    const used = budget.day === today() ? budget.used : 0;
    const topic = state.interests[0];
    if (topic && used < cap) {
      const web = await runWebSearch(`latest updates about ${topic.topic}`, settings);
      if (web.results && web.results[0]) await deepReadTopResult(web.results[0], topic.topic);
      await store.setMeta('enrichBudget', { day: today(), used: used + 1 });
    }
  }
  return { interests: state.interests.length, pages: pages.length };
}

export async function auditList() {
  return store.recentAudit(80);
}

export function interestsNow() { return state.interests; }

export function pagesNow() { return [...state.pages.values()]; }

export function hashId(url) {
  let h1 = 0x811c9dc5;
  const s = String(url || '');
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `p${h1.toString(16)}${s.length.toString(16)}`;
}

// re-exported for the popup/background convenience
export { embedQuery };
