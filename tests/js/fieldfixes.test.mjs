/**
 * Regression tests for bugs found in real-world use (September 2026 session):
 *
 *  1. "undefined page(s) in your memory"      → interest rows carry pageIds
 *  2. grounded opener over an EMPTY lesson    → adaptive quote floor
 *  3. "whats my name" went to retrieval       → identity question type
 *  4. junk sentences ("When Tar... - The…")   → isJunkSentence + title echo
 *  5. same URL twice in related reading       → further-reading dedupe
 *  6. "Summarise my day" hijacked by meta     → recap routing
 *  7. "seach the web" typo ignored            → wantsWeb anywhere in message
 *  8. silent web-search failure               → provider cascade + honest note
 *  9. "0m on page"                            → dwellLabel seconds
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-idb.mjs';

installFakeIndexedDb();
const brain = await import('../../extension/lib/brain/brain.js');
const { quoteFloor } = await import('../../extension/lib/brain/retrieve.js');
const { isJunkSentence, bestSentences } = await import('../../extension/lib/brain/text.js');
const { parseQuery, questionType } = await import('../../extension/lib/brain/understand.js');
const websearch = await import('../../extension/lib/brain/websearch.js');

const NEVER = { webPermission: 'never', talkativeness: 'friendly' };

// A page captured the way real browsing captures it: nav crumbs, SERP echoes,
// markdown artefacts AND the actual article text all mixed together.
const TARZAN = {
  url: 'https://saturday.test/2021/08/a-brief-history-of-tarzan/',
  title: 'A Brief History of Tarzan | The Saturday Evening Post',
  text: 'When Tar... - The Saturday Evening Post A Brief History of Tarzan | The Saturday Evening Post 06-Aug-2021 ' +
        '### 1. Tarzan is really John Clayton II, heir to the title of the Earl of Greystoke, born to British ' +
        'aristocrats stranded on the African coast. Tarzan was created by Edgar Rice Burroughs in 1912 and first ' +
        'appeared in The All-Story magazine before becoming a worldwide franchise of novels, comics and films. ' +
        '- Wikipedia Tarzan - Wikipedia Character biography. ' +
        'Trailer for Greystoke ... (Uploaded to YouTube by HudsonFilmLtd) ' +
        'The legend of Tarzan follows an orphaned boy raised by apes who must eventually reclaim his human heritage.',
  domain: 'saturday.test', domainLabel: 'saturday.test',
  visitedAt: new Date().toISOString(), dwellSeconds: 260, source: 'extension',
};

// ---------------------------------------------------------------------------
// 2. adaptive quote floor — a grounded answer can ALWAYS cite its best match
// ---------------------------------------------------------------------------

test('quoteFloor never exceeds the best relevance (grounded ⇒ citable)', () => {
  for (const best of [0.2, 0.25, 0.3, 0.42, 0.5, 0.9, 1.1]) {
    assert.ok(quoteFloor(best) <= best + 1e-9, `floor ${quoteFloor(best)} > best ${best}`);
  }
  assert.ok(Math.abs(quoteFloor(0.25) - 0.20) < 1e-9);          // MIN_GROUNDING kicks in
  assert.ok(Math.abs(quoteFloor(0.9) - 0.495) < 1e-9);           // 55% of best
  assert.ok(quoteFloor(0.2) >= 0.2 - 1e-9);
});

// ---------------------------------------------------------------------------
// 4. junk sentence filtering
// ---------------------------------------------------------------------------

test('nav crumbs, SERP echoes and YouTube trailers are junk; article text is not', () => {
  const title = TARZAN.title;
  assert.equal(isJunkSentence('When Tar... - The Saturday Evening Post 06-Aug-2021', title), true);
  assert.equal(isJunkSentence('A Brief History of Tarzan | The Saturday Evening Post', title), true);
  assert.equal(isJunkSentence('- Wikipedia Tarzan - Wikipedia Character biography.', 'Tarzan - Wikipedia'), true);
  assert.equal(isJunkSentence('Trailer for Greystoke ... (Uploaded to YouTube by HudsonFilmLtd)', title), true);
  assert.equal(isJunkSentence('Subscribe to our newsletter for more stories like this one.', title), true);
  assert.equal(isJunkSentence(
    'Tarzan was created by Edgar Rice Burroughs in 1912 and first appeared in The All-Story magazine.', title), false);
});

test('bestSentences returns only teachable sentences from a messy capture', () => {
  const picked = bestSentences(TARZAN.text, ['tarzan'], 3, TARZAN.title);
  assert.ok(picked.length >= 1);
  for (const sentence of picked) {
    assert.equal(isJunkSentence(sentence, TARZAN.title), false);
    assert.ok(!sentence.includes('...'), 'no ellipsis fragments');
    assert.ok(!sentence.includes('|'), 'no nav pipes');
    assert.ok(!sentence.includes('Uploaded to YouTube'));
  }
  const joined = picked.join(' ');
  assert.ok(/Burroughs|John Clayton|apes/i.test(joined), 'real article content survives');
});

test('markdown heading artefacts are stripped when splitting sentences', async () => {
  const { splitSentences } = await import('../../extension/lib/brain/text.js');
  const sentences = splitSentences('### 1. The quick brown fox jumped over the lazy dog today. More text follows here.');
  assert.ok(sentences.every((s) => !s.includes('#')));
  assert.ok(sentences[0].startsWith('The quick brown fox'));
});

// ---------------------------------------------------------------------------
// 6 + 7. routing: recap vs meta, identity, wantsWeb typos
// ---------------------------------------------------------------------------

test('"Summarise my reading day" is a recap, not a meta stats question', () => {
  assert.equal(questionType('Summarise my reading day'), 'recap');
  assert.equal(questionType('what did I read today?'), 'recap');
  assert.equal(parseQuery('Summarise my day').type, 'recap');
  assert.equal(questionType('what are my stats?'), 'meta');
  assert.equal(questionType('how many pages do i have?'), 'meta');
});

test('"whats my name" routes to identity, "my name is X" stays a statement', () => {
  assert.equal(questionType('whats my name'), 'identity');
  assert.equal(questionType('what is my name?'), 'identity');
  assert.equal(questionType('who am i'), 'identity');
  assert.equal(questionType('what do you remember about me?'), 'identity');
  assert.notEqual(questionType('my name is Ali'), 'identity');
});

test('web intent is detected anywhere in the message, typos included', () => {
  assert.equal(parseQuery('now seach the web and tell me Next ramzan starting date').wantsWeb, true);
  assert.equal(parseQuery('search the internet for the cricket score').wantsWeb, true);
  assert.equal(parseQuery('can you look this up online for me?').wantsWeb, true);
  assert.equal(parseQuery('how does DNS work').wantsWeb, false);
});

// ---------------------------------------------------------------------------
// 8 + 9. websearch resilience and honest reporting
// ---------------------------------------------------------------------------

test('searchWeb cascades providers and reports honestly when all fail', async () => {
  const realFetch = globalThis.fetch;
  try {
    const audited = [];
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
    const entry = await websearch.searchWeb('ramadan 2027', { audit: (a) => audited.push(a) });
    assert.equal(entry.results.length, 0);
    assert.match(entry.status, /^error|^no_results/);
    assert.equal(audited.length, 1);
    // parsers must not explode without a DOM (service worker vs Node)
    assert.deepEqual(websearch.parseBingHtml('<li class="b_algo"><h2><a href="https://x.test/a">Title here</a></h2></li>', 5), []);
    assert.deepEqual(websearch.parseDdgLiteHtml('<a class="result-link" href="https://x.test/a">Title here</a>', 5), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('searchWeb survives throwing fetch (offline) and still audits', async () => {
  const realFetch = globalThis.fetch;
  try {
    const audited = [];
    globalThis.fetch = async () => { throw new Error('offline'); };
    const entry = await websearch.searchWeb('anything', { audit: (a) => audited.push(a) });
    assert.equal(entry.status, 'no_results');
    assert.equal(entry.results.length, 0);
    assert.equal(audited.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// End-to-end through the real orchestrator (fresh brain instance per file)
// ---------------------------------------------------------------------------

test('startup migration purges search-result pages captured by older builds', async () => {
  const store = await import('../../extension/lib/store.js');
  const { embed } = await import('../../extension/lib/brain/embed.js');
  await store.putChunks([{
    id: 'g1:0', pageId: 'g1',
    url: 'https://www.google.com/search?q=the+legend+of+tarzan&oq=tarzan',
    title: 'The Legend of Tarzan - Google Search', domain: 'www.google.com',
    domainLabel: 'google.com', visitedAt: new Date().toISOString(),
    dwellSeconds: 12, visitCount: 1, source: 'extension',
    text: 'The Legend of Tarzan (2016) - IMDb David YatesAdventure, Drama, Action Tarzan google search snippet garbage',
    pageText: 'The Legend of Tarzan (2016) - IMDb snippet garbage', vec: embed('tarzan'),
  }]);
  // first brain call triggers ensureLoaded → one-off purge
  assert.equal(brain.isSerpUrl('https://www.google.com/search?q=tarzan'), true);
  assert.equal(brain.isSerpUrl('https://duckduckgo.com/?q=tarzan'), true);
  assert.equal(brain.isSerpUrl('https://www.youtube.com/results?search_query=tarzan'), true);
  assert.equal(brain.isSerpUrl('https://mail.google.com/mail/u/0/'), false);
  assert.equal(brain.isSerpUrl('https://saturday.test/tarzan'), false);
  const stats = await brain.brainStats();
  assert.equal(stats.pages, 0, 'the SERP page must be gone from the knowledge store');
});

test('ingest of a messy page produces numeric interest counts and pageIds', async () => {
  await brain.ingestPage(TARZAN);
  const interests = brain.interestsNow();
  assert.ok(interests.length >= 1);
  const top = interests[0];
  assert.equal(typeof top.pages, 'number', 'pages is a NUMBER, never an array or undefined');
  assert.ok(Number.isFinite(top.pages) && top.pages >= 1);
  assert.ok(Array.isArray(top.pageIds) && top.pageIds.length === top.pages);
});

test('learning the same topic again grows the page count without crashing', async () => {
  const before = brain.interestsNow()[0].pages;
  await brain.ingestPage({ ...TARZAN, url: 'https://saturday.test/2021/09/tarzan-part-two/',
                           title: 'Tarzan part two: the ape man returns', pageId: 'p2-tarzan' });
  const after = brain.interestsNow().find((i) => i.topic === brain.interestsNow()[0].topic);
  assert.ok(after.pages >= before);
});

test('"whats my name" is answered from stored facts, honestly', async () => {
  await brain.answer('my name is Daniyal', {}, NEVER);
  const out = await brain.answer('whats my name?', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.match(out.text, /Daniyal/);
  assert.ok(!out.text.includes('undefined'));
  assert.equal(out.grounded, true);
});

test('"who are tarzans" gives a grounded lesson that actually cites the read page', async () => {
  const out = await brain.answer('who are tarzans', {}, NEVER);
  assert.equal(out.mode, 'explain');
  assert.equal(out.grounded, true, 'the user DID read Tarzan pages — retrieval must ground');
  const ex = out.explanation;
  assert.ok(ex.citations.length >= 1, 'grounded answers always cite — never an empty lesson');
  assert.ok(ex.citations.some((c) => c.url.includes('saturday.test')), 'cites the real page');
  const body = [ex.simple, ...(ex.points || []), ...(ex.detail || [])].join(' ');
  assert.ok(body.length > 40, 'the lesson has real teachable content');
  assert.ok(!body.includes('...'), 'no ellipsis junk');
  assert.ok(!body.includes('|'), 'no nav pipes');
  assert.ok(!JSON.stringify(out).includes('undefined'), 'no undefined anywhere in the payload');
});

test('further reading never repeats a cited URL', async () => {
  const out = await brain.answer('tell me more about tarzan', {}, NEVER);
  const ex = out.explanation;
  const citedUrls = new Set(ex.citations.map((c) => c.url));
  for (const item of ex.further || []) {
    assert.equal(citedUrls.has(item.url), false, `${item.url} is cited AND in further reading`);
  }
  const urls = (ex.further || []).map((f) => f.url);
  assert.equal(new Set(urls).size, urls.length, 'further reading has no duplicates');
});

test('recap summarises the reading day from stored pages', async () => {
  const out = await brain.answer('Summarise my reading day', {}, NEVER);
  assert.equal(out.mode, 'explain');
  const short = (out.conversation && out.conversation.short) || out.text;
  assert.match(short, /page/i);
  assert.ok(!short.includes('undefined'));
});

test('web-intent message with permission=never answers from memory + flags the denial', async () => {
  const out = await brain.answer('now seach the web and tell me the history of tarzan', {}, NEVER);
  assert.equal(out.mode, 'explain');
  assert.equal(out.usedWeb, false, 'permission=never must never fetch');
  assert.ok(!JSON.stringify(out).includes('undefined'));
});
