/**
 * Real-time friend layer tests — run with: node --test tests/js/
 *
 * Covers understanding (question types, time ranges, anaphora, personal facts),
 * the persona (warmth without fabricated facts) and direct answers
 * (when / how many / which sites / did I / recap / compare).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseQuery, extractFacts, questionType, parseTimeRange,
} from '../../extension/lib/brain/understand.js';
import {
  displayName, greeting, respondToCompliment, respondToThanks, questionBack,
  empathyLine, weaveFacts, hedgeLine, farewell, thinkingNotes,
} from '../../extension/lib/brain/persona.js';
import { directAnswer } from '../../extension/lib/brain/direct.js';

// ---------------------------------------------------------------------------
// understanding
// ---------------------------------------------------------------------------

test('question types are routed correctly', () => {
  assert.equal(questionType('when did I read about sourdough?'), 'when');
  assert.equal(questionType('how many pages about python do I have?'), 'count');
  assert.equal(questionType('which sites did I read AI news on?'), 'which_source');
  assert.equal(questionType('did I read anything about transformers?'), 'verify');
  assert.equal(questionType('what is an embedding?'), 'define');
  assert.equal(questionType('difference between BM25 and cosine similarity'), 'compare');
  assert.equal(questionType('what did I read today?'), 'recap');
  assert.equal(questionType('should I buy a dutch oven?'), 'advice');
  assert.equal(questionType('hey how are you'), 'smalltalk');
  assert.equal(questionType('web: latest react news'), 'web');
  assert.equal(questionType('how does sourdough fermentation work'), 'knowledge');
});

test('time phrases become real date windows', () => {
  const today = parseTimeRange('what did I read today');
  assert.equal(today.label, 'today');
  assert.ok(Date.now() - today.sinceMs < 25 * 3600e3);
  const week = parseTimeRange('my pages from last week');
  assert.ok(week.sinceMs < today.sinceMs);
  assert.equal(parseTimeRange('how does DNS work'), null);
});

test('personal facts are extracted from natural sentences', () => {
  const facts = extractFacts('Hey, my name is Ali and I am learning Python these days');
  const kinds = Object.fromEntries(facts.map((f) => [f.kind, f.value]));
  assert.equal(kinds.name, 'Ali');
  assert.ok(/python/i.test(kinds.learning));

  const more = extractFacts('I love cricket, I work as a teacher, I live in Islamabad');
  const moreKinds = Object.fromEntries(more.map((f) => [f.kind, f.value]));
  assert.ok(/cricket/i.test(moreKinds.likes));
  assert.ok(/teacher/i.test(moreKinds.job));
  assert.ok(/islamabad/i.test(moreKinds.lives));

  const note = extractFacts('remember: my exam is on Friday');
  assert.equal(note[0].kind, 'note');
});

test('fact extraction does not fire on plain questions', () => {
  assert.deepEqual(extractFacts('how do I bake sourdough bread?'), []);
  assert.deepEqual(extractFacts('what did I read about models today?'), []);
});

test('anaphora: "tell me more" continues the previous topic', () => {
  const history = [{ query: 'how does sourdough work', topic: 'sourdough work', type: 'knowledge' }];
  const parsed = parseQuery('tell me more', { history });
  assert.equal(parsed.anaphora, true);
  assert.ok(parsed.topicWords.includes('sourdough'));
  assert.ok(parsed.resolvedQuery.includes('sourdough'));

  const aboutThat = parseQuery('what about that?', { history });
  assert.equal(aboutThat.anaphora, true);
  assert.ok(aboutThat.resolvedQuery.includes('sourdough'));
});

test('vague questions become clarification, not guesses', () => {
  const parsed = parseQuery('what about?', { history: [] });
  assert.equal(parsed.ambiguous, true);
  const specific = parseQuery('what about sourdough?', { history: [] });
  assert.equal(specific.ambiguous, false);
});

test('quoted phrases become topic words', () => {
  const parsed = parseQuery('did I read anything about "vector databases"?');
  assert.ok(parsed.topicWords.includes('vector'));
  assert.ok(parsed.topicWords.includes('databases'));
});

test('compliments and greetings are recognised', () => {
  assert.equal(parseQuery('you are awesome!').compliment, true);
  assert.equal(parseQuery('assalam o alaikum').type, 'smalltalk');
});

// ---------------------------------------------------------------------------
// persona — warmth without facts
// ---------------------------------------------------------------------------

test('display name prefers what the user said over settings', () => {
  assert.equal(displayName({ name: { value: 'Ali' } }, { userName: 'Bob' }), 'Ali');
  assert.equal(displayName({}, { userName: 'Bob' }), 'Bob');
  assert.equal(displayName({}, {}), null);
});

test('greeting uses the name and time of day', () => {
  assert.ok(greeting('Ali', 9).includes('Ali'));
  assert.match(greeting(null, 23), /night owl|Hey/i);
  assert.match(greeting(null, 8), /morning/i);
});

test('compliments, thanks and goodbyes get warm replies with no facts', () => {
  for (const text of [respondToCompliment('Ali'), respondToThanks(null), farewell('Ali')]) {
    assert.ok(text.length > 10);
    assert.ok(!/https?:/.test(text));
  }
});

test('weaveFacts connects stored facts to the current topic', () => {
  const facts = { learning: { value: 'Python' } };
  assert.ok(weaveFacts(facts, ['python', 'flask']).includes('Python'));
  assert.equal(weaveFacts(facts, ['cricket']), null);
});

test('hedgeLine is honest about confidence', () => {
  assert.equal(hedgeLine(0.8), null);
  assert.match(hedgeLine(0.4), /fairly sure/i);
  assert.match(hedgeLine(0.1), /not 100%/i);
  assert.equal(hedgeLine(0), null);
});

test('questionBack personalises using facts and interests', () => {
  const q = questionBack({ learning: { value: 'Python' } }, [{ topic: 'flask' }],
    { raw: 'how does DNS work' });
  assert.ok(q.includes('Python'));
  const q2 = questionBack({}, [{ topic: 'bread' }], { raw: 'x' });
  assert.ok(q2.includes('bread'));
});

test('empathyLine notices frustration, deadlines and mood', () => {
  assert.ok(empathyLine("I'm so confused by this"));
  assert.ok(empathyLine('my interview is tomorrow'));
  assert.equal(empathyLine('how does DNS work'), null);
});

test('thinkingNotes narrate real-time work', () => {
  const notes = thinkingNotes({ type: 'knowledge', topicWords: ['sourdough'] }, { pages: 12 });
  assert.ok(notes.length >= 3);
  assert.ok(notes.some((n) => n.includes('sourdough')));
  assert.ok(notes.some((n) => n.includes('12')));
});

// ---------------------------------------------------------------------------
// direct answers
// ---------------------------------------------------------------------------

function fakePages() {
  const now = Date.now();
  return [
    { pageId: 'p1', url: 'https://bakery.test/sourdough', title: 'Sourdough bread guide',
      domain: 'bakery.test', domainLabel: 'bakery.test',
      visitedAt: new Date(now - 3 * 86400000).toISOString(), dwellSeconds: 600, visitCount: 2,
      text: 'Sourdough bread needs flour water salt and a starter. Ferment overnight and bake hot.' },
    { pageId: 'p2', url: 'https://bakery.test/bagels', title: 'Bagels at home',
      domain: 'bakery.test', domainLabel: 'bakery.test',
      visitedAt: new Date(now - 1 * 3600e3).toISOString(), dwellSeconds: 90, visitCount: 1,
      text: 'Bagels are boiled then baked. The dough is similar to bread dough but tighter.' },
    { pageId: 'p3', url: 'https://news.test/firewall', title: 'Firewall bug',
      domain: 'news.test', domainLabel: 'news.test',
      visitedAt: new Date(now - 10 * 86400000).toISOString(), dwellSeconds: 30, visitCount: 1,
      text: 'A firewall vulnerability lets attackers exploit unpatched servers.' },
  ];
}

test('direct answer: WHEN did I read X gives an exact date and source', () => {
  const parsed = parseQuery('when did I read about sourdough bread?');
  const out = directAnswer(parsed, { matches: [] }, { pages: fakePages() });
  assert.equal(out.found, true);
  assert.ok(out.text.includes('Sourdough bread guide'));
  assert.ok(out.citations.length === 1);
  assert.equal(out.citations[0].kind, 'memory');
  assert.ok(out.citations[0].url === 'https://bakery.test/sourdough');
});

test('direct answer: WHEN refuses to invent a date for unknown topics', () => {
  const parsed = parseQuery('when did I read about quantum gravity?');
  const out = directAnswer(parsed, { matches: [] }, { pages: fakePages() });
  assert.equal(out.found, false);
  assert.match(out.text, /won't guess|no page/i);
});

test('direct answer: HOW MANY counts honestly', () => {
  const parsed = parseQuery('how many pages about bread do I have?');
  const out = directAnswer(parsed, { matches: [] }, { pages: fakePages() });
  assert.equal(out.found, true);
  assert.match(out.text, /2 page/);
  const none = directAnswer(parseQuery('how many pages about chess?'), { matches: [] },
    { pages: fakePages() });
  assert.equal(none.found, false);
  assert.match(none.text, /Zero/);
});

test('direct answer: WHICH SITES ranks domains from your memory', () => {
  const parsed = parseQuery('which sites did I read about bread and baking on?');
  const out = directAnswer(parsed, { matches: [] }, { pages: fakePages() });
  assert.equal(out.found, true);
  assert.ok(out.text.includes('bakery.test'));
  assert.ok(!out.text.includes('news.test'));
});

test('direct answer: DID I READ X is yes/no with evidence', () => {
  const yes = directAnswer(parseQuery('did I read anything about sourdough?'),
    { matches: [] }, { pages: fakePages() });
  assert.equal(yes.found, true);
  assert.match(yes.text, /^Yes/);
  assert.ok(yes.citations.length >= 1);

  const no = directAnswer(parseQuery('did I read anything about rocket science?'),
    { matches: [] }, { pages: fakePages() });
  assert.equal(no.found, false);
  assert.match(no.text, /^No/);
});

test('direct answer: recap respects the time window', () => {
  const today = directAnswer(parseQuery('what did I read today?'),
    { matches: [] }, { pages: fakePages() });
  assert.equal(today.found, true);
  assert.match(today.text, /1 page/);
  assert.ok(today.text.includes('Bagels'));

  const week = directAnswer(parseQuery('what did I read this week?'),
    { matches: [] }, { pages: fakePages() });
  assert.match(week.text, /2 page/);

  const empty = directAnswer(parseQuery('what did I read yesterday?'),
    { matches: [] }, { pages: [Object.assign(fakePages()[2], { visitedAt: new Date(Date.now() - 30 * 86400000).toISOString() })] });
  assert.equal(empty.found, false);
  assert.match(empty.text, /empty|Nothing captured/i);
});

test('direct answer: compare shows what memory holds on each side', () => {
  const parsed = parseQuery('difference between sourdough and bagels');
  const out = directAnswer(parsed, { matches: [] }, { pages: fakePages() });
  assert.ok(out.text.includes('Sourdough'));
  assert.ok(out.text.includes('Bagel'));
  const lopsided = directAnswer(parseQuery('compare sourdough and croissants'),
    { matches: [] }, { pages: fakePages() });
  assert.match(lopsided.text, /won't compare|can't compare|nothing in your memory/i);
});
