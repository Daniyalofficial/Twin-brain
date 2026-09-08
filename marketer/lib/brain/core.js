/**
 * CORE — the twin's built-in knowledge engine, offline and self-contained:
 *
 *  1. KNOWLEDGE CORE: 80 curated marketing topics (Meta Ads, campaigns,
 *     tracking, analytics, creative, copywriting, funnels, sales, branding,
 *     content, psychology, local business, freelancing) retrieved with the same BM25 machinery as the user's
 *     memory. Answers from here are ALWAYS cited as "knowledge core" — never
 *     dressed up as something the user read. The honesty contract stands.
 *
 *  2. ENGLISH TOOL: pocket dictionary (definition + synonyms + example),
 *     idioms, misspelling repair, grammar fixing WITH explanations, sentence
 *     upgrading, and a word-of-the-day rotation.
 *
 *  3. BOOKSHELF: the six must-read marketer books (persuasion, advertising,
 *     branding, funnels, selling, copywriting), taught from original full
 *     explanations — core idea, every lesson with an action step, a seven-day
 *     plan, reading paths by ambition.
 */

import { CORE_KNOWLEDGE, CORE_CATEGORIES } from './data/corekb.js';
import { SUCCESS_BOOKS, READING_PATHS, findBook } from './data/books.js';
import { DICTIONARY, IDIOMS, TYPOS, UPGRADES } from './data/english.js';
import { LexicalIndex } from './lexical.js';
import { queryTerms, stem } from './text.js';

// ---------------------------------------------------------------------------
// 1. knowledge core
// ---------------------------------------------------------------------------

let coreIndex = null;

function ensureCoreIndex() {
  if (coreIndex) return coreIndex;
  coreIndex = new LexicalIndex();
  CORE_KNOWLEDGE.forEach((entry, i) => {
    const doc = `${entry.t} ${entry.a.join(' ')} ${entry.s} ${entry.d.join(' ')} ${entry.f.join(' ')}`;
    coreIndex.add(`k${i}`, entry.t, doc);
  });
  return coreIndex;
}

/**
 * Retrieve knowledge-core entries for a query.
 * @returns {{entries:Array, confidence:number}}
 */
export function coreRetrieve(query, { topK = 3, minScore = 1.8 } = {}) {
  const terms = queryTerms(String(query || ''));
  if (!terms.length) return { entries: [], confidence: 0 };
  const idx = ensureCoreIndex();
  const scores = idx.search(terms, 12);
  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ entry: CORE_KNOWLEDGE[Number(id.slice(1))], score }))
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.score >= minScore && anchored(r.entry, terms))
    .slice(0, topK);
  if (!ranked.length) return { entries: [], confidence: 0 };
  const confidence = Math.min(1, ranked[0].score / 8);
  return { entries: ranked.map((r) => r.entry), confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Precision anchor: a core entry may answer only when a MEANINGFUL query term
 * (length >= 4, stemmed, not a generic verb) appears in its topic or aliases.
 * This kills prefix-variant noise — "bread" must not answer via "breathing",
 * and "how does X work" must not answer via every entry aliased "how X works".
 */
const GENERIC_ANCHOR_BAN = new Set([
  'work', 'works', 'working', 'make', 'makes', 'made', 'use', 'uses', 'used',
  'help', 'need', 'needs', 'want', 'wants', 'get', 'gets', 'way', 'ways',
  'thing', 'things', 'stuff', 'lot', 'tell', 'know', 'knows', 'good', 'best',
  'new', 'day', 'days', 'time', 'times', 'people', 'person', 'life', 'live',
  'start', 'starts', 'build', 'builds', 'learn', 'learns', 'give', 'gives',
]);

function anchored(entry, terms) {
  const anchorWords = new Set(
    `${entry.t} ${entry.a.join(' ')}`.toLowerCase().split(/[^a-z0-9+]+/).map(stem).filter(Boolean)
  );
  return terms.some((term) => {
    if (term.length < 4) return false;
    const stemmed = stem(term);
    if (GENERIC_ANCHOR_BAN.has(stemmed) || GENERIC_ANCHOR_BAN.has(term)) return false;
    return anchorWords.has(stemmed);
  });
}

/**
 * Compose a teacher-style explanation object from the knowledge core,
 * shaped exactly like explain.js output so the UI needs no special case.
 */
export function coreExplain(query, { name = 'friend' } = {}) {
  name = name || 'friend';
  const { entries, confidence } = coreRetrieve(query);
  if (!entries.length) return null;
  const primary = entries[0];
  const label = CORE_CATEGORIES[primary.c] || 'General knowledge';

  const citations = entries.map((entry, i) => ({
    n: i + 1,
    title: `${entry.t} — ${label}`,
    url: '',
    domain: 'knowledge core',
    domainLabel: 'knowledge core',
    kind: 'core',
    when: 'built-in knowledge',
    quote: entry.s.slice(0, 160),
  }));

  const points = primary.d.map((line) => line);
  const detail = primary.f.map((fact) => fact);

  // related topics from the same category make natural further reading
  const further = entries.slice(1).map((entry) => ({
    title: entry.t, url: '', why: `also in my knowledge core (${CORE_CATEGORIES[entry.c] || entry.c})`,
  }));

  const opener = confidence > 0.6
    ? `Good question — this one I know well. From my built-in knowledge core (${label}):`
    : `Let me answer from my knowledge core — the general knowledge I carry offline (${label}):`;

  return {
    mode: 'explain',
    grounded: true,
    source: 'core',
    confidence,
    opener,
    simple: primary.s,
    points,
    detail,
    honesty: 'This comes from my built-in knowledge core — general knowledge I carry offline, NOT from pages you read. Your memory stays the source of truth about you; if you want fresh or deeper sources, allow me a web search.',
    closing: `Want me to go deeper on ${primary.t}, connect it to something you have read, or find fresher info online (only if you allow it)?`,
    citations,
    webNotes: [],
    further,
    followups: [
      `Explain ${primary.t} like I am five`,
      `More facts about ${primary.t}`,
      primary.d.length > 1 ? `What is the most surprising part of ${primary.t}?` : `What should I read next about ${primary.t}?`,
    ],
  };
}

export function coreStats() {
  return { topics: CORE_KNOWLEDGE.length, categories: Object.keys(CORE_CATEGORIES) };
}

// ---------------------------------------------------------------------------
// 2. English tool
// ---------------------------------------------------------------------------

const DICT_BY_WORD = new Map(DICTIONARY.map((row) => [row[0].toLowerCase(), row]));
const DICT_BY_STEM = new Map();
for (const row of DICTIONARY) {
  const s = stem(row[0].toLowerCase());
  if (!DICT_BY_STEM.has(s)) DICT_BY_STEM.set(s, row);
}
const IDIOM_BY_KEY = new Map(IDIOMS.map((row) => [row[0].toLowerCase(), row]));

/** Define a word or idiom: meaning + synonyms + example, or honest miss. */
export function defineWord(raw) {
  const q = String(raw || '').toLowerCase().trim();
  if (!q) return null;
  // idiom first (multi-word)
  const idiom = IDIOM_BY_KEY.get(q) ||
    IDIOMS.find((row) => q.includes(row[0]) || row[0].includes(q));
  if (idiom) {
    return {
      kind: 'idiom', word: idiom[0],
      text: `"${idiom[0]}" is an idiom — it means: ${idiom[1]}.\n` +
            `Example: "${idiom[2]}"\n` +
            `Idioms never translate word-for-word; learn them whole, like songs. Want another one, or the literal story behind this?`,
    };
  }
  const target = q.split(/\s+/).pop(); // "meaning of resilience" → resilience
  const row = DICT_BY_WORD.get(target) || DICT_BY_STEM.get(stem(target)) ||
    DICTIONARY.find((r) => r[0].startsWith(target.slice(0, 4)) && target.length >= 4);
  if (!row) {
    return {
      kind: 'miss', word: target,
      text: `"${target}" is not in my pocket dictionary yet — it holds the ${DICTIONARY.length} words that matter most, from everyday to advanced. ` +
            `Two honest options: allow me a quick web search for a full definition, or ask me for a word from a specific theme (emotions, money, study, character) and I will teach it properly.`,
    };
  }
  return {
    kind: 'word', word: row[0],
    text: `${row[0]} (${row[1]}) — ${row[2]}.\n` +
          `Synonyms: ${row[3]}.\n` +
          `In a sentence: "${row[4]}"\n` +
          `Tip: use it once today and it is yours forever. Want a practice sentence checked, or a related word?`,
  };
}

/** Synonyms for a word. */
export function synonymsFor(raw) {
  const q = String(raw || '').toLowerCase().trim();
  const target = q.replace(/^.*?\bsynonyms?\s+(?:for|of)\s+/, '').split(/\s+/).pop();
  const row = DICT_BY_WORD.get(target) || DICT_BY_STEM.get(stem(target));
  if (!row) return null;
  return {
    word: row[0],
    text: `Instead of "${row[0]}", you can say: ${row[3]}.\n` +
          `Quick meaning so you pick the right one: ${row[2]}.\n` +
          `Example: "${row[4]}" Want me to upgrade a full sentence of yours with one of these?`,
  };
}

/** Grammar rules: [regex, replacement, explanation]. Conservative and explained. */
const GRAMMAR_RULES = [
  [/\b(he|she|it)\s+dont\b/gi, "$1 doesn't", "he/she/it take 'doesn't', not 'don't'"],
  [/\bdont\b/gi, "don't", "contractions keep their apostrophe: don't"],
  [/\bcant\b/gi, "can't", "contractions keep their apostrophe: can't"],
  [/\bwont\b/gi, "won't", "contractions keep their apostrophe: won't"],
  [/\bdidnt\b/gi, "didn't", "contractions keep their apostrophe: didn't"],
  [/\bdoesnt\b/gi, "doesn't", "contractions keep their apostrophe: doesn't"],
  [/\bisnt\b/gi, "isn't", "contractions keep their apostrophe: isn't"],
  [/\barent\b/gi, "aren't", "contractions keep their apostrophe: aren't"],
  [/\bim\b/gi, "I'm", "contractions keep their apostrophe: I'm"],
  [/\bive\b/gi, "I've", "contractions keep their apostrophe: I've"],
  [/\bi\b/g, 'I', 'the pronoun "I" is always capitalised'],
  [/\bi'm\b/gi, "I'm", '"I" is capitalised even inside contractions'],
  [/\bi\s+(?:am|'m)\s+go\b(?!ing)/gi, 'I am going', "after am/is/are use the -ing form: 'I am going', never 'I am go'"],
  [/\bhe\s+don't\b/gi, "he doesn't", "he/she/it take 'doesn't', not 'don't'"],
  [/\bshe\s+don't\b/gi, "she doesn't", "he/she/it take 'doesn't', not 'don't'"],
  [/\bit\s+don't\b/gi, "it doesn't", "he/she/it take 'doesn't', not 'don't'"],
  [/\bthey\s+is\b/gi, 'they are', "'they' takes 'are'"],
  [/\bwe\s+is\b/gi, 'we are', "'we' takes 'are'"],
  [/\byou\s+is\b/gi, 'you are', "'you' always takes 'are'"],
  [/\bhe\s+have\b/gi, 'he has', "he/she/it take 'has'"],
  [/\bshe\s+have\b/gi, 'she has', "he/she/it take 'has'"],
  [/\bit\s+have\b/gi, 'it has', "he/she/it take 'has'"],
  [/\bhe\s+(?:go|eat|play|work|study|want|need|like|love)\b(?!s)/gi, (m) => `${m.split(/\s+/)[0]} ${m.split(/\s+/)[1]}s`, 'present simple: he/she/it verbs take -s ("he goes", "she works")'],
  [/\bshe\s+(?:go|eat|play|work|study|want|need|like|love)\b(?!s)/gi, (m) => `${m.split(/\s+/)[0]} ${m.split(/\s+/)[1]}s`, 'present simple: he/she/it verbs take -s'],
  [/\bdidn't\s+went\b/gi, "didn't go", "after didn't, use the base form of the verb"],
  [/\bdidn't\s+ate\b/gi, "didn't eat", "after didn't, use the base form"],
  [/\bdidn't\s+saw\b/gi, "didn't see", "after didn't, use the base form"],
  [/\bdon't\s+went\b/gi, "don't go", "after don't, use the base form"],
  [/\bcan\s+to\b/gi, 'can', "'can' is followed by the bare verb, never 'to'"],
  [/\bmust\s+to\b/gi, 'must', "'must' is followed by the bare verb"],
  [/\bshould\s+of\b/gi, 'should have', "'should have' (or shouldn't), never 'of' — the confusion comes from the sound of 'should've'"],
  [/\bwould\s+of\b/gi, 'would have', "'would have', never 'would of'"],
  [/\bcould\s+of\b/gi, 'could have', "'could have', never 'could of'"],
  [/\bgoed\b/gi, 'went', "'go' is irregular: go → went → gone"],
  [/\bcomed\b/gi, 'came', "'come' is irregular: come → came → come"],
  [/\bteached\b/gi, 'taught', "'teach' is irregular: teach → taught"],
  [/\bbuyed\b/gi, 'bought', "'buy' is irregular: buy → bought"],
  [/\beated\b/gi, 'ate', "'eat' is irregular: eat → ate → eaten"],
  [/\bfeeled\b/gi, 'felt', "'feel' is irregular: feel → felt"],
  [/\bsleeped\b/gi, 'slept', "'sleep' is irregular: sleep → slept"],
  [/\bcatched\b/gi, 'caught', "'catch' is irregular: catch → caught"],
  [/\bbringed\b/gi, 'brought', "'bring' is irregular: bring → brought"],
  [/\bthinked\b/gi, 'thought', "'think' is irregular: think → thought"],
  [/\bmore\s+better\b/gi, 'better', "'better' is already comparative — never 'more better'"],
  [/\bmore\s+easier\b/gi, 'easier', "'easier' is already comparative"],
  [/\bpeoples\b/gi, 'people', "'people' is already plural (one person, many people)"],
  [/\bchilds\b/gi, 'children', "the plural of 'child' is 'children'"],
  [/\bfoot\s*s\b/gi, 'feet', "the plural of 'foot' is 'feet'"],
  [/\bmouses\b/gi, 'mice', "the plural of 'mouse' (the animal) is 'mice'"],
  [/\binformations\b/gi, 'information', "'information' is uncountable — no plural, no 'an'"],
  [/\badvices\b/gi, 'advice', "'advice' is uncountable — say 'a piece of advice' if you need one"],
  [/\bfurnitures\b/gi, 'furniture', "'furniture' is uncountable"],
  [/\bknowledges\b/gi, 'knowledge', "'knowledge' is uncountable"],
  [/\bsoftwares\b/gi, 'software', "'software' is uncountable"],
  [/\byour\s+welcome\b/gi, "you're welcome", "'you're' = you are; 'your' = belonging to you"],
  [/\bits\s+a\s+(?:own|opinion)\b/gi, "it's a $1", "'it's' = it is; 'its' = belonging to it"],
  [/\bthier\b/gi, 'their', "'their' = belonging to them"],
  [/\bthere\s+is\s+many\b/gi, 'there are many', "'many' takes 'are', not 'is'"],
  [/\bhere\s+is\s+many\b/gi, 'here are many', "'many' takes 'are'"],
  [/\bdiscuss\s+about\b/gi, 'discuss', "'discuss' already contains 'about' — just discuss something"],
  [/\breturn\s+back\b/gi, 'return', "'return' already means go back"],
  [/\brepeat\s+again\b/gi, 'repeat', "'repeat' already means say again"],
  [/\border\s+(?:for|a)\b(?=\s+(?:coffee|tea|pizza|burger|food))/gi, 'order', "'order' needs no extra preposition here"],
  [/\bone\s+of\s+my\s+(?:friend|book|thing|day|reason)\b/gi, (m) => `${m} s→ check plural`, 'after "one of", the noun is plural: "one of my friends"'],
  [/\bmy\s+all\s+/gi, 'all my', 'the order is "all my friends", not "my all friends"'],
  [/\btoo\s+much\s+(?:good|happy|nice|beautiful)\b/gi, (m) => m.replace(/too much/i, 'very'), '"too much" means more than wanted; for positive intensity use "very"'],
];

/** Article rule needs care with silent-h exceptions, so it lives in code. */
const AN_BEFORE = /^(hour|honest|honor|honour|heir)(?:s|ly|est|ed)?\b/i;
const A_BEFORE = /^(uni|use|user|usual|europe|one|once|eu)\w*/i;

function fixArticles(text) {
  const changes = [];
  let out = text.replace(/\ba\s+([aeiouAEIOU]\w*)/g, (m, word) => {
    if (A_BEFORE.test(word)) return m; // a university, a one-rupee note
    changes.push({ from: m, to: `an ${word}`, why: "'an' is used before a vowel SOUND" });
    return `an ${word}`;
  });
  out = out.replace(/\ban\s+([^aeiouAEIOU\s]\w*)/g, (m, word) => {
    if (AN_BEFORE.test(word)) return m; // an hour, an honest man
    changes.push({ from: m, to: `a ${word}`, why: "'a' is used before a consonant SOUND (including a 'yoo' sound)" });
    return `a ${word}`;
  });
  return { text: out, changes };
}

function fixTypos(text) {
  const changes = [];
  const out = text.replace(/\b([A-Za-z]+)\b/g, (m) => {
    const lower = m.toLowerCase();
    if (TYPOS[lower]) {
      const fix = TYPOS[lower];
      changes.push({ from: m, to: fix, why: 'common misspelling' });
      return m[0] === m[0].toUpperCase() ? fix.charAt(0).toUpperCase() + fix.slice(1) : fix;
    }
    return m;
  });
  return { text: out, changes };
}

/**
 * Fix grammar/spelling with per-change explanations.
 * @returns {{fixed:string, changes:Array, upgraded:string|null}}
 */
export function fixGrammar(raw) {
  let text = String(raw || '');
  if (!text.trim()) return null;
  const changes = [];

  const typoPass = fixTypos(text);
  text = typoPass.text;
  changes.push(...typoPass.changes);

  for (const [re, replacement, why] of GRAMMAR_RULES) {
    const before = text;
    if (typeof replacement === 'function') {
      text = text.replace(re, (m, ...rest) => {
        const out = replacement(m, ...rest);
        if (out !== m) changes.push({ from: m, to: out, why });
        return out;
      });
    } else {
      text = text.replace(re, replacement);
    }
    if (text !== before && typeof replacement === 'string') {
      changes.push({ from: String(re).slice(0, 0) || 'pattern', to: replacement, why });
    }
  }

  const articlePass = fixArticles(text);
  text = articlePass.text;
  changes.push(...articlePass.changes);

  // capitalise sentence starts
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());

  // dedupe changes
  const seen = new Set();
  const unique = changes.filter((c) => {
    const key = `${c.from}→${c.to}`;
    if (seen.has(key) || c.from === c.to) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);

  return { fixed: text.trim(), changes: unique, upgraded: null };
}

/** Upgrade weak phrasing into stronger vocabulary. */
export function improveSentence(raw) {
  const base = fixGrammar(raw);
  if (!base) return null;
  let upgraded = base.fixed;
  const swaps = [];
  for (const [weak, strong] of UPGRADES) {
    const re = new RegExp(`\\b${weak}\\b`, 'gi');
    if (re.test(upgraded)) {
      upgraded = upgraded.replace(re, (m) => {
        swaps.push(`${m} → ${strong}`);
        return m[0] === m[0].toUpperCase() ? strong.charAt(0).toUpperCase() + strong.slice(1) : strong;
      });
      if (swaps.length >= 3) break;
    }
  }
  return { ...base, upgraded: swaps.length ? upgraded : null, swaps };
}

/** Compose the full English-tool answer for a parsed query. */
export function englishToolAnswer(parsed, raw) {
  const message = String(raw || parsed.raw || '');
  if (parsed.type === 'define') {
    const target = message
      .replace(/^(what\s+(?:does|do|is)|who\s+is|define|meaning\s+of|what'?s\s+the\s+meaning\s+of)\s+/i, '')
      .replace(/[?.!]+$/g, '').replace(/\s+(mean|means|in english)\s*$/i, '').trim();
    const result = defineWord(target);
    if (!result) return null;
    return { mode: 'chat', kind: 'english', text: result.text, tool: result };
  }
  if (parsed.type === 'word') {
    if (/\b(antonym|opposite)\b/i.test(message)) {
      // honest: we carry synonyms richly; antonyms only implicitly
      const syn = synonymsFor(message);
      if (syn) {
        return { mode: 'chat', kind: 'english',
                 text: `My pocket dictionary is organised by meaning, so here is the word family for "${syn.word}": ${syn.text}` };
      }
    }
    const syn = synonymsFor(message);
    if (syn) return { mode: 'chat', kind: 'english', text: syn.text, tool: syn };
    return null;
  }
  if (parsed.type === 'grammar') {
    // extract the text to fix: after "correct this:" / quotes / the whole message
    let target = message
      .replace(/^(correct|fix|check|improve|rewrite|grammar[- ]check)\s*(this|it|my\s+\w+)?\s*[:,-]?\s*/i, '')
      .trim();
    const quoted = target.match(/["“”']([^"“”']{3,})["“”']/);
    if (quoted) target = quoted[1];
    if (!target || target.split(/\s+/).length < 2) {
      return { mode: 'chat', kind: 'english',
               text: 'Send me the full sentence or paragraph you want checked — paste it after "correct this:" and I will fix it line by line AND explain every change so the mistake dies forever. What have you got?' };
    }
    const result = improveSentence(target);
    if (!result) return null;
    const lines = [`Original: "${target}"`, `Corrected: "${result.fixed}"`];
    if (result.changes.length) {
      lines.push('What changed and why:');
      result.changes.forEach((c) => lines.push(`• "${c.to}" — ${c.why}`));
    } else {
      lines.push('No grammar or spelling issues found — that is clean English. Nicely done.');
    }
    if (result.upgraded) {
      lines.push(`Stronger version: "${result.upgraded}"`);
      if (result.swaps && result.swaps.length) lines.push(`Word upgrades: ${result.swaps.join(', ')} — precise words sound confident.`);
    }
    lines.push('Want to try another sentence, or shall I give you a practice sentence for this exact rule?');
    return { mode: 'chat', kind: 'english', text: lines.join('\n'), tool: result };
  }
  return null;
}

/** Word of the day: deterministic rotation over the dictionary. */
export function wordOfTheDay() {
  const day = Math.floor(Date.now() / 86400000);
  const row = DICTIONARY[day % DICTIONARY.length];
  return {
    word: row[0],
    text: `Word of the day: ${row[0]} (${row[1]}) — ${row[2]}.\nSynonyms: ${row[3]}.\nExample: "${row[4]}"\nUse it once today and it is yours. Want me to build you a practice sentence?`,
  };
}

export function englishStats() {
  return { words: DICTIONARY.length, idioms: IDIOMS.length, typos: Object.keys(TYPOS).length,
           grammarRules: GRAMMAR_RULES.length, upgrades: UPGRADES.length };
}

// ---------------------------------------------------------------------------
// 3. the bookshelf
// ---------------------------------------------------------------------------

/** Deep-dive a single book with full explanation. */
export function bookExplain(bookId) {
  const book = SUCCESS_BOOKS.find((b) => b.id === bookId) || findBook(bookId);
  if (!book) return null;
  const lines = [];
  lines.push(`"${book.title}" — ${book.author} (${book.year}).`);
  lines.push(`In one line: ${book.oneLine}`);
  lines.push('');
  lines.push(`WHY THIS BOOK MATTERS: ${book.why}`);
  lines.push('');
  lines.push(`THE CORE IDEA: ${book.coreIdea}`);
  lines.push('');
  lines.push('THE LESSONS, EXPLAINED:');
  book.lessons.forEach((lesson, i) => {
    lines.push(`${i + 1}. ${lesson.t}`);
    lines.push(`   ${lesson.e}`);
    lines.push(`   → Action: ${lesson.a}`);
  });
  lines.push('');
  lines.push('WISDOM WORTH STEALING (paraphrased):');
  book.quotes.forEach((q) => lines.push(`• "${q}"`));
  lines.push('');
  lines.push('YOUR 7-DAY STARTER PLAN:');
  book.plan.forEach((day) => lines.push(`• ${day}`));
  lines.push('');
  lines.push(`Who this book is for: ${book.who}`);
  lines.push(`(This is my own full explanation, taught from my built-in bookshelf — when you are ready, read the original; it is worth every page.)`);
  return { mode: 'book', text: lines.join('\n'), book };
}

/** The shelf answer: the marketer's six must-reads + a reading path by ambition. */
export function bookshelf(query = '', { name = 'friend' } = {}) {
  name = name || 'friend';
  const q = String(query || '').toLowerCase();
  let pathKey = 'default';
  if (/sell|sale|sales|client|closing|objection|negotiat|freelanc|agency|pitch/.test(q)) pathKey = 'sales';
  else if (/brand|positioning|personal brand|identity|voice/.test(q)) pathKey = 'branding';
  else if (/copy|copywriting|caption|headline|writing|ad text/.test(q)) pathKey = 'copywriting';
  else if (/funnel|landing|lead magnet|value ladder|online sales|ecommerce|e-commerce/.test(q)) pathKey = 'funnels';
  const path = (READING_PATHS[pathKey] || READING_PATHS.default)
    .map((id) => SUCCESS_BOOKS.find((b) => b.id === id))
    .filter(Boolean);

  const lines = [];
  lines.push(pathKey !== 'default'
    ? `${name === 'friend' ? '' : name + ' — '}here is THE marketer's shelf, ordered for exactly what you asked (${pathKey}): I carry the FULL original explanation of every one — ask me for any title by name.`
    : 'Here are the six books every serious marketer and seller should read — I carry the full explanation of each one offline. Ask me for any title and I will teach it lesson by lesson:');
  path.forEach((book, i) => {
    lines.push('');
    lines.push(`${i + 1}. "${book.title}" — ${book.author} (${book.year})`);
    lines.push(`   ${book.oneLine}`);
  });
  if (pathKey !== 'default') {
    lines.push('');
    lines.push('The pattern across all six: understand WHY people say yes (Cialdini), say it clearly (Miller), say it beautifully (Ogilvy + Whitman), sell with inner strength and process (Tracy), and engineer the path from stranger to repeat customer (Brunson). No shortcut exists — but this order IS the shortcut every good marketer walks.');
  }
  lines.push('');
  lines.push('Which one shall I open first? Say "tell me about <title>" and I will give you the complete breakdown — every lesson explained, with action steps and a seven-day plan.');
  return { mode: 'chat', kind: 'books', text: lines.join('\n'), books: path.map((b) => b.id) };
}

/** Answer "how to grow my business / become successful" from the shelf: the marketer's curriculum. */
export function successAnswer(query = '', { name = 'friend' } = {}) {
  name = name || 'friend';
  const shelf = bookshelf(`${query} grow business`, { name });
  const preamble = [
    `Straight answer, ${name === 'friend' ? 'friend' : name} — no hype, no get-rich schemes:`,
    '',
    'A growing business is never luck. It is built in four stages, and every marketer who scaled past the struggle phase walked them:',
    '1. PSYCHOLOGY FIRST — know exactly why humans say yes before you spend a rupee on ads (Influence — Cialdini).',
    '2. CLARITY — one story, one hero (the customer), one clear call to action; noise kills more businesses than competition (Building a StoryBrand — Miller).',
    '3. CRAFT — headlines, copy and offers that stop the scroll and survive the checklist (Ogilvy on Advertising + Cashvertising).',
    '4. SYSTEMS — the inner game of selling plus a value ladder that turns strangers into repeat customers (The Psychology of Selling — Tracy; DotCom Secrets — Brunson).',
    '',
    'The honest timeline is months of consistent reps, not one viral post — but the months pass anyway. The books below are the complete curriculum, and I carry every one of them in full:',
  ].join('\n');
  return { ...shelf, text: `${preamble}\n\n${shelf.text}` };
}

export function bookStats() {
  return { books: SUCCESS_BOOKS.length, lessons: SUCCESS_BOOKS.reduce((n, b) => n + b.lessons.length, 0),
           titles: SUCCESS_BOOKS.map((b) => b.title) };
}
