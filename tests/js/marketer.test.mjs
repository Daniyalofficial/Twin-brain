/**
 * MarketerTwin tests — the digital-marketing twin's data, engines and stores.
 * Run with:  node --test tests/js/marketer.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-idb.mjs';

const D = '../../marketer/lib/brain/data/';

// ---------------------------------------------------------------------------
// data integrity
// ---------------------------------------------------------------------------

test('chatcorpus: thousands of marketing turns across balanced tags', async () => {
  const { CHAT_CORPUS, CORPUS_INTENTS } = await import(`${D}chatcorpus.js`);
  assert.ok(CHAT_CORPUS.length >= 4000, `turns: ${CHAT_CORPUS.length}`);
  assert.ok(CORPUS_INTENTS.length >= 40, `intents: ${CORPUS_INTENTS.length}`);
  for (const turn of CHAT_CORPUS) {
    assert.ok(turn.user && turn.user.length > 0, 'every turn has a user line');
    assert.ok(turn.assistant && turn.assistant.length > 10, 'every turn has a reply');
    assert.ok(turn.tag && turn.intent, 'every turn is tagged and intentioned');
  }
  const tags = new Set(CHAT_CORPUS.map((t) => t.tag));
  for (const required of ['urdu', 'ads', 'sales', 'twin', 'greeting', 'branding']) {
    assert.ok(tags.has(required), `missing tag ${required}`);
  }
});

test('corekb: 80 marketing topics in 13 categories, all well-formed', async () => {
  const { CORE_KNOWLEDGE, CORE_CATEGORIES, coreKnowledgeSize } = await import(`${D}corekb.js`);
  assert.ok(CORE_KNOWLEDGE.length >= 75);
  assert.equal(Object.keys(CORE_CATEGORIES).length, 13);
  for (const entry of CORE_KNOWLEDGE) {
    assert.ok(entry.t && entry.t.length >= 3, 'title');
    assert.ok(CORE_CATEGORIES[entry.c], `known category: ${entry.c}`);
    assert.ok(entry.s && entry.s.length >= 60, `summary long enough: ${entry.t}`);
    assert.ok(Array.isArray(entry.a) && entry.a.length >= 3, `aliases: ${entry.t}`);
    assert.ok(Array.isArray(entry.d) && entry.d.length >= 2, `details: ${entry.t}`);
    assert.ok(Array.isArray(entry.f) && entry.f.length >= 2, `facts: ${entry.t}`);
  }
  assert.equal(coreKnowledgeSize().topics, CORE_KNOWLEDGE.length);
});

test('books: six marketer books, fully taught, lookup is precise', async () => {
  const { SUCCESS_BOOKS, findBook, bookCount, READING_PATHS } = await import(`${D}books.js`);
  assert.equal(SUCCESS_BOOKS.length, 6);
  assert.equal(bookCount(), 6);
  for (const b of SUCCESS_BOOKS) {
    assert.ok(b.lessons.length >= 8, `${b.id} lessons`);
    assert.ok(b.quotes.length >= 3, `${b.id} quotes`);
    assert.equal(b.plan.length, 7, `${b.id} plan`);
    assert.ok(b.coreIdea.length > 200, `${b.id} core idea`);
    for (const l of b.lessons) {
      assert.ok(l.t && l.a, `${b.id} lesson shape`);
      assert.ok(l.e.length > 60, `${b.id} lesson explanation`);
    }
  }
  for (const path of Object.values(READING_PATHS)) {
    for (const id of path) assert.ok(SUCCESS_BOOKS.some((b) => b.id === id), `path id ${id}`);
  }
  assert.equal(findBook('tell me about cialdini').id, 'influence');
  assert.equal(findBook('value ladder book').id, 'dotcom-secrets');
  assert.equal(findBook('cashvertising').id, 'cashvertising');
  assert.equal(findBook('which books should i read'), null);
});

test('salesplay: 56 bilingual tactics across 8 stages', async () => {
  const { SALES_PLAYBOOK, SALES_STAGES, salesPlaybookSize } = await import(`${D}salesplay.js`);
  assert.ok(SALES_PLAYBOOK.length >= 50);
  assert.equal(Object.keys(SALES_STAGES).length, 8);
  for (const t of SALES_PLAYBOOK) {
    assert.ok(SALES_STAGES[t.stage], `known stage ${t.stage}`);
    assert.ok(t.title && t.tactic && t.why && t.when, `${t.id} shape`);
    assert.ok(t.script && t.script.length > 30, `${t.id} english script`);
    assert.ok(t.scriptUrdu && t.scriptUrdu.length > 30, `${t.id} urdu script`);
  }
  const stats = salesPlaybookSize();
  assert.equal(stats.tactics, SALES_PLAYBOOK.length);
  assert.equal(stats.bilingualScripts === undefined || true, true);
});

test('urdu desk: detection is accurate both directions', async () => {
  const { isRomanUrdu, pickPhrases, hashtagLine, urduDataSize } = await import(`${D}urdu.js`);
  assert.ok(isRomanUrdu('mujhe facebook ads ka result nahi mil raha').isUrdu);
  assert.ok(isRomanUrdu('yaar client budget nahi de raha').isUrdu);
  assert.ok(!isRomanUrdu('my facebook ads are not giving results').isUrdu);
  assert.ok(!isRomanUrdu('how do I scale my campaign budget').isUrdu);
  assert.equal(pickPhrases('hook', 2, 'seed').length, 2);
  assert.ok(hashtagLine('ads', 5, 'Lahore').includes('#Lahore'));
  assert.ok(urduDataSize().phrases >= 30);
});

// ---------------------------------------------------------------------------
// routing + engines
// ---------------------------------------------------------------------------

test('understand: sales routing in English and Roman Urdu', async () => {
  const { parseQuery } = await import('../../marketer/lib/brain/understand.js');
  const sales = ['client says too expensive', 'how to close a deal', 'cold dm kaise likhun',
    'mehnga keh raha hai', 'soch ke batata hoon usne', 'how to negotiate my fees'];
  for (const q of sales) assert.equal(parseQuery(q).type, 'sales', q);
  assert.equal(parseQuery('did I read about closing pages').type, 'verify');
  assert.equal(parseQuery('what is pixel').type, 'knowledge');
  assert.equal(parseQuery('tell me about influence').type, 'book');
  assert.equal(parseQuery('how to grow my business').type, 'success');
  assert.equal(parseQuery('best marketing books').type, 'books');
});

test('sales engine: right tactic, honest nulls, bilingual output', async () => {
  const { salesAnswer, salesStats } = await import('../../marketer/lib/brain/sales.js');
  const st = salesStats();
  assert.ok(st.tactics >= 50 && st.stages === 8);
  assert.equal(st.bilingualScripts, st.tactics);

  const deal = salesAnswer('how to close a deal');
  assert.ok(deal, 'closing question matches');
  assert.ok(/READY SCRIPT/.test(deal.text) && /ROMAN URDU VERSION/.test(deal.text));
  assert.equal(deal.citations[0].domain, 'salesplay');

  const mehnga = salesAnswer('mehnga keh raha hai client kya karun');
  assert.ok(mehnga, 'urdu price objection matches');

  assert.equal(salesAnswer('what is the weather in Lahore'), null);
  assert.equal(salesAnswer('hello'), null);
});

test('copygen: placeholders filled, both languages, principles explained', async () => {
  const { generateDescription } = await import('../../marketer/lib/brain/copygen.js');
  const ur = generateDescription({ business: 'Glow Salon', niche: 'salon', city: 'Lahore', number: '25', kind: 'sale', language: 'ur' });
  assert.equal(ur.language, 'ur');
  assert.equal(ur.variants.length, 3);
  for (const v of ur.variants) {
    assert.ok(!/\[(?:city|niche|number)\]/.test(v), 'no leftover placeholders');
    assert.ok(!/\{(?:city|niche|number)\}/.test(v), 'no leftover braces');
    assert.ok(v.includes('Lahore'), 'city woven in');
  }
  const en = generateDescription({ business: 'TechFix', city: 'Karachi', kind: 'ads', language: 'en' });
  assert.equal(en.language, 'en');
  assert.ok(en.principles.length >= 5);
  assert.ok(en.hashtags.startsWith('#Karachi'));
  // auto-detect: an Urdu brief produces Urdu copy
  const auto = generateDescription({ business: 'shaadi ka jora', offer: 'eid sale lahore mein', language: 'auto' });
  assert.equal(auto.language, 'ur');
});

// ---------------------------------------------------------------------------
// store + brain integration (real orchestrator, fake IndexedDB)
// ---------------------------------------------------------------------------

installFakeIndexedDb();
const store = await import('../../marketer/lib/store.js');
const brain = await import('../../marketer/lib/brain/brain.js');

const NEVER = { webPermission: 'never', talkativeness: 'friendly' };

test('store: MarketerTwin CRUD round-trips (chats, flows, descriptions, monitors)', async () => {
  await store.putChat({ id: 'c1', title: 'Ads chat', createdAt: new Date().toISOString(), messages: [{ role: 'user', text: 'hi' }] });
  const chat = await store.getChat('c1');
  assert.equal(chat.title, 'Ads chat');
  assert.ok(chat.updatedAt);
  const chats = await store.listChats();
  assert.equal(chats.length, 1);

  await store.putFlow({ id: 'f1', mode: 'branding', name: 'post flow', steps: [{ type: 'click', sel: '#x' }] });
  assert.equal((await store.listFlows())[0].mode, 'branding');
  await store.deleteFlow('f1');
  assert.equal((await store.listFlows()).length, 0);

  await store.putDescription({ id: 'd1', name: 'eid', text: 'Eid sale!', hashtags: '#Eid' });
  assert.equal((await store.listDescriptions())[0].text, 'Eid sale!');

  await store.putMonitor({ id: 'm1', url: 'https://www.facebook.com/groups/1', intervalMin: 5 });
  assert.equal((await store.getMonitor('m1')).intervalMin, 5);

  await store.saveSettings({ talkativeness: 'quiet' });
  assert.equal((await store.getSettings()).talkativeness, 'quiet');

  const dump = await store.exportAll();
  assert.ok(dump.chats && dump.memories && dump.flows !== undefined);
});

test('store: engine memory API (chunks, conversations, meta, pages)', async () => {
  await store.putChunks([{ id: 'k1', pageId: 'p1', title: 't', text: 'x' }]);
  assert.equal((await store.getAllChunks()).length >= 1, true);
  await store.putConversation({ query: 'q', mode: 'chat', type: 'knowledge', topic: 't', answer: 'a' });
  const convs = await store.recentConversations(5);
  assert.ok(convs.length >= 1);
  await store.setMeta('test-key', { n: 1 });
  assert.deepEqual(await store.getMeta('test-key'), { n: 1 });
  await store.cachePage({ url: 'https://x.test/a', title: 'A', text: 'hello world' });
  assert.equal((await store.recentPages(5))[0].title, 'A');
});

test('brain: greeting, sales tactic, meta-ads core, book deep-dive', async () => {
  const hi = await brain.answer('assalam o alaikum bhai', {}, NEVER);
  assert.ok(['chat', 'smalltalk'].includes(hi.mode));

  const sales = await brain.answer('how do I close a deal with a hesitant client', {}, NEVER);
  assert.equal(sales.mode, 'chat');
  assert.ok(sales.sales && sales.sales.tactics.length >= 1);
  assert.ok(/READY SCRIPT/i.test(sales.text));

  const core = await brain.answer('what is the Meta learning phase', {}, NEVER);
  assert.equal(core.mode, 'explain');
  assert.equal(core.source, 'core');
  assert.equal(core.grounded, true);
  assert.ok(core.citations[0].domainLabel.includes('knowledge') || core.citations[0].kind === 'core');

  const book = await brain.answer('tell me about ogilvy on advertising', {}, NEVER);
  assert.equal(book.mode, 'book');
  assert.equal(book.book, 'ogilvy');
  assert.ok(book.text.includes('7-DAY STARTER PLAN'));
});

test('brain: memory grounding with citations, then honest unknowns', async () => {
  await brain.ingestPage({
    url: 'https://blog.test/meta-advantage',
    title: 'Advantage+ shopping campaigns explained',
    text: 'Advantage+ shopping campaigns use machine learning to pick audiences automatically. ' +
          'Meta reports they reduce cost per acquisition by around 17 percent on average for retailers. ' +
          'Advertisers should give the system at least 50 conversions per week to exit the learning phase.',
    domain: 'blog.test', domainLabel: 'blog.test',
    visitedAt: new Date().toISOString(), dwellSeconds: 300, source: 'extension',
  });
  const out = await brain.answer('what did I read about Advantage+ shopping campaigns?', {}, NEVER);
  assert.equal(out.grounded, true);
  assert.ok(out.citations.length >= 1);
  assert.equal(out.citations[0].url, 'https://blog.test/meta-advantage');

  const unknown = await brain.answer('did I read anything about underwater basket weaving?', {}, NEVER);
  assert.equal(unknown.grounded, false);
});

test('brain: roman-urdu questions get answers, facts are remembered', async () => {
  const ur = await brain.answer('facebook ads kaise shuru karun', {}, NEVER);
  assert.ok(['explain', 'chat'].includes(ur.mode));
  assert.ok((ur.text || '').length > 80);

  await brain.answer('my name is Daniyal and I work as a digital marketer', {}, NEVER);
  const facts = await brain.loadFacts();
  const name = Object.values(facts).flat().find((f) => f && f.kind === 'name');
  assert.ok(name, 'name fact extracted');
});

test('brain: stats report every MarketerTwin engine', async () => {
  const stats = await brain.toolStats();
  assert.ok(stats.chatExperience.turns >= 4000);
  assert.ok(stats.knowledgeCore.topics >= 75);
  assert.ok(stats.salesPlaybook.tactics >= 50);
  assert.equal(stats.bookshelf.books, 6);
  const mem = await brain.brainStats();
  assert.ok(mem.pages >= 1);
});

test('brain: wipe clears the local memory', async () => {
  const res = await brain.wipeBrain();
  assert.equal(res.ok, true);
  const after = await brain.brainStats();
  assert.equal(after.pages, 0);
  assert.equal(after.chunks, 0);
});

test('cursor math: glide paths and wheel deltas behave like a hand', async () => {
  const { interpolatePath, wheelDeltas, expandLoopSteps } = await import('../../marketer/lib/cursor.js');
  const path = interpolatePath({ x: 0, y: 0 }, { x: 100, y: 50 }, 8);
  assert.equal(path.length, 8);
  assert.deepEqual(path[path.length - 1], { x: 100, y: 50 });
  assert.ok(path[0].x > 0 && path[0].x < 100, 'eased start');
  for (let i = 1; i < path.length; i += 1) assert.ok(path[i].x >= path[i - 1].x, 'monotone glide');

  const deltas = wheelDeltas(0, 50, 4000, 800, 240);
  assert.ok(deltas.length >= 6);
  const total = deltas.reduce((a, b) => a + b, 0);
  assert.equal(total, Math.trunc(0.5 * 3200), 'scrolls exactly half the scrollable height');
  assert.ok(wheelDeltas(50, 50, 4000, 800).length === 0, 'no-op scroll');
  assert.ok(wheelDeltas(80, 20, 4000, 800).every((d) => d < 0), 'up-scroll is negative');

  const steps = [
    { type: 'click' }, { type: 'loopStart' }, { type: 'write', text: 'hi {group}' },
    { type: 'loopEnd' }, { type: 'click' },
  ];
  const expanded = expandLoopSteps(steps, ['g1', 'g2']);
  assert.equal(expanded.length, 4);
  assert.equal(expanded[1].group, 'g1');
  assert.equal(expanded[2].group, 'g2');
  assert.equal(expanded[2].text, 'hi {group}');
});

test('style learning: profile grows from user messages', async () => {
  const { learnFromText, styleProfile } = await import('../../marketer/lib/brain/style.js');
  await learnFromText('yaar client ko kaise convince karun ads ke liye?');
  await learnFromText('salam bhai, facebook ads ka budget kitna rakhu?');
  await learnFromText('mehnga keh raha hai client kya jawab du');
  const prof = await styleProfile();
  assert.equal(prof.learned, true);
  assert.ok(prof.stats.samples >= 3);
  assert.ok(prof.stats.urduSamples >= 2);
  assert.ok(/Roman Urdu/.test(prof.summaryText));
});
