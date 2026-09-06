/**
 * End-to-end integration test of the on-device brain, running the REAL
 * orchestrator (brain.js) against an in-memory IndexedDB fake. No chrome,
 * no network: webPermission is pinned to 'never'/'ask' so no fetch can occur.
 *
 * Order matters in this file — tests run sequentially like a real chat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-idb.mjs';

installFakeIndexedDb();
const brain = await import('../../extension/lib/brain/brain.js');

const NEVER = { webPermission: 'never', talkativeness: 'friendly' };

const SOURDOUGH = {
  url: 'https://bakery.test/sourdough',
  title: 'Sourdough bread: a beginner guide',
  text: 'Sourdough bread needs only flour, water and salt, plus a starter you keep alive. ' +
        'Mix the dough, let it ferment overnight at room temperature, shape the loaf and ' +
        'bake it in a very hot oven for about forty minutes until the crust is dark and crisp.',
  domain: 'bakery.test', domainLabel: 'bakery.test',
  visitedAt: new Date().toISOString(), dwellSeconds: 420, source: 'extension',
};

test('a vague question with no history becomes a clarifying question', async () => {
  const out = await brain.answer('what about?', {}, NEVER);
  assert.equal(out.mode, 'clarify');
  assert.ok(out.text.length > 20);
  assert.ok(out.chips.length >= 2);
});

test('ingest stores chunks in IndexedDB and updates stats + interests', async () => {
  const res = await brain.ingestPage(SOURDOUGH);
  assert.ok(res.chunks >= 1);
  const stats = await brain.brainStats();
  assert.equal(stats.pages, 1);
  assert.ok(stats.chunks >= 1);
  const interests = brain.interestsNow();
  assert.ok(interests.length >= 1);
});

test('a real question gets a grounded, cited, teacher-style answer', async () => {
  const out = await brain.answer('how do I make sourdough bread?', {}, NEVER);
  assert.equal(out.mode, 'explain');
  assert.equal(out.grounded, true);
  assert.ok(out.explanation.simple.length > 20);
  assert.ok(out.explanation.citations.length >= 1);
  assert.equal(out.explanation.citations[0].url, SOURDOUGH.url);
  assert.equal(out.explanation.citations[0].kind, 'memory');
  assert.ok(out.explanation.followups.length >= 1);
});

test('progress hooks narrate the thinking in real time', async () => {
  const notes = [];
  await brain.answer('how does sourdough fermentation work?', {}, NEVER,
    { progress: (text) => notes.push(text) });
  assert.ok(notes.length >= 2);
  assert.ok(notes.some((n) => /scanning|memory/i.test(n)));
});

test('"when did I read X" gets a direct dated answer with a citation', async () => {
  const out = await brain.answer('when did I read about sourdough?', {}, NEVER);
  assert.ok(out.conversation.short);
  assert.match(out.conversation.short, /Sourdough bread: a beginner guide/);
  assert.ok(out.citations.length >= 1);
  assert.equal(out.grounded, true);
});

test('"did I read about X" answers an honest NO for unknown topics', async () => {
  const out = await brain.answer('did I read anything about rocket science?', {}, NEVER);
  assert.ok(out.conversation.short);
  assert.match(out.conversation.short, /^No/);
  assert.equal(out.grounded, false);
});

test('unknown topics with webPermission=ask trigger the permission protocol, never a fetch', async () => {
  const out = await brain.answer('how does quantum gravity work?', {}, { webPermission: 'ask' });
  assert.equal(out.mode, 'needs_permission');
  assert.equal(out.question, 'how does quantum gravity work?');
});

test('the brain remembers what you tell it about yourself', async () => {
  const out = await brain.answer('my name is Ali and I am learning Python', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.ok(out.text.includes('Ali'));
  const facts = await brain.loadFacts();
  assert.equal(facts.name.value, 'Ali');
  assert.match(facts.learning.value, /Python/i);
});

test('greetings use your name like a friend would', async () => {
  const out = await brain.answer('hi there!', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.ok(out.text.includes('Ali'));
});

test('"tell me more" resolves to the topic you were just discussing', async () => {
  await brain.answer('how do I make sourdough bread?', {}, NEVER);
  const out = await brain.answer('tell me more', {}, NEVER);
  assert.equal(out.anaphora, true);
  assert.equal(out.grounded, true);
});

test('recap questions summarise the day from stored pages only', async () => {
  const out = await brain.answer('what did I read today?', {}, NEVER);
  assert.equal(out.grounded, true);
  const text = `${out.conversation.short || ''} ${out.text || ''}`;
  assert.match(text, /Sourdough/i);
});

test('compliments get a warm reply with zero fabricated facts', async () => {
  const out = await brain.answer('you are awesome!', {}, NEVER);
  assert.equal(out.mode, 'chat');
  assert.ok(!/https?:/.test(out.text));
});

test('forget erases the page from the on-device brain', async () => {
  const forgot = await brain.forgetPage(SOURDOUGH.url);
  assert.equal(forgot, true);
  const out = await brain.answer('how do I make sourdough bread?', {}, NEVER);
  assert.equal(out.grounded, false);
  const stats = await brain.brainStats();
  assert.equal(stats.pages, 0);
});
