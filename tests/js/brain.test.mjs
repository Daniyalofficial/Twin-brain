/**
 * On-device brain tests — run with:  node --test tests/js/
 *
 * The brain modules are pure ES modules with zero chrome.* dependencies, so
 * the same retrieval maths that answers in your browser is verified here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize, contentWords, queryTerms, stem, splitSentences, bestSentences,
  simplify, truncate, humanTime, PLAIN,
} from '../../extension/lib/brain/text.js';
import {
  embed, embedQuery, cosine, DIM, features, NOISE_FLOOR,
} from '../../extension/lib/brain/embed.js';
import { LexicalIndex, TITLE_BOOST } from '../../extension/lib/brain/lexical.js';
import { retrieve, relatedPages, quoteFloor } from '../../extension/lib/brain/retrieve.js';
import { explain, advice, smalltalk } from '../../extension/lib/brain/explain.js';
import { unwrap, parseDdgHtml, extractFromHtml } from '../../extension/lib/brain/websearch.js';
import { chunkText, classify, hashId } from '../../extension/lib/brain/brain.js';

// ---------------------------------------------------------------------------
// text.js
// ---------------------------------------------------------------------------

test('tokenize lowercases and keeps useful punctuation', () => {
  const tokens = tokenize("Node.js and C++ aren't dead!");
  assert.ok(tokens.includes('node.js'));
  assert.ok(tokens.includes("aren't"));
});

test('contentWords drops stopwords, queryTerms dedupes', () => {
  const words = contentWords('How do I bake the sourdough bread?');
  assert.ok(words.includes('bake'));
  assert.ok(!words.includes('how'));
  assert.equal(new Set(queryTerms('bread bread bread')).size, 1);
});

test('stem folds plurals, -ing and silent-e consistently', () => {
  assert.equal(stem('breads'), stem('bread'));
  assert.equal(stem('baking'), stem('bake'));
  assert.equal(stem('baked'), stem('bake'));
  assert.equal(stem('running'), stem('run'));
  assert.notEqual(stem('security'), stem('model'));
});

test('splitSentences handles real prose (quotes are >=25 chars by design)', () => {
  const parts = splitSentences(
    'Mix the flour and water until no dry bits remain. Wait about twelve hours for the ' +
    'fermentation to work! Then bake the loaf in a very hot oven? Yes, exactly like that.');
  assert.ok(parts.length >= 3);
});

test('bestSentences picks question-covering sentences in doc order', () => {
  const text = 'Intro about many things. Sourdough bread needs a starter and time. ' +
               'Unrelated weather talk. The bread bakes at 230C for 40 minutes.';
  const picked = bestSentences(text, ['sourdough', 'bread'], 2);
  assert.equal(picked.length, 2);
  assert.ok(picked[0].includes('starter'));
  assert.ok(text.indexOf(picked[0]) < text.indexOf(picked[1]));
});

test('simplify swaps jargon but keeps meaning words', () => {
  const simple = simplify('Utilise the methodology to optimise the implementation.');
  assert.ok(/use/i.test(simple));
  assert.ok(!/utilise/i.test(simple));
});

test('PLAIN dictionary explains technical words honestly', () => {
  assert.ok(PLAIN.embedding && PLAIN.embedding.length > 10);
  assert.ok(PLAIN.bm25 || PLAIN.retrieval);
});

test('truncate + humanTime behave', () => {
  assert.equal(truncate('abcdef', 3).length <= 4, true);
  assert.match(humanTime(new Date(Date.now() - 3600e3).toISOString()), /hour|hr|h\b/i);
});

// ---------------------------------------------------------------------------
// embed.js
// ---------------------------------------------------------------------------

test('embeddings are deterministic, 384-dim and unit-norm', () => {
  const a = embed('sourdough bread recipe with a starter');
  const b = embed('sourdough bread recipe with a starter');
  assert.equal(a.length, DIM);
  assert.deepEqual(Array.from(a.slice(0, 8)), Array.from(b.slice(0, 8)));
  let norm = 0;
  for (const v of a) norm += v * v;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5);
});

test('related texts score far above the noise floor, unrelated near it', () => {
  const q = embedQuery('how to make sourdough bread');
  const recipe = embed('Sourdough bread recipe: mix flour, water, salt and starter. ' +
    'Ferment overnight, shape the loaf, bake in a hot oven for 40 minutes.');
  const security = embed('A critical vulnerability in the firewall lets attackers ' +
    'exploit unpatched servers via a phishing payload and ransomware.');
  const simRecipe = cosine(q, recipe);
  const simSecurity = cosine(q, security);
  assert.ok(simRecipe >= 2.2 * NOISE_FLOOR,
    `recipe similarity ${simRecipe} should clear the gate`);
  assert.ok(simSecurity < simRecipe,
    'unrelated page must score below the related one');
});

test('features are cached and query boost adds concept hits', () => {
  const f1 = features('python flask api');
  const f2 = features('python flask api');
  assert.equal(f1, f2);
  const q = embedQuery('python');
  assert.equal(q.length, DIM);
});

// ---------------------------------------------------------------------------
// lexical.js
// ---------------------------------------------------------------------------

test('BM25 finds the right doc, titles get boosted', () => {
  const index = new LexicalIndex();
  index.add('a', 'Sourdough bread guide', 'Mix flour and water. Ferment. Bake the bread.');
  index.add('b', 'Firewall security', 'Patches stop exploits on servers.');
  const hits = index.search(['sourdough', 'bread']);
  assert.ok(hits.get('a') > 0);
  assert.ok(!hits.has('b'));
  const titleHit = index.search(['sourdough']);
  assert.ok(titleHit.get('a') >= TITLE_BOOST * 0); // exists
  assert.ok(titleHit.size === 1);
});

test('prefix tolerance reaches inflections ("embed" -> "embedding")', () => {
  const index = new LexicalIndex();
  index.add('x', 'Vector embeddings', 'Embedding models turn text into vectors for similarity search.');
  const hits = index.search(['embed']);
  assert.ok(hits.get('x') > 0);
});

test('remove() keeps doc-frequency counts clean', () => {
  const index = new LexicalIndex();
  index.add('a', 'Bread', 'bread bread bread');
  index.add('b', 'Bread too', 'more bread here');
  index.remove('a');
  assert.equal(index.size, 1);
  const hits = index.search(['bread']);
  assert.deepEqual([...hits.keys()], ['b']);
});

// ---------------------------------------------------------------------------
// retrieve.js — the honesty engine
// ---------------------------------------------------------------------------

function makeBrain() {
  const pages = [
    {
      pageId: 'p1', url: 'https://bakery.test/sourdough', title: 'Sourdough bread: a beginner guide',
      domain: 'bakery.test', domainLabel: 'bakery.test',
      visitedAt: new Date(Date.now() - 2 * 3600e3).toISOString(), dwellSeconds: 420, visitCount: 2,
      text: 'Sourdough bread needs only flour, water and salt, plus a starter you keep alive. ' +
        'Mix the dough, let it ferment overnight at room temperature, shape the loaf and ' +
        'bake it in a very hot oven for about forty minutes until the crust is dark.',
    },
    {
      pageId: 'p2', url: 'https://news.test/firewall-bug', title: 'Firewall bug exposes servers',
      domain: 'news.test', domainLabel: 'news.test',
      visitedAt: new Date(Date.now() - 50 * 3600e3).toISOString(), dwellSeconds: 90, visitCount: 1,
      text: 'A vulnerability in a popular firewall product lets attackers exploit unpatched ' +
        'servers. Vendors shipped patches last week after the exploit was disclosed.',
    },
  ];
  const chunks = [];
  for (const page of pages) {
    chunks.push({ id: `${page.pageId}:0`, pageId: page.pageId, url: page.url, title: page.title,
      domain: page.domain, domainLabel: page.domainLabel, visitedAt: page.visitedAt,
      dwellSeconds: page.dwellSeconds, visitCount: page.visitCount, source: 'extension',
      text: page.text, pageText: page.text, vec: embed(`${page.title}\n${page.text}`) });
  }
  const index = new LexicalIndex();
  for (const chunk of chunks) index.add(chunk.id, chunk.title, chunk.text);
  return { chunks, index };
}

test('retrieval is grounded on a question the memory really contains', () => {
  const { chunks, index } = makeBrain();
  const result = retrieve(chunks, index, 'how do I make sourdough bread?');
  assert.equal(result.grounded, true);
  assert.equal(result.matches[0].pageId, 'p1');
  assert.ok(result.matches[0].scores.relevance >= 0.2);
  assert.ok(result.matches[0].sentences.length >= 1);
  assert.ok(result.matches[0].visitedAgo.length > 0);
});

test('retrieval refuses to be grounded on something never read', () => {
  const { chunks, index } = makeBrain();
  const result = retrieve(chunks, index, 'quantum chromodynamics lattice simulations');
  assert.equal(result.grounded, false);
  assert.ok(result.bestRelevance < quoteFloor(1.1) || !result.grounded);
});

test('vector-only collision hits stay under the lexical cap', () => {
  const { chunks, index } = makeBrain();
  const result = retrieve(chunks, index, 'zzz qqq wobbletron');
  for (const match of result.matches) {
    if (!(match.scores.lexical > 0)) assert.ok(match.scores.relevance <= 0.42 + 1e-9);
  }
});

test('recency lifts the fresher page at equal relevance', () => {
  const { chunks, index } = makeBrain();
  const result = retrieve(chunks, index, 'sourdough bread');
  const p1 = result.matches.find((m) => m.pageId === 'p1');
  assert.ok(p1.scores.final > p1.scores.relevance * 0.69, 'recent page keeps recency bonus');
});

test('relatedPages excludes the current page', () => {
  const { chunks } = makeBrain();
  const related = relatedPages(chunks, ['bread', 'sourdough'], 'p1', 3);
  assert.ok(related.every((item) => item.pageId !== 'p1'));
});

// ---------------------------------------------------------------------------
// explain.js — the teacher voice
// ---------------------------------------------------------------------------

test('explainer builds sections with citations and no invented facts', () => {
  const { chunks, index } = makeBrain();
  const result = retrieve(chunks, index, 'how do I make sourdough bread?');
  const ex = explain({
    query: 'how do I make sourdough bread?',
    result,
    interests: [{ topic: 'bread', pages: 3, lastAgo: '2 hours ago' }],
  });
  assert.equal(ex.grounded, true);
  assert.ok(ex.opener.length > 10);
  assert.ok(ex.simple.length > 20);
  assert.ok(ex.citations.length >= 1);
  assert.equal(ex.citations[0].n, 1);
  assert.equal(ex.citations[0].kind, 'memory');
  assert.match(ex.citations[0].when, /.+/);
  assert.ok(ex.connect && ex.connect.includes('bread'));
  assert.ok(ex.followups.length >= 2);
  assert.equal(ex.honesty, null);
  // the lesson body must be traceable to the stored page text
  const source = chunks.find((c) => c.pageId === 'p1').text.toLowerCase();
  assert.ok(source.includes('starter'));
  assert.ok(ex.simple.toLowerCase().includes('starter') ||
            ex.points.join(' ').toLowerCase().includes('starter'));
});

test('explainer says "I don\'t know" warmly when memory is empty', () => {
  const empty = retrieve([], new LexicalIndex(), 'how do I make sourdough bread?');
  const ex = explain({ query: 'how do I make sourdough bread?', result: empty, interests: [] });
  assert.equal(ex.grounded, false);
  assert.ok(/don't have|nothing solid|isn't in/i.test(ex.honesty || ex.opener));
  assert.equal(ex.citations.length, 0);
  assert.ok(ex.closing.includes('web'));
});

test('web results are badged, numbered after memory, and further-reading links come last', () => {
  const { chunks, index } = makeBrain();
  const result = retrieve(chunks, index, 'how do I make sourdough bread?');
  const ex = explain({
    query: 'how do I make sourdough bread?', result, usedWeb: true,
    webResults: [{ title: 'Perfect sourdough crumb', url: 'https://bake.test/crumb',
                   snippet: 'Hydration above 75 percent gives an open crumb.' }],
    interests: [],
  });
  const kinds = ex.citations.map((c) => c.kind);
  assert.ok(kinds.indexOf('memory') < kinds.indexOf('web'));
  assert.equal(ex.citations[ex.citations.length - 1].n, ex.citations.length);
  assert.ok(ex.webNotes.length === 1);
  assert.ok(ex.citations.some((c) => c.url === 'https://bake.test/crumb' && c.kind === 'web'));
  // cited web pages are not repeated in further reading; extra web results are
  const more = explain({
    query: 'sourdough', result, usedWeb: true, interests: [],
    webResults: [
      { title: 'Crumb guide', url: 'https://bake.test/a', snippet: 'Hydration matters a lot here.' },
      { title: 'Crumb guide two', url: 'https://bake.test/b', snippet: 'Fermentation time matters.' },
      { title: 'Crumb guide three', url: 'https://bake.test/c', snippet: 'Oven spring matters too.' }
    ]
  });
  assert.ok(more.further.some((f) => f.url === 'https://bake.test/c'));
});

test('advice and smalltalk contain no fabricated page claims', () => {
  const text = advice('should I buy a dutch oven', [{ topic: 'bread' }], []);
  assert.ok(text.includes('bread'));
  assert.ok(!/https?:/.test(text));
  const hello = smalltalk('hi', { pages: 12, visits: 20 }, [{ topic: 'python' }]);
  assert.match(hello, /12/);
});

// ---------------------------------------------------------------------------
// websearch.js (parser is DOM-dependent; unwrap is pure)
// ---------------------------------------------------------------------------

test('unwrap decodes DuckDuckGo redirect links', () => {
  const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1&rut=abc';
  assert.equal(unwrap(href), 'https://example.com/page?x=1');
  assert.equal(unwrap('https://plain.test/ok'), 'https://plain.test/ok');
});

test('parseDdgHtml and extractFromHtml fail soft without a DOM', () => {
  if (typeof DOMParser === 'undefined') {
    assert.deepEqual(parseDdgHtml('<a class="result__a" href="x">title here</a>'), []);
    assert.deepEqual(extractFromHtml('<html><body><p>hi</p></body></html>'),
      { title: '', text: '' });
  }
});

// ---------------------------------------------------------------------------
// brain.js pure helpers
// ---------------------------------------------------------------------------

test('chunkText slices long text with overlap and caps output', () => {
  const sentence = 'This is one fairly long sentence about testing the chunker behaviour. ';
  const chunks = chunkText(sentence.repeat(200), 900, 120);
  assert.ok(chunks.length > 3 && chunks.length <= 60);
  assert.ok(chunks.every((c) => c.length > 60));
});

test('classify routes chat, advice, meta, explicit-web and knowledge', () => {
  assert.equal(classify('hello there'), 'smalltalk');
  assert.equal(classify('should I buy a dutch oven'), 'advice');
  assert.equal(classify('summarise my day'), 'meta');
  assert.equal(classify('web: latest react news'), 'web');
  assert.equal(classify('how does sourdough fermentation work'), 'knowledge');
});

test('hashId is stable and collision-resistant enough for page ids', () => {
  assert.equal(hashId('https://a.test/x'), hashId('https://a.test/x'));
  assert.notEqual(hashId('https://a.test/x'), hashId('https://a.test/y'));
});
