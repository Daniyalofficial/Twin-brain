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
import { retrieve, relatedPages, quoteFloor } from './retrieve.js';
import { explain, advice, smalltalk } from './explain.js';
import { parseQuery } from './understand.js';
import {
  displayName, greeting, thinkingNotes, respondToCompliment, respondToThanks,
  questionBack, empathyLine, weaveFacts, hedgeLine, farewell, storyResponse,
} from './persona.js';
import { directAnswer } from './direct.js';
import { detectProvider, streamChat, promptAllowsMemory } from './neural.js';
import {
  buildGrowthPack, growthPackText, rollingSummary, makeStudyPlan, buildModelfile,
} from './growth.js';
import { detectEmotion, tonePlan, storyArc, humorLine } from './emotion.js';
import {
  screenInput, redact, screenLinks, PROFESSIONAL_DISCLAIMER, policyPromptLines,
  CRISIS_RESPONSE,
} from './policy.js';
import { researchLoop } from './research.js';
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
  providerCache: { at: 0, provider: null },
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
// neural provider (real local LLMs) + growth
// ---------------------------------------------------------------------------

const PROVIDER_TTL_MS = 45000;

export async function getProvider(settings, force = false) {
  const now = Date.now();
  if (!force && state.providerCache.provider !== null &&
      now - state.providerCache.at < PROVIDER_TTL_MS) {
    return state.providerCache.provider;
  }
  if (!force && state.providerCache.provider === null &&
      now - state.providerCache.at < 15000) {
    return null;    // negative caching: do not probe Ollama on every message
  }
  let provider = null;
  try { provider = await detectProvider(settings); } catch (error) { void error; }
  state.providerCache = { at: now, provider };
  return provider;
}

export async function neuralStatus(settings) {
  const provider = await getProvider(settings, true);
  return provider
    ? { connected: true, label: provider.label, model: provider.model, kind: provider.kind }
    : { connected: false, label: 'on-device persona engine (no local model detected)' };
}

export async function getGrowthPack(rebuild = false) {
  await ensureLoaded();
  if (!rebuild) {
    const cached = await store.getMeta('growthPack');
    if (cached) return cached;
  }
  const facts = await loadFacts();
  const conversations = await store.recentConversations(60);
  const pack = buildGrowthPack({
    facts, interests: state.interests,
    pages: pagesNow(), conversations,
  });
  await store.setMeta('growthPack', pack);
  return pack;
}

export async function getModelfile(settings = {}) {
  const pack = await getGrowthPack(true);
  const base = settings.ollamaModel && settings.ollamaModel !== 'auto'
    ? String(settings.ollamaModel).split(':')[0]
    : 'llama3.2';
  return buildModelfile(pack, { base });
}

export async function getStudyPlan(topic) {
  const key = `studyPlan:${String(topic || '').toLowerCase().trim()}`;
  return store.getMeta(key);
}

async function maybeStudyPlan(parsed, facts) {
  // "I am learning X" (or a 3+ page interest with no plan) starts a shared plan
  const learning = parsed.factStatements.find((fact) => fact.kind === 'learning');
  if (learning) {
    const topic = learning.value.toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = await getStudyPlan(topic);
    if (!existing) {
      const plan = makeStudyPlan(topic, { pages: pagesNow(), interests: state.interests });
      await store.setMeta(`studyPlan:${topic}`, plan);
      return plan;
    }
    return existing;
  }
  return null;
}

// ---------------------------------------------------------------------------
// answering
// ---------------------------------------------------------------------------

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

export async function answer(query, options = {}, settings = {}, hooks = {}) {
  const note = (text) => {
    if (hooks.progress) { try { hooks.progress(text); } catch (error) { void error; } }
  };
  await ensureLoaded();
  const permission = settings.webPermission || 'ask';
  const talkative = settings.talkativeness !== 'quiet';
  let facts = await loadFacts();
  const history = await store.recentConversations(6);
  const parsed = parseQuery(query, { history, interests: state.interests });
  const name = displayName(facts, settings);

  // --- policy gate: crisis and harm are handled before anything else --------
  const screened = screenInput(parsed.raw);
  if (screened && (screened.action === 'crisis' || screened.action === 'refuse')) {
    await store.putConversation({ query: '[screened by policy]', mode: 'policy',
                                  type: 'policy', topic: '', answer: '' });
    return { mode: 'policy', text: screened.response, grounded: true, citations: [],
             policyAction: screened.action, conversation: { name } };
  }
  const professional = Boolean(screened && screened.action === 'professional');
  const emotion = detectEmotion(parsed.raw);
  const tone = tonePlan(emotion);

  // --- the AI learns what you tell it about yourself, in real time ---------
  let factConfirm = null;
  if (parsed.factStatements.length) {
    await saveFacts(parsed.factStatements);
    facts = await loadFacts();
    factConfirm = parsed.factStatements
      .map((fact) => FACT_CONFIRM[fact.kind] ? FACT_CONFIRM[fact.kind](fact.value) : null)
      .filter(Boolean).join(' ');
    const factValueWords = new Set(parsed.factStatements
      .flatMap((fact) => fact.value.toLowerCase().split(/\W+/)));
    const residual = parsed.topicWords.filter((w) =>
      !factValueWords.has(w) && !FACT_WORDS.has(w));
    if (!parsed.isQuestion && residual.length <= 1) {
      // a pure "remember this" moment — answer like a friend, don't retrieve
      const plan = await maybeStudyPlan(parsed, facts);
      let text = factConfirm;
      if (plan) {
        text += `\n\nI've started a study plan for ${plan.topic} — step 1: ${plan.milestones[0].text} Let's learn together. 📚`;
      }
      if (talkative) text += `\n\n${questionBack(facts, state.interests, parsed)}`;
      await store.putConversation({ query: parsed.raw, mode: 'fact', type: 'fact',
                                    topic: parsed.topicWords.join(' '), answer: text });
      return { mode: 'chat', text, grounded: true, citations: [], followups: [],
               conversation: { name } };
    }
  }

  const stats = await brainStats();

  // --- small talk: greetings, thanks, compliments, goodbyes ----------------
  if (parsed.type === 'smalltalk') {
    let text;
    if (parsed.compliment) text = respondToCompliment(name);
    else if (/\b(thanks|thank you|shukriya)\b/i.test(parsed.raw)) text = respondToThanks(name);
    else if (/\b(bye|goodbye|see you|khuda hafiz|good night)\b/i.test(parsed.raw)) text = farewell(name);
    else if (/^(?:hi|hey|hello|yo|sup|assalam|salam|good (?:morning|afternoon|evening))\b/i.test(parsed.raw)) {
      text = `${greeting(name)} ${statsLine(stats)}`;
    } else {
      text = smalltalk(parsed.raw, stats, state.interests);
    }
    if (emotion.primary === 'joy' && talkative) text += `\n\n${humorLine(parsed.raw)}`;
    if (talkative && !parsed.compliment) text += `\n\n${questionBack(facts, state.interests, parsed)}`;
    await store.putConversation({ query: parsed.raw, mode: 'smalltalk', type: 'smalltalk',
                                  topic: '', answer: text });
    return { mode: 'chat', text, grounded: true, citations: [], followups: [],
             conversation: { name, empathy: empathyLine(parsed.raw) } };
  }

  // --- too vague to answer honestly? ask instead of guessing ---------------
  if (parsed.ambiguous) {
    const chips = state.interests.slice(0, 3)
      .map((interest) => `What do I know about ${interest.topic}?`);
    chips.push('What did I read today?');
    chips.push('What are my top interests?');
    const text = `I want to answer this well${name ? `, ${name}` : ''}, but I need one more word from you: a topic, a site, or a day. What should I look for?`;
    await store.putConversation({ query: parsed.raw, mode: 'clarify', type: 'clarify',
                                  topic: '', answer: text });
    return { mode: 'clarify', text, chips, grounded: true, citations: [] };
  }

  // --- "how big is my brain?" style questions ------------------------------
  if (parsed.type === 'meta') {
    const text = parsed.timeRange
      ? (directAnswer(parsed, { matches: [] }, { pages: pagesNow(), interests: state.interests }) || {}).text || metaAnswer(stats)
      : metaAnswer(stats);
    await store.putConversation({ query: parsed.raw, mode: 'meta', type: 'meta',
                                  topic: '', answer: text });
    return { mode: 'chat', text, grounded: true, citations: [], followups: [],
             conversation: { name } };
  }

  // --- neural provider (real local LLM) + story detection -------------------
  const provider = await getProvider(settings);
  const storyMode = emotion.isStory && !parsed.isQuestion && parsed.type !== 'web';
  if (storyMode && !provider) {
    const arc = storyArc(parsed.raw);
    const text = storyResponse(arc, name, facts, tone);
    await store.putConversation({ query: parsed.raw, mode: 'story', type: 'story',
                                  topic: parsed.topicWords.join(' '), answer: truncate(text, 300) });
    return { mode: 'chat', text, grounded: true, citations: [],
             conversation: { name, emotion: emotion.primary, tone: tone.mood } };
  }

  // --- real-time retrieval with thinking-out-loud --------------------------
  const notes = thinkingNotes(parsed, stats);
  note(notes[0]);
  const effective = parsed.resolvedQuery || query;
  const topK = options.topK || 8;
  const result = retrieve(state.chunks, state.index, effective, { topK });
  note(notes[1] || notes[0]);

  // memory-only question types must never trigger a pointless web search
  const memoryOnly = ['when', 'count', 'which_source', 'verify', 'recap'].includes(parsed.type);

  let webResults = [];
  let usedWeb = false;
  let webDenied = Boolean(options.denied);
  let needsPermission = false;

  const explicitWeb = parsed.type === 'web' || options.useWeb === true;
  if ((!result.grounded && !memoryOnly && !storyMode) || explicitWeb) {
    if (permission === 'never' || webDenied) {
      webDenied = true;
    } else if (permission === 'always' || explicitWeb || options.useWeb === true) {
      note('you said okay — starting live research…');
      const budget = await webBudget(settings);
      let remaining = budget.remaining;
      const research = await researchLoop(effective, {
        search: (q) => searchWeb(q),
        fetchPage: async (result) => {
          const page = await fetchPageText(result.url, 16000);
          return page;
        },
        audit: (entry) => store.addAudit(entry),
        budgetRemaining: () => remaining,
        consumeBudget: async () => { remaining -= 1; await bumpWebBudget(); },
      }, {
        maxHops: Math.max(1, Number(settings.researchHops || 3)),
        interests: state.interests,
        deepRead: settings.webDeepRead !== false,
        note,
      });
      webResults = research.results || [];
      usedWeb = webResults.length > 0;
      if (usedWeb && settings.webDeepRead !== false) {
        for (const deep of webResults.filter((item) => item.deepText).slice(0, 2)) {
          await ingestWebPage(deep, effective);
        }
      }
    } else {
      needsPermission = true;
    }
  }

  // after a permitted deep read, retrieve again so the lesson uses full pages
  const finalResult = usedWeb && settings.webDeepRead !== false
    ? retrieve(state.chunks, state.index, effective, { topK })
    : result;
  note(notes[2] || 'arranging your answer…');

  const conversationBase = {
    name,
    empathy: empathyLine(parsed.raw),
    weave: weaveFacts(facts, parsed.topicWords),
    factConfirm,
    thinking: notes,
    emotion: emotion.primary,
    tone: tone.mood,
  };

  if (needsPermission) {
    const partial = explain({
      query: effective, result: finalResult, webResults: [], usedWeb: false,
      webDenied: false, related: [], interests: state.interests, talkative,
    });
    const direct = directAnswer(parsed, finalResult,
      { pages: pagesNow(), interests: state.interests });
    return {
      mode: 'needs_permission', question: effective, explanation: partial,
      conversation: conversationBase,
      grounded: Boolean(direct && direct.found), citations: [],
    };
  }

  // --- NEURAL PATH: a real local model, grounded in your memory -------------
  if (provider) {
    const pack = await getGrowthPack();
    const summary = rollingSummary(history);
    const messages = buildNeuralMessages({
      parsed, emotion, tone, result: finalResult, webResults, provider, settings,
      pack, summary, history, storyMode, professional, name,
    });
    let text = '';
    try {
      for await (const token of streamChat(provider, messages, { key: settings.openaiKey })) {
        text += token;
        if (hooks.token) { try { hooks.token(token); } catch (error) { void error; } }
      }
    } catch (error) {
      text = '';
      note('the local model hiccuped — answering with my on-device voice…');
    }
    if (text.trim().length > 3) {
      const allowedUrls = finalResult.matches.map((match) => match.url)
        .concat(webResults.map((item) => item.url));
      text = screenLinks(redact(text), allowedUrls);
      if (professional) text += `\n\n${PROFESSIONAL_DISCLAIMER}`;
      const grounded = finalResult.grounded || usedWeb || storyMode;
      if (!grounded) {
        text = `Honest note: this wasn't in your memory, so treat this as general knowledge, not your history.\n\n${text}`;
      }
      const citations = buildNeuralCitations(finalResult, webResults);
      await store.putConversation({
        query: parsed.raw, mode: 'neural', type: parsed.type, grounded,
        topic: parsed.topicWords.join(' '), answer: truncate(text, 300),
      });
      if (talkative) conversationBase.questionBack = questionBack(facts, state.interests, parsed);
      return {
        mode: 'neural', text, citations, grounded, usedWeb, webDenied,
        providerLabel: provider.label, anaphora: parsed.anaphora,
        conversation: conversationBase,
        retrieval: {
          count: finalResult.matches.length, tookMs: finalResult.tookMs,
          bestRelevance: finalResult.bestRelevance, evidence: finalResult.evidence,
          engine: `neural (${provider.label}) + on-device retrieval`,
        },
      };
    }
    // model failed or answered nothing -> fall through to the persona engine
  }

  const related = finalResult.matches[0]
    ? relatedPages(state.chunks, parsed.stemmed.length ? parsed.stemmed : queryTerms(effective),
        finalResult.matches[0].pageId, 3)
        .map((item) => ({ title: item.title, url: item.url,
                          why: `you read this ${item.visitedAgo}` }))
    : [];

  const explanation = explain({
    query: effective, result: finalResult, webResults, usedWeb, webDenied,
    related, interests: state.interests, talkative,
  });

  // direct straight answers for when/how-many/which/did-I/recap/compare
  const direct = directAnswer(parsed, finalResult,
    { pages: pagesNow(), interests: state.interests });
  if (direct) {
    conversationBase.short = direct.text;
    conversationBase.hedge = direct.found ? null : hedgeLine(finalResult.bestRelevance);
    if (direct.citations.length) {
      const seen = new Set(direct.citations.map((c) => c.url));
      const merged = direct.citations.concat(
        explanation.citations.filter((c) => !seen.has(c.url)));
      merged.forEach((c, i) => { c.n = i + 1; });
      explanation.citations = merged;
    }
  } else {
    conversationBase.hedge = hedgeLine(finalResult.bestRelevance);
  }

  let adviceText = null;
  if (parsed.type === 'advice') {
    adviceText = advice(effective, state.interests, finalResult.matches);
  }

  if (talkative) conversationBase.questionBack = questionBack(facts, state.interests, parsed);

  const grounded = explanation.grounded || Boolean(direct && direct.found);
  await store.putConversation({
    query: parsed.raw, mode: parsed.type, type: parsed.type, grounded,
    topic: parsed.topicWords.join(' '),
    answer: (direct && direct.text) || explanation.simple || adviceText || '',
  });

  return {
    mode: parsed.type === 'advice' ? 'advice' : 'explain',
    adviceText,
    explanation,
    conversation: conversationBase,
    grounded,
    citations: explanation.citations,
    usedWeb,
    webDenied,
    anaphora: parsed.anaphora,
    retrieval: {
      count: finalResult.matches.length, tookMs: finalResult.tookMs,
      bestRelevance: finalResult.bestRelevance, evidence: finalResult.evidence,
      engine: 'on-device hybrid (hash-v1 + BM25)',
    },
  };
}

function statsLine(stats) {
  if (!stats.pages) return 'Your memory is empty so far — browse anything for a few seconds and I\'ll start learning you.';
  return `Right now I hold ${stats.pages} page(s) and ${stats.visits || 0} visit(s) of your reading` +
    (state.interests.length ? `, and your big theme lately is ${state.interests[0].topic}.` : '.');
}

// --- personal facts: stored in IndexedDB meta, never leave the browser -------

const FACT_WORDS = new Set(['name', 'is', 'am', 'live', 'work', 'working', 'goal',
  'dream', 'aim', 'plan', 'love', 'like', 'hate', 'dislike', 'learning', 'studying',
  'remember', 'call', 'called', 'my', 'me']);

const FACT_CONFIRM = {
  name: (v) => `${v} — got it! I'll remember that (only inside this browser, like everything else).`,
  learning: (v) => `Noted: you're learning ${v}. I'll angle my explanations toward that.`,
  likes: (v) => `Okay, you love ${v} — filed under "things that make you happy".`,
  dislikes: (v) => `Understood — ${v} is not your thing. I'll keep it in mind.`,
  job: (v) => `Got it, you work as ${v}. I'll make answers useful for that.`,
  lives: (v) => `Noted: you live in ${v}. (Stays in this browser, always.)`,
  goal: (v) => `Your goal — ${v}. I'll quietly root for it in every answer.`,
  note: (v) => `Remembered: "${truncate(v, 80)}". Ask me about it anytime.`,
};

export async function loadFacts() {
  const rows = await store.getAllMeta();
  const facts = { notes: [] };
  for (const row of rows) {
    const key = String(row.key || '');
    if (!key.startsWith('fact:') || !row.value) continue;
    const fact = row.value;
    if (fact.kind === 'note') facts.notes.push(fact);
    else facts[fact.kind] = fact;
  }
  return facts;
}

export async function saveFacts(statements) {
  for (const fact of statements) {
    const key = fact.kind === 'note'
      ? `fact:note:${Date.now()}`
      : `fact:${fact.kind}`;
    await store.setMeta(key, { kind: fact.kind, value: fact.value,
                               at: new Date().toISOString() });
  }
  return statements.length;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function ingestWebPage(result, topic) {
  try {
    const url = new URL(result.url);
    await ingestPage({
      url: result.url,
      title: result.deepTitle || result.title,
      text: result.deepText,
      domain: url.hostname,
      domainLabel: url.hostname.replace(/^www\./, ''),
      visitedAt: new Date().toISOString(),
      dwellSeconds: 0,
      source: 'web_enrichment',
    });
    await store.addAudit({ kind: 'deep_read', query: topic, provider: result.url, status: 'stored' });
    return true;
  } catch (error) {
    await store.addAudit({ kind: 'deep_read', query: topic, provider: result.url,
                           status: `error: ${String(error.message).slice(0, 100)}` });
    return null;
  }
}

function buildNeuralCitations(result, webResults) {
  const floor = quoteFloor(result.bestRelevance);
  const citations = [];
  result.matches.filter((match) => match.scores.relevance >= floor).slice(0, 6)
    .forEach((match, i) => citations.push({
      n: i + 1, kind: 'memory', title: match.title, url: match.url,
      domain: match.domainLabel || match.domain, when: match.visitedAgo,
      dwell: match.dwellSeconds,
    }));
  (webResults || []).slice(0, 5).forEach((item) => citations.push({
    n: citations.length + 1, kind: 'web', title: item.title, url: item.url,
    domain: domainOf(item.url), when: 'fetched now', snippet: item.snippet,
  }));
  return citations;
}

function buildNeuralMessages(input) {
  const {
    parsed, emotion, tone, result, webResults, provider, settings,
    pack, summary, history, storyMode, professional, name,
  } = input;
  const system = [];
  const owner = name ? `${name}'s` : "the user's";
  system.push(`You are Twin-Brain, ${owner} personal AI twin: a warm, talkative, honest friend and a gifted teacher living inside their browser extension. You know them through everything they read, which the extension retrieves for you below.`);
  system.push('', 'POLICIES (never break these):');
  system.push(policyPromptLines().join('\n'));
  const profile = growthPackText(pack);
  if (profile) {
    system.push('', 'USER PROFILE (grown from their daily reading and chats — this is who you are talking to):');
    system.push(profile);
  }
  if (summary) {
    system.push('', 'LONG-TERM CHAT MEMORY:', summary);
  }
  system.push('', 'CURRENT EMOTIONAL READ:',
    `detected: ${emotion.primary || 'neutral'} (intensity ${emotion.intensity}). ${tone.instruction}`);
  if (storyMode) {
    system.push('The user just shared a personal story. Respond like a close friend: acknowledge the feelings, reflect what you heard, ask ONE gentle question. Advice only if they asked for it.');
  }
  if (professional) {
    system.push('This touches health, money or law: keep everything general and encourage consulting a real professional. The app appends the disclaimer itself.');
  }

  const memoryOk = promptAllowsMemory(provider, settings);
  const floor = quoteFloor(result.bestRelevance);
  const cited = result.matches.filter((match) => match.scores.relevance >= floor).slice(0, 5);
  if (memoryOk && cited.length) {
    system.push('', 'MEMORY (retrieved from pages the user actually read — cite with [n] when you use one):');
    cited.forEach((match, i) => {
      system.push(`[${i + 1}] “${truncate(match.title, 90)}” — ${match.domainLabel || match.domain}, visited ${match.visitedAgo}, ${Math.round((match.dwellSeconds || 0) / 60)}m on page.`);
      const body = ((match.sentences && match.sentences.length) ? match.sentences.join(' ') : (match.text || '')).slice(0, 700);
      system.push(`    ${body}`);
    });
  } else if (!memoryOk) {
    system.push('', 'PRIVACY: this provider is remote and the user has NOT allowed their private memory to leave the machine. Do not claim knowledge of their browsing; answer generally or ask them to paste the details.');
  } else {
    system.push('', 'MEMORY: retrieval found nothing solid for this question. Say plainly that it is not in their reading history, then answer from general knowledge — never invent memories, pages or dates.');
  }
  if (webResults && webResults.length) {
    system.push('', "WEB (fetched live with the user's permission — cite with [Wn]):");
    webResults.slice(0, 5).forEach((item, i) => {
      system.push(`[W${i + 1}] “${truncate(item.title, 90)}” — ${item.url}`);
      system.push(`    ${truncate(item.deepText || item.snippet || '', 600)}`);
    });
  }
  system.push('', 'ANSWER FORMAT: plain conversational text (no markdown headers). Simple words first, then depth. Translate jargon on the spot. End with one friendly question when it feels natural.');

  const messages = [{ role: 'system', content: system.join('\n') }];
  for (const turn of (history || []).slice(-6)) {
    if (turn.query) messages.push({ role: 'user', content: truncate(turn.query, 300) });
    if (turn.answer) messages.push({ role: 'assistant', content: truncate(turn.answer, 400) });
  }
  messages.push({ role: 'user', content: redact(parsed.raw) });
  return messages;
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
  await getGrowthPack(true);           // the twin grows every night
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
