/**
 * SALES ENGINE — the psychological sales master's retrieval desk.
 *
 * Indexes the SALES_PLAYBOOK (56 field tactics across 8 stages) with the same
 * BM25 machinery as memory and the knowledge core, so "client is saying too
 * expensive" lands on the exact tactic, its psychology, and a ready-to-send
 * script in English AND Roman Urdu.
 *
 * Honesty contract: a weak match returns null — the brain then falls through
 * to the knowledge core / fluent layer instead of forcing a tactic.
 */

import { SALES_PLAYBOOK, SALES_STAGES } from './data/salesplay.js';
import { LexicalIndex } from './lexical.js';
import { queryTerms, stem } from './text.js';

// Roman-Urdu search cues: natural Urdu/Hindi phrasing mapped to tactics, so
// "mehnga hai keh raha hai" lands on the price reframe without touching data.
const STAGE_CUES = {
  opening: 'opener opening cold dm pehla message pehli baat introduction salam first contact naya client outreach',
  discovery: 'sawal poochna discovery client ke baare mein jaanna needs requirements budget pata karna maloomat',
  objection: 'objection bahana mana inkar problem issue customer ka sawal jawab handle karna rok tak',
  closing: 'close karna deal pakki karna haan karwana final karna start karwana sodha tay karna',
  negotiation: 'price rate fees discount kam karna negotiation mol bhav qeemat rate card',
  followup: 'follow up dobara message reply nahi aya contact karna yaad dilana wapis baat',
  retention: 'client tikana retain karna renewal chhod na jaye khush rakhna upsell service achi',
  referral: 'referral introduction dost ko batana naye client lana testimonial review recommendation',
};
const URDU_CUES = {
  ng1: 'mehnga mehngi zyada price rate qeemat bhaari afford kam kar do discount',
  ob1: 'mehnga price qeemat objection alag sawal',
  ob2: 'koi aur wajah mana karne ki asli baat',
  ob3: 'pehle bhi try kiya kaam nahi chala bharosa trust nahi agency ne dhoka diya',
  ob4: 'soch ke batata sochunga baad mein time chahiye delay bahana',
  ob5: 'bhatija dost free mein karta sasta free wala',
  ob6: 'kya bharosa guarantee risk agar kaam na chala',
  ob7: 'baad mein abhi nahi time nahi timing busy kabhi aur',
  ob8: 'partner se poochna boss decision saath mil kar',
  cl1: 'start kab setup shuru deal close karne ka tareeqa monday',
  cl2: 'summary poori baat recap price bata ke chup',
  cl3: 'guarantee risk free trial adha paisa',
  cl5: 'jaldi karao urgency slot limit sirf ek jagah',
  cl7: 'voice note bhejna whatsapp pe closing',
  op1: 'salon clinic shop gym restaurant pehla dm tareef',
  op2: 'audit free check report bhejun',
  op8: 'ek sawal reply asaan chhota sawal',
  ds1: 'nuqsan kitna loss cost calculate hisaab',
  ds2: 'pehle kya try kiya purani agency kyun nahi chala',
  ds5: 'budget kitna hai paisa kitna rakha',
  ds8: 'competitor doosri dukan muqabla rival',
  fu1: 'follow up message useful tip bina mange',
  fu3: 'file close karna last message khuda hafiz',
  fu5: 'voice note purani baat zinda karna',
  rf1: 'testimonial review mango tareef likhwana',
  rf3: 'ek naam sochna specific banda referral',
  rt2: 'weekly update report client ko batate rehna',
  rt3: 'bad news pehle batana galti result kharab',
  rt5: 'upsell naya service bechna purane client ko',
  ng2: 'kam kar dun shart ke sath trade advance',
  ng3: 'teen package tier option beech wala',
  ng4: 'budget kam hai scope kam karo price nahi',
};

let salesIndex = null;

function ensureSalesIndex() {
  if (salesIndex) return salesIndex;
  salesIndex = new LexicalIndex();
  SALES_PLAYBOOK.forEach((entry, i) => {
    const cues = `${STAGE_CUES[entry.stage] || ''} ${URDU_CUES[entry.id] || ''}`;
    const doc = `${entry.title} ${entry.tactic} ${entry.why} ${entry.when} ${entry.script} ${entry.scriptUrdu} ${SALES_STAGES[entry.stage] || ''} ${cues}`;
    // cues ride in the TITLE field too — title hits carry TITLE_BOOST, so a
    // Roman-Urdu phrase like "mehnga hai" reliably lands the price tactics.
    salesIndex.add(`s${i}`, `${entry.title} ${URDU_CUES[entry.id] || ''}`, doc);
  });
  return salesIndex;
}

/** Meaningful-term anchor: at least one real query term must appear in the
 *  tactic's title/tactic/when text — stops generic words from firing tactics. */
const SALES_STOP = new Set(['how', 'to', 'a', 'an', 'the', 'my', 'me', 'i', 'you',
  'for', 'of', 'and', 'or', 'is', 'it', 'this', 'that', 'what', 'when', 'why',
  'do', 'does', 'can', 'should', 'would', 'get', 'got', 'please', 'tell', 'give',
  'kaise', 'karun', 'karna', 'hai', 'ho', 'ka', 'ki', 'ke', 'ko', 'mein', 'main',
  'se', 'pe', 'par', 'ek', 'aur', 'bhi', 'mujhe', 'mera', 'meri', 'aap', 'woh',
  'client', 'customer', 'sale', 'sales', 'sell', 'bech', 'problem', 'issue',
  'setup', 'message', 'messages', 'baat', 'karta', 'karti', 'raha', 'rahi',
  'diya', 'dene', 'dena', 'liya', 'lena', 'kya', 'kyun', 'kyu', 'kaisa', 'kaisi']);

function anchored(entry, terms) {
  // Anchor on the STRATEGY text only (title/tactic/why/when) — never on the
  // scripts, so a city name or product inside an example cannot fire a match.
  const hay = `${entry.title} ${entry.tactic} ${entry.why} ${entry.when}`.toLowerCase();
  const meaningful = terms.filter((t) => !SALES_STOP.has(t) && t.length > 2);
  if (!meaningful.length) return false;
  return meaningful.some((t) => hay.includes(stem(t)) || hay.includes(t));
}

/**
 * Retrieve the best tactics for a sales question.
 * @returns {Array<{entry, score}>} top matches (empty when nothing fits)
 */
export function salesRetrieve(query, { topK = 2, minScore = 1.4 } = {}) {
  const terms = queryTerms(String(query || ''));
  if (!terms.length) return [];
  const index = ensureSalesIndex();
  const scores = index.search(terms, 12);
  return [...scores.entries()]
    .map(([id, score]) => ({ entry: SALES_PLAYBOOK[Number(id.slice(1))], score }))
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.score >= minScore && anchored(r.entry, terms))
    .slice(0, topK);
}

/**
 * The full sales-master answer: the tactic, WHY it works, WHEN to use it and
 * ready-to-send scripts in both languages. Null when the playbook has no
 * honest match — the caller falls through to other layers.
 */
export function salesAnswer(query, { name = 'friend', urdu = false } = {}) {
  const hits = salesRetrieve(query, { topK: 2 });
  if (!hits.length) return null;
  const lines = [];
  const you = name && name !== 'friend' ? name : 'dost';

  hits.forEach(({ entry }, i) => {
    if (i > 0) lines.push('');
    const stage = SALES_STAGES[entry.stage] || entry.stage;
    lines.push(`${i === 0 ? '' : 'AND THE BACKUP PLAY — '}${entry.title.toUpperCase()}  ·  ${stage}`);
    lines.push('');
    lines.push(`The tactic: ${entry.tactic}`);
    lines.push(`Why it works: ${entry.why}`);
    lines.push(`Use it when: ${entry.when}`);
    lines.push('');
    lines.push(urdu
      ? `READY SCRIPT (Roman Urdu):\n"${entry.scriptUrdu}"`
      : `READY SCRIPT (English):\n"${entry.script}"`);
    lines.push(urdu
      ? `ENGLISH VERSION:\n"${entry.script}"`
      : `ROMAN URDU VERSION:\n"${entry.scriptUrdu}"`);
  });

  lines.push('');
  lines.push(`${you === 'dost' ? 'Dost' : you} — copy the script word-for-word or bend it into your own voice; what matters is the psychology underneath. Want the next stage too? Ask me "what comes after this?" or name the stage (opening, discovery, objection, closing, negotiation, follow-up, retention, referral).`);

  return {
    text: lines.join('\n'),
    tactics: hits.map((h) => h.entry.id),
    stage: hits[0].entry.stage,
    citations: [{
      n: 1, kind: 'core', title: `Sales playbook — ${hits[0].entry.title}`,
      url: '', domain: 'salesplay', domainLabel: 'sales playbook',
      when: 'built-in playbook', quote: hits[0].entry.tactic,
    }],
  };
}

/** A random/rotating tactic for a stage — used by daily tips & description gen. */
export function salesTacticsFor(stage, n = 1) {
  const pool = SALES_PLAYBOOK.filter((e) => e.stage === stage);
  const out = [];
  for (let i = 0; i < n && pool.length; i += 1) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

export function salesStats() {
  const byStage = {};
  SALES_PLAYBOOK.forEach((e) => { byStage[e.stage] = (byStage[e.stage] || 0) + 1; });
  return {
    tactics: SALES_PLAYBOOK.length,
    stages: Object.keys(SALES_STAGES).length,
    byStage,
    bilingualScripts: SALES_PLAYBOOK.filter((e) => e.script && e.scriptUrdu).length,
  };
}
