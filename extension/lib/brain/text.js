/**
 * On-device text utilities — the JS twin of server/text.py's matching helpers.
 * Pure functions only (no chrome.*), so Node can unit-test them.
 */

export const STOPWORDS = new Set(`
a about above after again against all am an and any are aren as at be because been before being
below between both but by can cannot could couldn did didn do does doesn doing don down during
each few for from further had hadn has hasn have haven having he her here hers herself him himself
his how i if in into is isn it its itself just let like made make many may me might mine more most
must my myself never no nor not now of off on once only or other ought our ours ourselves out over
own said same shan she should shouldn so some such than that the their theirs them themselves then
there these they this those through to too under until up upon us use used using very was wasn we
were weren what when where which while who whom why will with within won would wouldn you your
yours yourself yourselves also get got one two three new via per etc can't dont isn't aren't
it's that's there's i'm you're we're they're he's she's let's oh hey hi vs across around behind
beside among along toward towards upon whether whatever whoever whenever wherever whichever
`.split(/\s+/).filter(Boolean));

/** Words that describe the *request*, not the topic — stripped from query-side
 *  matching only, exactly like server/text.py REQUEST_WORDS. */
export const REQUEST_WORDS = new Set(`
read reads reading looked look looking looks find finds found give gives gave
show shows showed tell tells told know knows knew remember remembered forget forgot
page pages link links url urls article articles site sites website websites post posts
video videos thing things stuff best good great nice top open opened visit visited
visits browse browsed browsing search searched searches history memory memories
yesterday today tonight tomorrow morning afternoon evening night week weeks weekend
month months year years day days hour hours minute minutes second seconds last recent
recently lately ago new old something anything everything info information details
`.split(/\s+/).filter(Boolean));

export const MATCH_STOPWORDS = new Set([...STOPWORDS, ...REQUEST_WORDS]);

const TOKEN_RE = /[a-z0-9][a-z0-9'+#.-]*/g;

export function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(TOKEN_RE) || [];
  return raw.map((w) => w.replace(/[.'",;:!?]+$/, '')).filter((w) => w.length > 0);
}

export function contentWords(text) {
  return tokenize(text).filter((w) => !STOPWORDS.has(w) && w.length > 1);
}

export function queryTerms(text) {
  return tokenize(text).filter((w) => !MATCH_STOPWORDS.has(w) && w.length > 1);
}

/** Porter-lite: enough morphology for prefix-tolerant matching on-device. */
// words that END in -ed/-ing but ARE the root ("embed" must not become "emb")
const ROOT_EXCEPTIONS = new Set([
  'embed', 'embeds', 'amend', 'amends', 'mend', 'sends', 'send', 'spend', 'spends',
  'tend', 'tends', 'blend', 'blends', 'extend', 'extends', 'intend', 'intends',
  'lend', 'lends', 'bend', 'bends', 'append', 'appends', 'defend', 'defends',
  'offend', 'offends', 'suspend', 'suspends', 'attend', 'attends', 'recommend',
  'recommend', 'shred', 'sled', 'spread', 'spreads', 'thread', 'threads', 'shed',
  'sheds', 'wed', 'bed', 'beds', 'fed', 'led', 'bred', 'fled', 'sped', 'dread',
  'dreads', 'dead', 'head', 'heads', 'read', 'reads', 'lead', 'leads', 'bread',
  'instead', 'already', 'steady', 'ahead', 'bring', 'brings', 'sing', 'sings',
  'king', 'ring', 'rings', 'wing', 'wings', 'thing', 'things', 'string', 'strings',
  'spring', 'springs', 'swing', 'swings', 'cling', 'fling', 'sling', 'sting',
  'wring', 'during', 'morning', 'mornings', 'evening', 'evenings', 'ceiling',
  'nothing', 'something', 'anything', 'everything', 'clothing', 'engineering'
]);

export function stem(word) {
  if (word.length < 4) return word;
  if (ROOT_EXCEPTIONS.has(word)) return word;
  let s = word;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('edly') && s.length > 6) s = s.slice(0, -4);
  else if (s.endsWith('ly') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('es') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
  // running -> runn -> run  (double consonant left behind by -ing/-ed)
  const doubled = /([bcdfghjklmnpqrstvwxz])\1$/.test(s);
  if (doubled) s = s.slice(0, -1);
  // baking -> bak -> bake  (silent-e restored for CVC stems, never after a double)
  if (s !== word && !doubled && s.length === 3 &&
      /^[bcdfghjklmnpqrstvwxz][aeiou][bcdfghjklmnpqrstvwxz]$/.test(s)) {
    s += 'e';
  }
  // stripping that leaves no vowel ("spring" -> "spr") was too aggressive
  if (s !== word && !/[aeiouy]/.test(s)) return word;
  return s.length < 3 ? word : s;
}

export function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["'([[]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
}

/** Sentence scoring for quotes: coverage of query terms, length-sanitised. */
export function bestSentences(text, terms, n = 3) {
  const sentences = splitSentences(text);
  if (!sentences.length || !terms.length) return [];
  const scored = sentences.map((sentence) => {
    const tokens = new Set(tokenize(sentence).map(stem));
    let hits = 0;
    for (const term of terms) {
      const t = stem(term);
      if (tokens.has(t)) hits += 1;
      else for (const tok of tokens) {
        if (tok.length >= 4 && t.length >= 4 &&
            (tok.startsWith(t.slice(0, 4)) || t.startsWith(tok.slice(0, 4)))) { hits += 0.6; break; }
      }
    }
    const coverage = hits / terms.length;
    const len = sentence.length;
    const shape = len < 40 ? 0.6 : len > 420 ? 0.7 : 1.0;
    return { sentence, score: coverage * shape };
  });
  scored.sort((a, b) => b.score - a.score);
  // document order, like the server engine: reads naturally, no cherry-pick soup
  const picked = scored.slice(0, n).filter((s) => s.score > 0.12);
  picked.sort((a, b) => text.indexOf(a.sentence) - text.indexOf(b.sentence));
  const seen = new Set();
  const out = [];
  for (const item of picked) {
    const key = item.sentence.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.sentence);
  }
  return out;
}

export function truncate(text, max = 160) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > 40 ? space : max)}…`;
}

export function humanTime(value) {
  if (!value) return '';
  const then = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days} d ago`;
  return `${Math.floor(days / 30)} mo ago`;
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * The teacher's dictionary: plain-language meanings for words that usually make
 * explanations feel cold. Used by the explainer's "words demystified" section —
 * it is a dictionary, never invented facts about your pages.
 */
export const PLAIN = {
  api: 'an API is a agreed-upon way for one program to ask another for something',
  algorithm: 'an algorithm is just a precise recipe of steps a computer follows',
  authentication: 'authentication is proving you are who you say you are',
  backend: 'the backend is the behind-the-scenes part of a site: data and logic',
  bm25: 'BM25 is the classic maths behind "search box" ranking: rarer words count more',
  cache: 'a cache is a small fast memory of things you recently used',
  cloud: '"the cloud" simply means computers somewhere else that you rent',
  container: 'a container is a boxed-up program with everything it needs to run',
  database: 'a database is an organised closet of data that answers questions fast',
  embedding: 'an embedding is a list of numbers that means "how similar two texts are"',
  encryption: 'encryption is scrambling data so only the right key can read it',
  framework: 'a framework is a pre-built skeleton so you do not start from zero',
  index: 'an index is like the index of a book: it points straight to the right page',
  latency: 'latency is the waiting time between asking and getting an answer',
  library: 'a library is someone else\'s tested code you reuse instead of rewriting',
  llm: 'an LLM is a text-prediction model trained on enormous amounts of writing',
  metadata: 'metadata is data about data: who, when, where — not the content itself',
  model: 'a model here means a trained program that turns input into a guess',
  'open source': 'open source means the recipe (code) is public so anyone can check it',
  portfolio: 'a portfolio is the mix of things you own as investments',
  privacy: 'privacy is control over who gets to see what about you',
  prompt: 'a prompt is simply the question or instruction you give an AI',
  query: 'a query is just a question phrased so a database can answer it',
  rag: 'RAG = "look things up first, then answer": retrieval plus generation',
  retrieval: 'retrieval means finding the right stored pieces before answering',
  schema: 'a schema is the blueprint of what a database stores and how',
  server: 'a server is a program that waits for requests and answers them',
  token: 'a token is a secret slip of paper that proves you may enter',
  vector: 'a vector here is a arrow of numbers pointing at a meaning in space',
  inflation: 'inflation means prices in general rising, so money buys a bit less',
  interest: 'interest is the price of borrowing money, or the reward for lending it',
  dividend: 'a dividend is a slice of profit a company pays its shareholders',
  metabolism: 'metabolism is how your body turns food into usable energy',
  placebo: 'a placebo is a treatment that works only because you expect it to',
  hypothesis: 'a hypothesis is a guess stated precisely enough to test',
  'peer review': 'peer review means other experts check a paper before publication',
  correlation: 'correlation means two things move together — not that one causes the other',
  median: 'the median is the middle value when everything is sorted',
  ui: 'UI is everything you see and click on a screen',
  ux: 'UX is how the whole thing feels to actually use',
  css: 'CSS is the styling language that decides how web pages look',
  dom: 'the DOM is the live tree of everything on a web page',
  kernel: 'the kernel is the core of an OS that talks directly to hardware',
  firmware: 'firmware is the small software baked into a device',
  seo: 'SEO is making pages easier for search engines to understand and rank',
  roi: 'ROI is what you get back divided by what you put in',
  vpn: 'a VPN is a private tunnel through the public internet',
  neuron: 'a neuron is a nerve cell that passes electro-chemical signals',
  cognition: 'cognition is the bundle of mental skills: attention, memory, reasoning',
  quantum: 'quantum physics describes nature at scales where common sense breaks',
  orbit: 'an orbit is the curved path something takes around a heavier thing',
  vaccine: 'a vaccine trains your immune system without giving you the disease',
  antibiotic: 'an antibiotic is a drug that kills bacteria, not viruses',
  photosynthesis: 'photosynthesis is plants turning light, water and CO2 into food',
  starter: 'a sourdough starter is a jar of wild yeast you feed like a pet',
  retard: 'a cold retard is slowing dough in the fridge to build flavour',
};

/** Tiny synonym swap used for the "in simple words" pass. */
const SIMPLE_SWAP = {
  utilize: 'use', utilizes: 'uses', utilized: 'used', utilizing: 'using',
  utilise: 'use', utilises: 'uses', utilised: 'used', utilising: 'using',
  optimize: 'improve', optimise: 'improve', optimizes: 'improves',
  optimises: 'improves', optimized: 'improved', optimised: 'improved',
  methodology: 'way of doing things', implementation: 'build',
  implementations: 'builds',
  approximately: 'about', method: 'way', methods: 'ways', mechanism: 'way',
  demonstrate: 'show', demonstrates: 'shows', demonstrated: 'showed',
  sufficient: 'enough', insufficient: 'not enough', numerous: 'many',
  obtain: 'get', obtains: 'gets', obtained: 'got', require: 'need',
  requires: 'needs', required: 'needed', attempt: 'try', attempts: 'tries',
  commence: 'start', terminate: 'end', terminated: 'ended',
  facilitate: 'help', facilitates: 'helps', subsequent: 'later', prior: 'earlier',
  majority: 'most', minority: 'few', component: 'part', components: 'parts',
  functionality: 'feature', implement: 'build', implements: 'builds',
  implemented: 'built', implementation: 'setup', configuration: 'setup',
  additionally: 'also', furthermore: 'also', however: 'but', therefore: 'so',
  thus: 'so', hence: 'so', moreover: 'also', nevertheless: 'still',
  consequently: 'so', aforementioned: 'that', optimum: 'best', optimal: 'best',
};

export function simplify(sentence) {
  return String(sentence || '').replace(/[A-Za-z]+/g, (word) => {
    const lower = word.toLowerCase();
    const swap = SIMPLE_SWAP[lower];
    if (!swap) return word;
    if (word[0] === word[0].toUpperCase()) {
      return swap[0].toUpperCase() + swap.slice(1);
    }
    return swap;
  });
}
