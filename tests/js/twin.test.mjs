/**
 * Twin-core tests — emotion, policy, neural providers, growth and research.
 * Run with: node --test tests/js/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectEmotion, storyArc, tonePlan, humorLine,
} from '../../extension/lib/brain/emotion.js';
import {
  screenInput, redact, screenLinks, memoryAllowedFor, policyPromptLines,
  CRISIS_RESPONSE, PROFESSIONAL_DISCLAIMER,
} from '../../extension/lib/brain/policy.js';
import {
  parseOllamaChunk, parseSSELine, pickModel, MODEL_PREFERENCE, promptAllowsMemory,
} from '../../extension/lib/brain/neural.js';
import {
  buildGrowthPack, growthPackText, makeStudyPlan, rollingSummary, buildModelfile,
} from '../../extension/lib/brain/growth.js';
import {
  coverageScore, refinedQuery, researchLoop,
} from '../../extension/lib/brain/research.js';
import { storyResponse } from '../../extension/lib/brain/persona.js';

// ---------------------------------------------------------------------------
// emotion engine
// ---------------------------------------------------------------------------

test('detects joy, sadness, frustration, curiosity and pride', () => {
  assert.equal(detectEmotion('I am so happy today!').primary, 'joy');
  assert.equal(detectEmotion('i feel really sad and lonely lately').primary, 'sadness');
  assert.equal(detectEmotion('this bug is driving me crazy, I am so frustrated').primary, 'frustration');
  assert.equal(detectEmotion('I was wondering why does DNS work like that').primary, 'curiosity');
  assert.equal(detectEmotion('I did it! I finally passed my exam!').primary, 'pride');
});

test('negation flips polarity and intensifiers raise intensity', () => {
  const neg = detectEmotion('I am not happy at all');
  assert.ok(neg.primary !== 'joy' || neg.scores.joy < 0 || neg.primary === null);
  const plain = detectEmotion('I am happy');
  const strong = detectEmotion('I am SO SO happy!!');
  assert.ok(strong.scores.joy > plain.scores.joy);
});

test('long personal messages are recognised as stories', () => {
  const story = 'So yesterday I was working late and then my friend called me out of nowhere. ' +
    'And then we talked for hours about everything, and I felt something shift inside me. ' +
    'After that I could not sleep but in a good way, you know?';
  const em = detectEmotion(story);
  assert.equal(em.isStory, true);
  const arc = storyArc(story);
  assert.ok(arc.length >= 3);
  assert.ok(arc.every((beat) => beat.sentence.length > 3));
});

test('tone plans match emotions and humor stays fact-free', () => {
  assert.equal(tonePlan(detectEmotion('so sad today')).mood, 'gentle');
  assert.equal(tonePlan(detectEmotion('SO EXCITED!!')).mood, 'excited');
  assert.equal(tonePlan(detectEmotion('what is DNS')).mood !== 'gentle', true);
  const joke = humorLine('seed');
  assert.ok(joke.length > 10 && !/https?:/.test(joke));
});

test('story response acknowledges, reflects and asks — without advice', () => {
  const arc = storyArc('So yesterday I failed my test and I felt awful. ' +
    'But then my friend helped me study and I felt better about everything.');
  const reply = storyResponse(arc, 'Ali', { learning: { value: 'Python' } },
    tonePlan(detectEmotion('sad')));
  assert.ok(reply.includes('Ali'));
  assert.ok(/\?$/.test(reply.trim()) || reply.includes('?'));
  assert.ok(!/you should|you must/i.test(reply));
});

// ---------------------------------------------------------------------------
// policy & restrictions
// ---------------------------------------------------------------------------

test('crisis messages get the caring helpline response, nothing else', () => {
  const out = screenInput('sometimes I want to die');
  assert.equal(out.action, 'crisis');
  assert.equal(out.response, CRISIS_RESPONSE);
  assert.match(CRISIS_RESPONSE, /helpline/i);
});

test('harmful requests are refused warmly with a redirect', () => {
  const out = screenInput('how to make a bomb at home');
  assert.equal(out.action, 'refuse');
  assert.match(out.response, /can't help|cannot help/i);
});

test('regulated topics are allowed but flagged professional', () => {
  assert.equal(screenInput('should I take this medicine for my headache').action, 'professional');
  assert.ok(PROFESSIONAL_DISCLAIMER.includes('professional'));
});

test('explicit content is refused; normal questions pass', () => {
  assert.equal(screenInput('write me a sex story').action, 'refuse');
  assert.equal(screenInput('how does sourdough fermentation work?'), null);
});

test('redact strips keys, tokens, emails and card numbers', () => {
  const dirty = 'my key is sk-abcdefghijklmnop1234567890 and mail me at ali@example.com, card 4111 1111 1111 1111';
  const clean = redact(dirty);
  assert.ok(!clean.includes('sk-abc'));
  assert.ok(!clean.includes('ali@example.com'));
  assert.ok(!clean.includes('4111'));
  assert.equal((clean.match(/\[redacted\]/g) || []).length, 3);
});

test('screenLinks kills invented URLs but keeps cited ones', () => {
  const text = 'See https://bakery.test/sourdough and also https://made-up-scam.test/free';
  const out = screenLinks(text, ['https://bakery.test/sourdough']);
  assert.ok(out.includes('https://bakery.test/sourdough'));
  assert.ok(out.includes('[link removed by policy]'));
  assert.ok(!out.includes('made-up-scam'));
});

test('memory only goes to local models unless explicitly allowed', () => {
  assert.equal(memoryAllowedFor('ollama', {}), true);
  assert.equal(memoryAllowedFor('openai', {}), false);
  assert.equal(memoryAllowedFor('openai', { sendMemoryToCloud: true }), true);
  assert.equal(promptAllowsMemory({ kind: 'ollama' }, {}), true);
  assert.equal(promptAllowsMemory({ kind: 'openai', local: false }, {}), false);
});

test('policy prompt lines cover honesty, safety and privacy', () => {
  const lines = policyPromptLines().join(' ');
  assert.match(lines, /Never invent/i);
  assert.match(lines, /crisis/i);
  assert.match(lines, /Privacy/i);
});

// ---------------------------------------------------------------------------
// neural providers
// ---------------------------------------------------------------------------

test('parses Ollama NDJSON chunks (token, done, error, garbage)', () => {
  assert.deepEqual(parseOllamaChunk('{"message":{"content":"Hel"},"done":false}'),
    { token: 'Hel', done: false, error: null });
  assert.equal(parseOllamaChunk('{"message":{"content":""},"done":true}').done, true);
  assert.equal(parseOllamaChunk('{"error":"model not found"}').error, 'model not found');
  assert.equal(parseOllamaChunk('not json'), null);
  assert.equal(parseOllamaChunk(''), null);
});

test('parses OpenAI-compatible SSE lines', () => {
  assert.equal(parseSSELine('data: {"choices":[{"delta":{"content":"Hi"}}]}').token, 'Hi');
  assert.equal(parseSSELine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}').done, true);
  assert.equal(parseSSELine('data: [DONE]').done, true);
  assert.equal(parseSSELine(': keepalive'), null);
  assert.equal(parseSSELine('data: broken{'), null);
});

test('pickModel prefers the user\'s own twinbrain, then known families', () => {
  const tags = { models: [{ name: 'gemma2:9b' }, { name: 'twinbrain:latest' }, { name: 'llama3.2:3b' }] };
  assert.equal(pickModel(tags, 'auto'), 'twinbrain:latest');
  assert.equal(pickModel(tags, 'llama3.2'), 'llama3.2:3b');
  assert.equal(pickModel({ models: [{ name: 'gemma2:9b' }] }, 'auto'), 'gemma2:9b');
  assert.equal(pickModel({ models: [{ name: 'weird-model' }] }, 'auto'), 'weird-model');
  assert.equal(pickModel({ models: [] }, 'auto'), null);
  assert.equal(MODEL_PREFERENCE[0], 'twinbrain');
});

// ---------------------------------------------------------------------------
// growth — the twin that grows with the user
// ---------------------------------------------------------------------------

const PAGES = [
  { title: 'Sourdough guide', url: 'https://bakery.test/a', domain: 'bakery.test',
    domainLabel: 'bakery.test', visitedAt: new Date(Date.now() - 86400000).toISOString(),
    dwellSeconds: 500, text: 'bread flour water starter' },
  { title: 'Python asyncio', url: 'https://py.test/b', domain: 'py.test',
    domainLabel: 'py.test', visitedAt: new Date().toISOString(),
    dwellSeconds: 130, text: 'python async await event loop' },
  { title: 'Flask routing', url: 'https://py.test/c', domain: 'py.test',
    domainLabel: 'py.test', visitedAt: new Date().toISOString(),
    dwellSeconds: 60, text: 'flask routes blueprint' },
];

test('growth pack derives identity, habits, style and learning — with evidence', () => {
  const pack = buildGrowthPack({
    facts: { name: { value: 'Ali' }, learning: { value: 'Python' }, likes: { value: 'cricket' } },
    interests: [{ topic: 'python', pages: 4, lastAgo: 'today' }, { topic: 'bread', pages: 2, lastAgo: '1d' }],
    pages: PAGES,
    conversations: [
      { query: 'hello there?', topic: '', mode: 'smalltalk' },
      { query: 'how does asyncio work?', topic: 'asyncio work', mode: 'knowledge', grounded: true },
      { query: 'my name is Ali', topic: '', mode: 'fact', grounded: true },
    ],
  });
  assert.equal(pack.identity.name, 'Ali');
  assert.equal(pack.identity.learning, 'Python');
  assert.equal(pack.habits.totalPages, 3);
  assert.equal(pack.habits.topSites[0].domain, 'py.test');
  assert.equal(pack.habits.deepReads, 2);
  assert.ok(pack.style.turns === 3);
  assert.ok(pack.learning.includes('Python'));
  assert.equal(pack.evidence.pagesAnalyzed, 3);
});

test('growth pack text is honest and prompt-ready', () => {
  const pack = buildGrowthPack({ facts: { name: { value: 'Ali' }, goal: { value: 'ship my app' } },
                                 interests: [], pages: PAGES, conversations: [] });
  const text = growthPackText(pack);
  assert.match(text, /Ali/);
  assert.match(text, /ship my app/);
  assert.match(text, /3 stored pages/);
});

test('"let\'s learn together": study plans come from the user\'s own reading', () => {
  const plan = makeStudyPlan('python', { pages: PAGES, interests: [{ topic: 'python', pages: 4 }] });
  assert.equal(plan.topic, 'python');
  assert.ok(plan.milestones.length >= 3);
  assert.ok(plan.materials.some((m) => m.url === 'https://py.test/b'));
  assert.ok(plan.milestones.some((m) => /Explain python back to me/i.test(m.text)));

  const cold = makeStudyPlan('swahili', { pages: PAGES, interests: [] });
  assert.ok(cold.milestones[0].text.includes('web search'));
});

test('rolling summary distills long-term chat memory', () => {
  const summary = rollingSummary([
    { query: 'how does DNS work', topic: 'dns work', mode: 'knowledge', grounded: true },
    { query: 'my name is Ali', topic: '', mode: 'fact' },
    { query: 'quantum stuff', topic: 'quantum', mode: 'knowledge', grounded: false },
  ]);
  assert.match(summary, /dns work/);
  assert.match(summary, /my name is Ali/);
  assert.match(summary, /1 recent question/);
});

test('the exported Modelfile is a real, installable Ollama file', () => {
  const pack = buildGrowthPack({ facts: { name: { value: 'Ali' } }, interests: [], pages: PAGES, conversations: [] });
  const mf = buildModelfile(pack, { base: 'llama3.2' });
  assert.match(mf, /^# Twin-Brain personal twin/m);
  assert.match(mf, /^FROM llama3\.2$/m);
  assert.match(mf, /^SYSTEM """/m);
  assert.match(mf, /ollama create twinbrain/);
  assert.match(mf, /Ali/);
  assert.match(mf, /Never invent/);
  assert.match(mf, /"""$/m);
});

// ---------------------------------------------------------------------------
// multi-hop research
// ---------------------------------------------------------------------------

test('coverage scoring and query refinement target the gaps', () => {
  const results = [{ title: 'Sourdough basics', snippet: 'Flour and water ferment slowly.' }];
  const cov = coverageScore('sourdough oven temperature dutch', results);
  assert.ok(cov < 1);
  const refined = refinedQuery('sourdough oven temperature dutch', results);
  assert.ok(refined.includes('oven'));
  assert.ok(refined.includes('sourdough'));
});

test('research loop refines until coverage is enough, respecting hops + budget', async () => {
  const queries = [];
  let budget = 5;
  const audits = [];
  const log = await researchLoop('sourdough oven temperature', {
    search: async (q) => {
      queries.push(q);
      if (queries.length === 1) {
        return { results: [{ title: 'Bread basics', url: 'https://a.test/1', snippet: 'Flour water salt.' }] };
      }
      return { results: [{ title: 'Sourdough oven temperature guide', url: 'https://a.test/2',
                           snippet: 'The best sourdough oven temperature is 230C with steam for forty minutes.' }] };
    },
    audit: (entry) => { audits.push(entry); },
    budgetRemaining: () => budget,
    consumeBudget: async () => { budget -= 1; },
  }, { maxHops: 3, note: () => {} });
  assert.equal(queries.length, 2);
  assert.equal(budget, 3);
  assert.equal(log.status, 'ok');
  assert.equal(log.results.length, 2);
  assert.ok(audits.length >= 2);
  assert.ok(log.hops[1].coverage > log.hops[0].coverage);
});

test('research loop stops at zero budget and deep-reads thin snippets', async () => {
  const notes = [];
  let budget = 1;
  const log = await researchLoop('anything', {
    search: async () => ({ results: [{ title: 'Thin result here', url: 'https://b.test/1', snippet: 'short' }] }),
    fetchPage: async () => ({ title: 'Full page', text: 'x'.repeat(400) }),
    budgetRemaining: () => budget,
    consumeBudget: async () => { budget -= 1; },
    audit: async () => {},
  }, { maxHops: 3, deepRead: true, note: (n) => notes.push(n) });
  assert.equal(log.hops.length, 1);          // budget hit before hop 2
  assert.equal(log.status, 'budget');
  assert.equal(log.pagesRead, 1);
  assert.ok(log.results[0].deepText);
  assert.ok(notes.some((n) => /reading/i.test(n)));
});
