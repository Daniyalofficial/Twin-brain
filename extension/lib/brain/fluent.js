/**
 * FLUENT — the conversation experience engine.
 *
 * The twin has "done thousands of chats": every user message is matched
 * against the 3,000+ turn experience bank (data/chatcorpus.js) with a BM25
 * index built specifically for CONVERSATION (the page-retrieval index would
 * strip words like "how", "good", "night" — which are exactly the signal in
 * chitchat). The winning intent supplies a fluent, talkative, human-sounding
 * reply — personalised with the user's name, rotated daily so the twin never
 * sounds like a stuck record, and blended with what the twin knows about the
 * user when it knows something.
 *
 * Precision comes from a coverage gate on MEANINGFUL terms: one generic word
 * ("work") inside a knowledge question can never hijack the conversation.
 *
 * Fully offline. No neural net required — retrieval over experience, the same
 * principle that makes a seasoned friend "just know" what to say.
 */

import { CHAT_CORPUS, CORPUS_INTENTS } from './data/chatcorpus.js';
import { stem, tokenize } from './text.js';

/** Light stopwords: conversation lives on words page-retrieval throws away. */
const TINY_STOP = new Set(['a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be',
  'been', 'being', 'i', 'im', 'you', 'to', 'of', 'in', 'on', 'at', 'and', 'or',
  'but', 'for', 'with', 'it', 'its', 'this', 'that', 'me', 'my', 'do', 'does',
  'did', 'so', 'as', 'if', 'we', 'us', 'they', 'them', 'he', 'she', 'his', 'her']);

/** Terms that carry no topical signal — excluded from the coverage math. */
const GENERIC_QUERY = new Set(['what', 'whats', 'how', 'why', 'when', 'who', 'which',
  'tell', 'please', 'can', 'could', 'should', 'would', 'will', 'about', 'some',
  'any', 'know', 'want', 'need', 'get', 'got', 'like', 'just', 'really', 'very',
  'much', 'many', 'hey', 'hi', 'hello', 'ok', 'okay', 'yes', 'no', 'please',
  'there', 'here', 'now', 'then', 'today', 'tomorrow', 'something', 'anything']);

const K1 = 1.4;
const B = 0.72;
const INTENT_BOOST = 2.2;   // the intent name acts like a title

let built = false;
const POSTINGS = new Map();     // stemmed word -> Map(entryIndex -> count)
const DOC_LEN = [];
const INTENT_TOKENS = new Map(); // intent -> Set(stemmed words across its turns)
const BY_INTENT = new Map();
let AVG_LEN = 12;
let TOTAL_LEN = 0;

function ensureIndex() {
  if (built) return;
  CHAT_CORPUS.forEach((entry, i) => {
    const words = tokenize(`${entry.intent.replace(/_/g, ' ')} ${entry.user}`)
      .filter((w) => w.length > 1 && !TINY_STOP.has(w))
      .map(stem)
      .filter((w) => w.length > 1);
    DOC_LEN[i] = words.length;
    TOTAL_LEN += words.length;
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    for (const [w, c] of counts) {
      let postings = POSTINGS.get(w);
      if (!postings) { postings = new Map(); POSTINGS.set(w, postings); }
      postings.set(i, c);
    }
    let list = BY_INTENT.get(entry.intent);
    if (!list) { list = []; BY_INTENT.set(entry.intent, list); }
    list.push(entry);
    let tokens = INTENT_TOKENS.get(entry.intent);
    if (!tokens) { tokens = new Set(); INTENT_TOKENS.set(entry.intent, tokens); }
    for (const w of tokenize(entry.user).filter((x) => x.length > 1 && !TINY_STOP.has(x))) {
      tokens.add(stem(w));
    }
  });
  AVG_LEN = TOTAL_LEN / Math.max(1, CHAT_CORPUS.length);
  built = true;
}

function chatTerms(message) {
  const words = [...new Set(tokenize(String(message || ''))
    .filter((w) => w.length > 1 && !TINY_STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1))];
  return words;
}

/** BM25 over the experience bank; intent-name hits get a title-style boost. */
function searchChat(terms) {
  ensureIndex();
  const N = CHAT_CORPUS.length;
  const scores = new Map();
  const intentWords = new Map(); // entry -> count of terms present in intent name
  for (const term of new Set(terms)) {
    const postings = POSTINGS.get(term);
    if (!postings) continue;
    const df = postings.size;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    if (idf <= 0) continue;
    for (const [i, tf] of postings) {
      const entry = CHAT_CORPUS[i];
      const inIntent = entry.intent.replace(/_/g, ' ').split(/\s+/).map(stem).includes(term);
      const boost = inIntent ? INTENT_BOOST : 1;
      const sat = (tf * K1) / (tf + K1 * (1 - B + B * (DOC_LEN[i] / AVG_LEN)));
      scores.set(i, (scores.get(i) || 0) + idf * sat * boost);
    }
  }
  return scores;
}

/**
 * Match a message against the experience bank.
 * Walks the ranked intents and returns the first whose MEANINGFUL query terms
 * are actually covered — so "how does the zibblewump drive work" can never be
 * answered by the work-venting intent just because both contain "work".
 * @returns {{intent:string, confidence:number, coverage:number, candidates:Array, tag:string}|null}
 */
export function matchExperience(message, { minConfidence = 0.14, minCoverage = 0.5 } = {}) {
  const terms = chatTerms(message);
  if (!terms.length) return null;
  ensureIndex();
  const scores = searchChat(terms);
  if (!scores.size) return null;

  // aggregate per intent: best entry score + support from its runner-ups
  const intentScores = new Map();
  for (const [i, score] of scores) {
    const intent = CHAT_CORPUS[i].intent;
    const prev = intentScores.get(intent) || { total: 0, best: 0 };
    prev.total += score;
    prev.best = Math.max(prev.best, score);
    intentScores.set(intent, prev);
  }
  const ranked = [...intentScores.entries()]
    .map(([intent, s]) => ({ intent, score: s.best + s.total * 0.2 }))
    .sort((a, b) => b.score - a.score);

  const meaningful = terms.filter((t) => !GENERIC_QUERY.has(t));
  const coverageTerms = meaningful.length ? meaningful : terms;

  // Pick the best COVERAGE among the strong candidates, not just the top score:
  // "good night" must land in bye (2/2 words), not late_night (1/2 on "night").
  let best = null;
  for (const candidate of ranked.slice(0, 8)) {
    const confidence = candidate.score / (candidate.score + 2.0);
    if (confidence < minConfidence) break;
    const tokens = INTENT_TOKENS.get(candidate.intent) || new Set();
    const matched = coverageTerms.filter((t) => tokens.has(t)).length;
    const coverage = matched / coverageTerms.length;
    if (coverage < minCoverage) continue;
    const value = coverage + confidence * 0.25;
    if (!best || value > best.value) best = { candidate, confidence, coverage, value };
  }
  if (!best) return null;
  const entries = BY_INTENT.get(best.candidate.intent) || [];
  return {
    intent: best.candidate.intent,
    tag: entries[0] ? entries[0].tag : 'chat',
    confidence: Math.round(Math.min(best.confidence, 0.35 + best.coverage * 0.65) * 100) / 100,
    coverage: Math.round(best.coverage * 100) / 100,
    candidates: entries,
    runnersUp: ranked.filter((r) => r.intent !== best.candidate.intent).slice(0, 2).map((r) => r.intent),
  };
}

/** Deterministic pick so the same message gets a stable-but-varied reply. */
function hashPick(str, n) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // rotate daily so a habitual "good morning" does not repeat verbatim forever
  const day = Math.floor(Date.now() / 86400000);
  return ((h >>> 0) + day) % n;
}

/**
 * Compose a fluent reply for casual/emotional conversation.
 * @param {string} message
 * @param {{name?:string, weave?:string, hook?:string}} ctx
 * @returns {{text:string, intent:string, confidence:number, tag:string}|null}
 */
export function fluentReply(message, ctx = {}) {
  const match = matchExperience(message);
  if (!match || !match.candidates.length) return null;

  const distinctReplies = [...new Set(match.candidates.map((c) => c.assistant))];
  // friends use your name: when we know it, prefer the turns that do
  let pool = distinctReplies;
  if (ctx.name && ctx.name !== 'friend') {
    const withName = distinctReplies.filter((r) => r.includes('{name}'));
    if (withName.length) pool = withName;
  }
  const reply = pool[hashPick(String(message), pool.length)];

  let text = reply.replace(/\{name\}/g, ctx.name && ctx.name !== 'friend' ? ctx.name : 'friend');

  // weave in what we actually know about the user when relevant
  if (ctx.weave && match.tag !== 'farewell' && hashPick(`w${message}`, 3) === 0) {
    text += `\n(${ctx.weave})`;
  }
  if (ctx.hook && hashPick(`h${message}`, 4) === 0) {
    text += ` ${ctx.hook}`;
  }
  return { text, intent: match.intent, confidence: match.confidence, tag: match.tag };
}

/** Rotate a reply from one intent (jokes, facts, riddles…). */
export function pickExperienceReply(intent, message = '') {
  ensureIndex();
  const entries = BY_INTENT.get(intent);
  if (!entries || !entries.length) return null;
  const distinct = [...new Set(entries.map((c) => c.assistant))];
  return distinct[hashPick(message || intent, distinct.length)];
}

export function corpusStats() {
  ensureIndex();
  return {
    turns: CHAT_CORPUS.length,
    intents: CORPUS_INTENTS.length,
    tags: [...new Set(CHAT_CORPUS.map((c) => c.tag))],
  };
}
