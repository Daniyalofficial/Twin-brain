/**
 * The complete English AI tool: experience bank of thousands of chats,
 * built-in knowledge core, the success bookshelf, and the English desk
 * (dictionary / synonyms / idioms / grammar fixing) — all offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-idb.mjs';

installFakeIndexedDb();
const brain = await import('../../extension/lib/brain/brain.js');
const { CHAT_CORPUS, CORPUS_INTENTS } = await import('../../extension/lib/brain/data/chatcorpus.js');
const { matchExperience, fluentReply, corpusStats } = await import('../../extension/lib/brain/fluent.js');
const core = await import('../../extension/lib/brain/core.js');
const { SUCCESS_BOOKS, findBook } = await import('../../extension/lib/brain/data/books.js');
const { questionType } = await import('../../extension/lib/brain/understand.js');

const NEVER = { webPermission: 'never', talkativeness: 'friendly' };

// ---------------------------------------------------------------------------
// the experience bank: thousands of chats
// ---------------------------------------------------------------------------

test('the experience bank holds thousands of chat turns across many intents', () => {
  assert.ok(CHAT_CORPUS.length >= 3000, `only ${CHAT_CORPUS.length} turns`);
  assert.ok(CORPUS_INTENTS.length >= 80);
  assert.ok(CHAT_CORPUS.every((e) => e.user && e.assistant && e.intent && e.tag));
  assert.equal(new Set(CHAT_CORPUS.map((e) => e.id)).size, CHAT_CORPUS.length);
  const stats = corpusStats();
  assert.equal(stats.turns, CHAT_CORPUS.length);
});

test('chitchat matches the right conversational intent', () => {
  const cases = [
    ['i am sad', 'sad'], ['tell me a joke', 'joke'], ['how are you doing', 'how_are_you'],
    ['good night', 'bye'], ['motivate me', 'motivate'], ['thanks a lot', 'thanks'],
    ['i cannot sleep', 'sleep'], ['lets practice english', 'english_practice'],
  ];
  for (const [message, intent] of cases) {
    const match = matchExperience(message);
    assert.ok(match, `no match for "${message}"`);
    assert.equal(match.intent, intent, `"${message}" routed to ${match.intent}`);
  }
});

test('knowledge questions are NOT hijacked by conversation intents (coverage gate)', () => {
  for (const message of [
    'how does the zibblewump drive work',
    'how does DNS recursion work',
    'quantum flux capacitor theory',
    'tarzan history of the jungle book',
    'how do I make sourdough bread',
  ]) {
    assert.equal(matchExperience(message), null, `"${message}" leaked into chitchat`);
  }
});

test('fluent replies are personalised, fluent English, and end on a conversational hook', () => {
  const reply = fluentReply('i am feeling so lonely today', { name: 'Daniyal' });
  assert.ok(reply);
  assert.equal(reply.intent, 'lonely');
  assert.ok(reply.text.includes('Daniyal'), 'uses the name like a friend');
  assert.ok(reply.text.length > 80, 'talkative, not one-liner');
  assert.ok(/[?]$/.test(reply.text.trim().slice(-1)) || reply.text.includes('?'),
            'keeps the conversation alive with a question');
});

// ---------------------------------------------------------------------------
// the built-in knowledge core
// ---------------------------------------------------------------------------

test('knowledge core retrieves real topics with precision anchoring', () => {
  const gravity = core.coreRetrieve('what is gravity');
  assert.ok(gravity.entries.length >= 1);
  assert.equal(gravity.entries[0].t, 'Gravity');
  // prefix-variant noise must not answer: bread ≠ breathing
  const bread = core.coreRetrieve('how do I make sourdough bread');
  assert.equal(bread.entries.length, 0);
  const gibberish = core.coreRetrieve('how does the zibblewump drive work');
  assert.equal(gibberish.entries.length, 0);
});

test('coreExplain produces a teacher-shaped, honestly-labelled explanation', () => {
  const ex = core.coreExplain('explain photosynthesis to me');
  assert.ok(ex);
  assert.equal(ex.grounded, true);
  assert.equal(ex.source, 'core');
  assert.ok(ex.simple.length > 60);
  assert.ok(ex.points.length >= 2);
  assert.ok(ex.citations.length >= 1);
  assert.equal(ex.citations[0].kind, 'core');
  assert.match(ex.honesty, /built-in knowledge core/i);
  assert.match(ex.honesty, /NOT from pages you read/i);
});

test('the brain answers general knowledge from the core when memory has nothing', async () => {
  const out = await brain.answer('what is gravity?', {}, NEVER);
  assert.equal(out.mode, 'explain');
  assert.equal(out.source, 'core');
  assert.equal(out.grounded, true);
  assert.equal(out.citations[0].kind, 'core');
  assert.match(out.text, /Gravity|gravity/);
  assert.match(out.text, /built-in knowledge core/i);
  assert.ok(!out.text.includes('undefined'));
});

test('the memory honesty contract survives the knowledge core', async () => {
  // the core KNOWS gravity — but "did I READ about it" must still answer honestly
  const out = await brain.answer('did I read anything about gravity?', {}, NEVER);
  assert.equal(out.grounded, false, 'must not claim a memory that does not exist');
  const said = [out.text, out.conversation && out.conversation.short,
                out.explanation && out.explanation.honesty].filter(Boolean).join(' ');
  assert.match(said, /haven't|have not|don't|do not|no pages|honest|nothing/i);
});

// ---------------------------------------------------------------------------
// the English tool
// ---------------------------------------------------------------------------

test('definitions come with meaning, synonyms and an example', async () => {
  const out = await brain.answer('define resilience', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.equal(out.english, true);
  assert.match(out.text, /recover quickly/i);
  assert.match(out.text, /Synonyms:/i);
  assert.match(out.text, /sentence/i);
});

test('idioms are explained as wholes', async () => {
  const out = await brain.answer('meaning of piece of cake', {}, NEVER);
  assert.match(out.text, /very easy/i);
  assert.match(out.text, /Example/i);
});

test('grammar fixing corrects AND explains every change', async () => {
  const out = await brain.answer('correct this: i am go to school and he dont know the answer', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.match(out.text, /I am going/);
  assert.match(out.text, /doesn't/);
  assert.match(out.text, /What changed and why/i);
  assert.ok(!/\bi\b/.test(out.text.split('Corrected:')[1].split('\n')[0]), 'lowercase i survives nowhere');
});

test('sentence improver upgrades weak words', () => {
  const improved = core.improveSentence('she is very happy and very tired today');
  assert.ok(improved.upgraded);
  assert.match(improved.upgraded, /delighted|exhausted/);
});

test('synonyms and the honest dictionary miss', async () => {
  const syn = await brain.answer('synonym for happy', {}, NEVER);
  assert.match(syn.text, /glad|joyful|delighted/);
  const miss = core.defineWord('zibblewump');
  assert.equal(miss.kind, 'miss');
  assert.match(miss.text, /not in my pocket dictionary/i);
});

test('word of the day rotates by date', () => {
  const a = core.wordOfTheDay();
  const b = core.wordOfTheDay();
  assert.equal(a.word, b.word, 'stable within a day');
  assert.ok(a.text.includes(a.word));
});

// ---------------------------------------------------------------------------
// the success bookshelf
// ---------------------------------------------------------------------------

test('the shelf carries the five must-reads plus the billionaire bonus', () => {
  assert.ok(SUCCESS_BOOKS.length >= 6);
  for (const book of SUCCESS_BOOKS) {
    assert.ok(book.lessons.length >= 10, `${book.title} needs full explanations`);
    assert.ok(book.lessons.every((l) => l.t && l.e.length > 60 && l.a));
    assert.ok(book.quotes.length >= 3);
    assert.equal(book.plan.length, 7);
    assert.ok(book.coreIdea.length > 200);
  }
  assert.equal(findBook('7 habits summary').id, 'seven-habits');
  assert.equal(findBook('carnegie book').id, 'how-to-win-friends');
  assert.equal(findBook('zero to one').id, 'zero-to-one');
});

test('"tell me about a book" teaches the whole book', async () => {
  const out = await brain.answer('tell me about rich dad poor dad', {}, NEVER);
  assert.equal(out.mode, 'book');
  assert.match(out.text, /Kiyosaki/);
  assert.match(out.text, /asset/i);
  assert.match(out.text, /THE LESSONS, EXPLAINED/i);
  assert.match(out.text, /7-DAY STARTER PLAN/i);
  assert.equal(out.citations[0].kind, 'core');
  assert.ok(out.text.length > 3000, 'full explanations, not a blurb');
});

test('"which books should I read" serves the shelf with a reading path', async () => {
  const out = await brain.answer('which books should i read to be successful', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.match(out.text, /Think and Grow Rich/);
  assert.match(out.text, /Atomic Habits/);
  assert.ok(out.books.length >= 5);
});

test('"how to become a billionaire" gets the honest four-stage curriculum', async () => {
  const out = await brain.answer('how to become a billionaire', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.match(out.text, /MINDSET|mindset/);
  assert.match(out.text, /OWNERSHIP|ownership/);
  assert.match(out.text, /Zero to One/);
  assert.match(out.text, /decade/i);
});

// ---------------------------------------------------------------------------
// routing + tool stats
// ---------------------------------------------------------------------------

test('english/book/success intents route correctly', () => {
  assert.equal(questionType('define perseverance'), 'define');
  assert.equal(questionType('correct this: i am go home'), 'grammar');
  assert.equal(questionType('synonym for brave'), 'word');
  assert.equal(questionType('tell me about atomic habits'), 'book');
  assert.equal(questionType('recommend a book'), 'books');
  assert.equal(questionType('how can i make money online'), 'success');
  assert.equal(questionType('my dad is poor'), 'knowledge');      // personal, not a book request
  assert.equal(questionType('what is gravity'), 'knowledge');      // core KB territory
});

test('toolStats reports the full offline arsenal', () => {
  const stats = brain.toolStats();
  assert.ok(stats.chatExperience.turns >= 3000);
  assert.ok(stats.chatExperience.intents >= 80);
  assert.ok(stats.knowledgeCore.topics >= 100);
  assert.ok(stats.englishTool.words >= 200);
  assert.ok(stats.englishTool.idioms >= 50);
  assert.ok(stats.englishTool.grammarRules >= 40);
  assert.equal(stats.bookshelf.books, SUCCESS_BOOKS.length);
  assert.ok(stats.bookshelf.lessons >= 60);
});

test('emotional one-liners get the experienced friend, not "I don\'t know"', async () => {
  const out = await brain.answer('i am so tired of everything today', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.ok(out.text.length > 60);
  // replies rotate daily among the corpus' vent variants (hashPick is
  // date-seeded), so assert the reply IS one of those variants (prefix match
  // tolerates an optional woven-memory tail), not one fixed wording
  const { CHAT_CORPUS } = await import('../../extension/lib/brain/data/chatcorpus.js');
  const vents = CHAT_CORPUS
    .filter((t) => ['tired', 'work_vent'].includes(t.intent))
    .map((t) => t.assistant.replace(/\{name\}/g, 'friend'));
  assert.ok(vents.some((v) => out.text.startsWith(v)),
    `reply should be a corpus vent variant, got: ${out.text.slice(0, 80)}`);
  assert.ok(!/don't know|do not know/i.test(out.text));
});
