/**
 * Real-time understanding layer: reads your message the way a friend does.
 *
 *  - question types (when / how many / which site / did I / compare / define…)
 *  - time phrases ("today", "last week") become real date windows
 *  - anaphora: "tell me more", "what about that?", "and why?" get stitched to
 *    the topic you were just talking about
 *  - personal facts: "my name is Ali", "I'm learning Python", "I love cricket"
 *    are extracted so the AI remembers who it is talking to
 *  - ambiguity: a question with nothing to go on becomes a clarifying question
 *    instead of a random guess
 */

import { findBook } from './data/books.js';
import { contentWords, stem } from './text.js';

const QUESTION_NOISE = new Set(['what', 'when', 'where', 'which', 'who', 'why', 'how',
  'did', 'do', 'does', 'is', 'are', 'was', 'were', 'tell', 'show', 'mean', 'means',
  'read', 'reads', 'reading', 'remember', 'page', 'pages', 'site', 'sites', 'thing',
  'things', 'about', 'explain', 'summary', 'summarize', 'summarise', 'know', 'learn',
  'many', 'much', 'last', 'time', 'day', 'week', 'month', 'today', 'yesterday',
  'give', 'list', 'find', 'search', 'look', 'understand']);

const TIME_PATTERNS = [
  { re: /\btoday\b/i, days: 1, label: 'today' },
  { re: /\byesterday\b/i, days: 2, label: 'yesterday', offset: 1 },
  { re: /\b(?:this|past|last) week\b|\b(?:last|past) 7 days\b/i, days: 7, label: 'this week' },
  { re: /\b(?:this|past) month\b|\b(?:last|past) 30 days\b/i, days: 30, label: 'this month' },
  { re: /\blast month\b/i, days: 60, label: 'last month', offset: 30 },
];

const ANAPHORA_START = /^(?:and|but|so|also|ok|okay|then)?[\s,]*(?:what|how|why|when|where|who|which|tell me more|more|deeper|go on|continue|interesting|really|nice|cool|hmm|elaborate|expand)\b/i;
const PRONOUN_ONLY = /^(?:what|how|why|tell me)?\s*(?:about|of|on)?\s*(?:it|that|this|those|them|these)\s*[?.!]*$/i;

const SMALLTALK_RE = /^(?:hi|hey|hello|yo|sup|assalam|salam|how are you|how's it going|good (?:morning|evening|afternoon|night)|thanks|thank you|shukriya|who are you|what are you|your name|love you|you are (?:great|awesome|amazing|cool|smart|the best)|you're (?:great|awesome|amazing|cool|smart|the best)|good bot|bye|goodbye|see you|khuda hafiz|i (?:am|'m|feel|am feeling) (?:so |really |very |kind of |a bit )?(?:tired|sad|stressed|exhausted|lonely|angry|anxious|drained|overwhelmed|down|upset|bored)|i had (?:a |one )?(?:really |so )?(?:bad|terrible|awful|horrible|rough|hard|worst) day|today was (?:terrible|awful|bad|horrible|the worst)|everything (?:went wrong|is piling up)|nothing went right|too much (?:pressure|on my plate)|i am drowning)\b/i;
const META_RE = /\b(?:my stats|how many pages (?:do i have|total)|my memory|what do you (?:know|hold) about me\b|your stats|brain stats)\b/i;
const IDENTITY_RE = /\b(?:who am i|what(?:'s| is|s) my name|do you (?:know|remember) my name|my name\?|what do you (?:know|remember) about me|tell me about myself|my profile)\b/i;

// --- the English tool: explicit definition / grammar / vocabulary requests ---
const GRAMMAR_RE = /^(?:correct|fix|check|improve|rewrite|polish)\s+(?:this|it|my|the)?[\s:,\-]|^(?:grammar|correct this|fix this)\b|\bgrammar\s+(?:check|help|correct|fix|mistake)\b|\bcorrect my (?:sentence|english|grammar|paragraph)\b|\bis this (?:sentence )?(?:correct|grammatically)/i;
const SYNONYM_RE = /\bsynonyms?\b|\banother word for\b|\bopposite of\b|\bantonyms?\b/i;
const DEFINE_RE = /^(?:define|meaning of|whats the meaning of|what(?:'s| is) the meaning of)\b|\bwhat does\s+.+\s+means?\b|(?:\bmeans?|\bmeaning)\s*\??$/i;
const MEANING_OF_LIFE_RE = /\bmeaning of life\b/i;

// --- the bookshelf + the ambition path ---
const SUCCESS_RE = /\b(?:billionaire|millionaire|get rich|financial freedom|make (?:a lot of |lots of |more |good )?money|earn money|build wealth|become (?:successful|wealthy)|success (?:in life|habits|secrets|tips)|how to be successful|grow (?:my|the|our) business|business (?:barhana|barhana|grow)|more (?:clients|customers)|naye (?:client|customer)|get more (?:leads|clients|customers)|marketing (?:career|seekhna|sikhna)|become a (?:marketer|freelancer))\b/i;
// --- the sales playbook: selling conversations in English AND Roman Urdu ----
const SALES_RE = /\b(?:objection|objections|close (?:the|a|my)? ?(?:deal|sale|client)|closing|how to close|convince|negotiat\w*|too expensive|mehnga|discount|price (?:high|zyada|barha)|fees|rate (?:kya|kitna)|quote|cold (?:dm|dms|message|call|outreach)|dm script|pitch (?:a |my )?(?:client|deck|idea)?|follow ?up|prospecting|proposal|retainer|onboard\w*|client (?:says|said|is saying|mana|raazi|maan|leaves|left|ghost)|customer (?:says|said|mana|delaying)|deal (?:close|pakki|stuck|dead)|testimonial|referral|upsell|renewal|kitna (?:loon|charge karun|price loon)|soch ke bata\w*|baad mein \w{3,}|pehle bhi (?:try|ads)|bharosa|guarantee (?:do|dena)|sale kaise|bechna|bech|qaimal|client kaise (?:laun|mile|pakdaun))\b/i;
const MEMORY_GUARD_RE = /\b(?:did|have) i\b|\bmy (?:page|pages|reading|stats|memory|history)\b|\bwhat did i\b/i;
const BOOKS_RE = /\b(?:books?|novels?|reading list|bookshelf)\b/i;
const BOOK_INTENT_RE = /\b(?:recommend|which|best|top|tell me|about|suggest|should i read|want to read|summary|explain|teach|lessons|reading)\b/i;
const PERSONAL_RE = /\b(?:my (?:dad|father|mom|mother|mum|family|friend|boss|life)|i am|i'?m|i feel|i have|i want to be (?:a )?(?:doctor|engineer|pilot|teacher))\b/i;
const WANTS_WEB_RE = /^(?:web|search the web|google|online)[:! ]/i;
const WANTS_WEB_ANY_RE = /\b(?:s(?:ea|ear|e)?ar?ch|seach|serach|check|find|look(?:ing)?\s+(?:\w+\s+)?up)\s+(?:\w+\s+){0,3}?(?:on\s+|from\s+)?(?:the\s+)?(?:web|internet|online|google)\b/i;

// --- personal facts ---------------------------------------------------------

const FACT_PATTERNS = [
  { kind: 'name', re: /(?:my name is|i am called|call me|this is)\s+([A-Za-z][\w'-]{1,30})/i },
  { kind: 'learning', re: /i\s?(?:am|'m)\s+(?:currently\s+|now\s+)?(?:learning|studying|practi[cs]ing|reading up on|getting into)\s+([^.,!?;]{2,40})/i },
  { kind: 'likes', re: /\bi\s+(?:really\s+|truly\s+)?(?:love|like|enjoy|adore)\s+([^.,!?;]{2,40})/i },
  { kind: 'dislikes', re: /\bi\s+(?:really\s+)?(?:hate|dislike|can'?t stand)\s+([^.,!?;]{2,40})/i },
  { kind: 'job', re: /\bi\s+(?:work|am working|'m working)\s+as\s+(?:an?\s+)?([^.,!?;]{2,40})/i },
  { kind: 'lives', re: /\bi\s+live\s+in\s+([^.,!?;]{2,40})/i },
  { kind: 'goal', re: /\bmy\s+(?:goal|dream|aim|plan)\s+is\s+(?:to\s+)?([^.,!?;]{2,60})/i },
  { kind: 'note', re: /\bremember(?:\s+that)?\s*[:,-]\s*([^]{4,120})/i },
];

const FACT_STOP_PREFIX = /^(?:to|it|that|this|the|you|when|how|what|if|so)\b/i;

export function extractFacts(text) {
  const out = [];
  const s = String(text || '');
  for (const pattern of FACT_PATTERNS) {
    const match = pattern.re.exec(s);
    if (!match) continue;
    let value = match[1].trim()
      .replace(/\s+(?:too|also|ok|okay|please|bro|man|yaar|now|currently|these days|nowadays|lately|really)$/i, '');
    if (!value || value.length < 2 || FACT_STOP_PREFIX.test(value)) continue;
    if (pattern.kind === 'name') value = value[0].toUpperCase() + value.slice(1).toLowerCase();
    out.push({ kind: pattern.kind, value });
  }
  return out;
}

// --- time understanding -------------------------------------------------------

export function parseTimeRange(text) {
  const s = String(text || '');
  for (const pattern of TIME_PATTERNS) {
    if (pattern.re.test(s)) {
      const now = Date.now();
      const sinceMs = now - pattern.days * 86400000;
      const untilMs = pattern.offset ? now - pattern.offset * 86400000 : now;
      return { label: pattern.label, sinceMs, untilMs };
    }
  }
  return null;
}

// --- question typing ----------------------------------------------------------

export function questionType(text) {
  const s = String(text || '').trim();
  if (SMALLTALK_RE.test(s)) return 'smalltalk';
  if (IDENTITY_RE.test(s) && !/\bmy name is\b/i.test(s)) return 'identity';
  // explicit English-tool requests route to the pocket dictionary/grammar desk
  if (GRAMMAR_RE.test(s)) return 'grammar';
  if (SYNONYM_RE.test(s)) return 'word';
  if (DEFINE_RE.test(s) && !MEANING_OF_LIFE_RE.test(s)) return 'define';
  if (WANTS_WEB_RE.test(s)) return 'web';
  // the success shelf: a named book deep-dive, a shelf question, or ambition
  if (!PERSONAL_RE.test(s)) {
    if (findBook(s)) return 'book';
  }
  if (SALES_RE.test(s) && !MEMORY_GUARD_RE.test(s)) return 'sales';
  if (SUCCESS_RE.test(s)) return 'success';
  if (BOOKS_RE.test(s) && BOOK_INTENT_RE.test(s)) return 'books';
  if (/\b(?:summar[i]?[sz]e|recap)\b.*\b(?:my|today|week|day|reading)\b/i.test(s) ||
      /\bwhat (?:did|have) i read\b/i.test(s)) return 'recap';
  if (META_RE.test(s)) return 'meta';
  if (/\bdifference between\b|\bcompare\b|\bvs\.?\b|\bversus\b/i.test(s)) return 'compare';
  if (/^(?:when|what (?:date|day|time))\b|\bwhen did i\b/i.test(s)) return 'when';
  if (/\bhow many\b|\bhow much\b|\bcount of\b|\bnumber of\b/i.test(s)) return 'count';
  if (/\b(?:which|what) (?:site|sites|website|websites|domain|domains|source|sources|url|urls)\b/i.test(s)) return 'which_source';
  // recap BEFORE verify: "what did I read today" is a recap, not a yes/no check
  if (/\bwhat (?:did|have) i read\b|\bmy reading\b|\bsummar[i]?[sz]e\b|\brecap\b/i.test(s)) return 'recap';
  if (/\b(?:did|have) i\b|\bwas (?:it|there)\b|\bdo i (?:know|remember|have)\b|\bany(?:thing)? (?:about|on)\b/i.test(s)) return 'verify';
  if (/\bshould i\b|\bwhat should\b|\badvice\b|\brecommend\b|\bbest way\b|\bworth it\b/i.test(s)) return 'advice';
  return 'knowledge';
}

// --- the full parse -------------------------------------------------------------

/**
 * @param {string} query
 * @param {object} ctx  {history: [{query, topic, type}], interests: [{topic}]}
 */
export function parseQuery(query, ctx = {}) {
  const raw = String(query || '').trim();
  const type = questionType(raw);
  const timeRange = parseTimeRange(raw);
  const quoted = (raw.match(/"([^"]{2,80})"|“([^”]{2,80})”/g) || [])
    .map((q) => q.replace(/^["“]|["”]$/g, ''));
  const factStatements = extractFacts(raw);

  let topicWords = contentWords(raw)
    .filter((w) => !QUESTION_NOISE.has(w) && !/^(?:i|my|me|you|your|it|that|this|the)$/i.test(w))
    .map((w) => w.toLowerCase());
  if (timeRange) {
    topicWords = topicWords.filter((w) => !['today', 'yesterday', 'week', 'month'].includes(w));
  }
  for (const q of quoted) for (const w of contentWords(q)) if (!topicWords.includes(w.toLowerCase())) topicWords.push(w.toLowerCase());

  // anaphora: stitch short follow-ups to the previous topic
  const history = ctx.history || [];
  const lastTopic = (() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const turn = history[i];
      const words = String(turn.topic || '').split(/\s+/).filter(Boolean);
      if (words.length && ['smalltalk', 'meta', 'clarify'].indexOf(turn.type) === -1) return words;
    }
    return [];
  })();

  let anaphora = false;
  let resolvedQuery = raw;
  const contentful = topicWords.filter((w) => !QUESTION_NOISE.has(w));
  const looksAnaphoric = PRONOUN_ONLY.test(raw) ||
    (ANAPHORA_START.test(raw) && contentful.length === 0) ||
    (/\b(?:it|that|this|those)\b/i.test(raw) && contentful.length <= 1 && lastTopic.length);
  if (looksAnaphoric && lastTopic.length) {
    anaphora = true;
    topicWords = [...new Set([...contentful, ...lastTopic.map((w) => w.toLowerCase())])];
    resolvedQuery = `${raw} ${lastTopic.join(' ')}`;
  }

  const ambiguous = type === 'knowledge' && !timeRange && contentful.length === 0 &&
                    !anaphora && raw.split(/\s+/).length <= 4 && !/^[?.!]$/.test(raw);

  return {
    raw, type, timeRange, quoted, topicWords: [...new Set(topicWords)],
    wantsWeb: WANTS_WEB_RE.test(raw) || WANTS_WEB_ANY_RE.test(raw),
    bookId: type === 'book' ? (findBook(raw) || {}).id || null : null,
    stemmed: [...new Set(topicWords.map(stem))],
    factStatements, anaphora, resolvedQuery, ambiguous,
    isQuestion: /\?$/.test(raw) || /^(?:what|when|where|which|who|why|how|did|do|does|is|are|was|were|can|should|could|would)\b/i.test(raw),
    compliment: /you(?:'re| are)? (?:great|awesome|amazing|cool|smart|the best|so good)|good bot|love you/i.test(raw),
  };
}
