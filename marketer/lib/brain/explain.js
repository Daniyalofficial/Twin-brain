/**
 * The super explainer: turns retrieval results (and permitted web results)
 * into a friendly, structured lesson instead of a pile of links.
 *
 * Honesty rules never bend:
 *   - every factual sentence comes from a retrieved page or a fetched page,
 *     and is listed in `citations` with title + site + when;
 *   - the conversational glue (openers, offers, empathy) adds no facts;
 *   - when nothing matches, the answer says so warmly and offers the web,
 *     it never improvises.
 */

import { PLAIN, simplify, truncate, stem } from './text.js';
import { quoteFloor } from './retrieve.js';

const OPENERS = [
  'Okay, here\'s the picture from what you\'ve read:',
  'Good question — let me walk you through it the simple way:',
  'Ah, this connects to stuff in your memory. Here\'s the plain-English version:',
  'Let me be your teacher for a minute. Short version first, details after:',
  'I know this one from your reading history. Breaking it down:',
];
const WEB_OPENERS = [
  'Your memory was thin on this, so (with your okay) I checked the web. Here\'s what I learned:',
  'Fresh from the web, explained like a friend would:',
  'I looked this up outside your memory just now. Simple version:',
];
const HONEST_LINES = [
  'Honestly? I don\'t have this in your memory yet, and I won\'t pretend otherwise.',
  'I searched everything you\'ve read and found nothing solid on this — I\'d rather say that than make things up.',
  'This one isn\'t in my memory yet. No guessing from me.',
];
const DENIED_LINES = [
  'No problem — we\'ll stay inside your memory only.',
  'Understood, no web this time. Here\'s what your memory alone says:',
];

function pick(list, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

/**
 * @param {object} input
 *   query, result (from retrieve.js), webResults [{title,url,snippet}],
 *   usedWeb, webDenied, related [{title,url,why}], interests [{topic,pages,lastAgo}],
 *   talkative (bool)
 */
export function explain(input) {
  const {
    query, result, webResults = [], usedWeb = false, webDenied = false,
    related = [], interests = [], talkative = true,
  } = input;
  const matches = (result && result.matches) || [];
  const best = matches[0] ? matches[0].scores.relevance : 0;
  const floor = quoteFloor(best);

  const cited = matches.filter((m) => m.scores.relevance >= floor);
  const linked = matches.filter((m) => m.scores.relevance < floor).slice(0, 4);

  // --- the simple-words core: whole sentences, simplified, deduped ----------
  const simpleParts = [];
  const pointParts = [];
  for (const match of cited.slice(0, 3)) {
    (match.sentences || []).forEach((sentence, i) => {
      const clean = simplify(sentence);
      if (i === 0 && simpleParts.length < 3) simpleParts.push(clean);
      else if (pointParts.length < 6) pointParts.push(clean);
    });
  }

  // --- words demystified: dictionary lookups over the cited text ------------
  const words = [];
  const hay = cited.map((m) => `${m.title} ${m.sentences ? m.sentences.join(' ') : m.excerpt}`)
    .join(' ').toLowerCase();
  for (const [term, plain] of Object.entries(PLAIN)) {
    if (!plain) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(hay) && !words.some((w) => w.term === term)) {
      words.push({ term, plain });
    }
    if (words.length >= 5) break;
  }

  // --- connect to the person ------------------------------------------------
  let connect = null;
  const stemmedQuery = new Set((query || '').toLowerCase().split(/\W+/).map(stem));
  for (const interest of interests.slice(0, 8)) {
    const topic = stem(String(interest.topic || ''));
    const inQuery = stemmedQuery.has(topic);
    const inCites = cited.some((m) => (m.title || '').toLowerCase().includes(topic));
    if (topic && (inQuery || inCites)) {
      const pageCount = Number(interest.pages);
      const countPart = Number.isFinite(pageCount) && pageCount > 0
        ? `${pageCount} page(s) in your memory`
        : 'living in your memory';
      connect = `This sits right inside your ${interest.topic} interest — ` +
                countPart +
                (interest.lastAgo ? `, last touched ${interest.lastAgo}` : '') +
                '. So you already have roots here; I\'m just adding branches.';
      break;
    }
  }

  // --- citations: memory first, then web, always numbered -------------------
  const citations = [];
  cited.forEach((match, i) => {
    citations.push({
      n: i + 1, kind: 'memory', title: match.title, url: match.url,
      domain: match.domainLabel || match.domain, when: match.visitedAgo,
      dwell: match.dwellSeconds, assistantFetched: match.assistantFetched,
    });
  });
  webResults.slice(0, 5).forEach((item, i) => {
    citations.push({
      n: citations.length + 1, kind: 'web', title: item.title, url: item.url,
      domain: domainOfUrl(item.url), when: 'fetched now', snippet: item.snippet,
    });
  });

  // --- web notes: the extra facts, simplified -------------------------------
  const webNotes = usedWeb
    ? webResults.slice(0, 4).map((item, i) => ({
      n: cited.length + i + 1,
      text: simplify(truncate(item.snippet || item.title, 220)),
    }))
    : [];

  // --- further reading (deduped: never repeat a cited source) ---------------
  const further = [];
  const furtherUrls = new Set(citations.map((cite) => cite.url));
  const pushFurther = (item) => {
    if (!item.url || furtherUrls.has(item.url)) return;
    furtherUrls.add(item.url);
    further.push(item);
  };
  linked.forEach((match) => pushFurther({
    title: match.title, url: match.url,
    why: `in your memory (${match.visitedAgo}) — related but not a strong match`,
  }));
  related.forEach((item) => pushFurther({ title: item.title, url: item.url, why: item.why || 'related page in your memory' }));
  webResults.slice(usedWeb ? 2 : 0, 6).forEach((item) => pushFurther({
    title: item.title, url: item.url, why: 'from the web search',
  }));

  // --- follow-ups a friendly teacher would offer ----------------------------
  const topTopic = interests[0] ? interests[0].topic : null;
  const topDomain = cited[0] ? (cited[0].domainLabel || cited[0].domain) : null;
  const followups = [];
  if (cited.length) followups.push(`Explain ${truncate(cited[0].title, 40)} like I'm new to this`);
  if (topDomain) followups.push(`What else did I read from ${topDomain}?`);
  if (topTopic && !stemmedQuery.has(stem(topTopic))) followups.push(`How does this connect to my ${topTopic} reading?`);
  followups.push('Summarise my reading day');

  // Honesty contract: an answer is "grounded" only if it actually has
  // teachable material — a retrieval flag with zero citable matches produced
  // confident openers over empty lessons. Never again.
  const grounded = (Boolean(result && result.grounded) && cited.length > 0) ||
                   webNotes.length > 0;

  const out = {
    grounded,
    opener: usedWeb ? pick(WEB_OPENERS, query) :
      (grounded ? pick(OPENERS, query) : pick(HONEST_LINES, query)),
    simple: simpleParts.join(' '),
    points: pointParts.slice(0, 6),
    words,
    connect,
    webNotes,
    citations,
    further: further.slice(0, 6),
    followups: followups.slice(0, 4),
    honesty: grounded ? null : pick(HONEST_LINES, query),
    webDeniedLine: webDenied ? pick(DENIED_LINES, query) : null,
    talkative,
  };

  // conversational closing: an offer, never a fact
  if (talkative) {
    if (!grounded && !webDenied) {
      out.closing = 'Want me to ask the web for this? I only ever search when you say so.';
    } else if (grounded) {
      out.closing = 'Want me to go deeper on any point, or find fresher info online (only if you allow it)?';
    } else {
      out.closing = 'If you change your mind about web lookups, I\'m one tap away.';
    }
  }
  return out;
}

/** Advice mode: thinks out loud using ONLY the person's own reading as facts. */
export function advice(query, interests, matches = []) {
  const lines = [];
  lines.push('Here\'s how I\'d think about it, knowing what you read:');
  const top = interests.slice(0, 3).map((i) => i.topic).filter(Boolean);
  if (top.length) {
    lines.push(`• You've been deep in ${top.join(', ')} lately — so options that build on that knowledge will feel cheapest for you.`);
  }
  if (matches.length) {
    lines.push(`• Your own notes point at “${truncate(matches[0].title, 70)}” — start there, past-you already did some of the homework.`);
  }
  lines.push('• Smallest reversible step first: try the cheap version this week, keep the receipt (what you learn), then decide.');
  lines.push('• If it touches money, health or something irreversible, I\'d want a second source — say the word and I\'ll check the web with your permission.');
  return lines.join('\n');
}

/** Small talk / greetings: warm, zero facts, always offers the next step. */
export function smalltalk(query, stats, interests) {
  const openers = [
    'Hey, I\'m here — your marketing twin, fully awake.',
    'Hi! Good to see you. I\'ve been tidying your memory while you were away.',
    'Hello friend. Ask me anything about what you\'ve read — or just chat.',
  ];
  const bits = [];
  if (stats && stats.pages) {
    bits.push(`Right now I hold ${stats.pages} page(s) and ${stats.visits || 0} visit(s) of your reading`);
    if (interests && interests.length) bits.push(`and I'd say your big theme lately is ${interests[0].topic}`);
  } else {
    bits.push('Your memory is empty so far — browse anything for a few seconds and I\'ll start learning you');
  }
  return `${pick(openers, query)} ${bits.join(', ')}. What are we curious about today?`;
}

function domainOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
