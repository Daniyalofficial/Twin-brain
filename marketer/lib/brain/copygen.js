/**
 * COPYGEN — the psychology-based post/description writer.
 *
 * Generates ready-to-paste Facebook descriptions from a short brief
 * (business, city, offer, audience), in English or Roman Urdu, structured on
 * persuasion principles (hook → problem → offer → proof → urgency → CTA) and
 * finished with hashtags. Three variants per request so the user can pick.
 *
 * Everything is composed from original phrase banks + the user's own details —
 * no network, no model required (the connected LLM can of course out-write
 * this from the app UI; this is the always-available on-device writer).
 */

import { URDU_PHRASES, URDU_HASHTAGS, pickPhrases, hashtagLine, isRomanUrdu } from './data/urdu.js';

const EN_PHRASES = {
  hook: [
    'Stop scrolling — this one is for {niche} owners in {city}',
    'Why do customers choose your competitor? The answer is simpler than you think',
    '9 out of 10 {niche} businesses make this one marketing mistake',
    'Read this before you spend another rupee on ads',
    'Your next 10 customers are on Facebook right now — are you visible to them?',
    'The free trick big {niche} brands use daily (and never advertise)',
  ],
  problem: [
    'Customers visit, ask the price… and disappear',
    'You post every day but the inbox stays quiet',
    'Ad budget burns, results stay flat',
    'Every month the same struggle: where do new customers come from',
    'Your competitor\'s shop is full while yours waits',
  ],
  offer: [
    'Today we hand you the exact system bigger brands run on — step by step, in plain language',
    'A complete checklist you can apply this week — no jargon, no fluff',
    'One small change in your setup can double the messages you receive',
    'Free consultation: your business, our plan — zero obligation',
    'Limited seats, because every client gets our full attention',
  ],
  proof: [
    'Our clients\' results speak louder than our words',
    'Last month a {niche} in {city} added {number} new customers with this exact flow',
    'This same strategy has been tested across 50+ local businesses',
    'Numbers do not lie — see the screenshots in the comments',
  ],
  urgency: [
    'This offer runs this week only',
    'Seats are filling — message today to hold yours',
    'Decide before the season rush and beat the price hike',
    'Special discount for the first 10 people',
  ],
  cta: [
    'Send "HI" in a message now — we will explain everything',
    'Comment "PLAN" and we will DM you the details',
    'Tap the WhatsApp button — first consultation is free',
    'Register from the link in bio',
    'Share this with a friend whose business has been slow',
  ],
  festival: [
    'The season has started — is your business ready for the rush?',
    'People are browsing more than ever this month — be where they look',
    'Every day counts now — start before your competitors do',
  ],
};

const PRINCIPLE_NOTES = {
  hook: 'pattern-interrupt + call-out (the reader feels personally addressed)',
  problem: 'loss aversion (the pain of staying the same)',
  offer: 'reciprocity + clarity (value stated before the ask)',
  proof: 'social proof (similar others, specific numbers)',
  urgency: 'honest scarcity (a real, stated limit)',
  cta: 'one friction-free next step (the easiest yes)',
  festival: 'timing relevance (buying intent is already high)',
};

function fill(tpl, b) {
  // accepts both {city} and [city] placeholder styles (the Urdu banks use [])
  return String(tpl)
    .replace(/[\{\[](city)[\}\]]/g, b.city || 'your city')
    .replace(/[\{\[](business)[\}\]]/g, b.business || 'your business')
    .replace(/[\{\[](niche)[\}\]]/g, b.niche || b.business || 'local')
    .replace(/[\{\[](offer)[\}\]]/g, b.offer || '')
    .replace(/[\{\[](price)[\}\]]/g, b.price || '')
    .replace(/[\{\[](number)[\}\]]/g, b.number || '15-20')
    .replace(/[\{\[](audience)[\}\]]/g, b.audience || '');
}

function pick(bank, i, seed) {
  const arr = bank || [];
  if (!arr.length) return '';
  return arr[(i + Math.abs(hash(seed))) % arr.length];
}

function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Generate post descriptions.
 * @param {object} brief {business, niche, city, offer, price, audience, number,
 *                        kind: 'general'|'sale'|'festival'|'ads',
 *                        language: 'auto'|'en'|'ur', tone?: string}
 * @returns {{variants: string[], language: 'en'|'ur', principles: string[], hashtags: string}}
 */
export function generateDescription(brief = {}) {
  const b = { kind: 'general', language: 'auto', ...brief };
  const urdu = b.language === 'ur' ||
    (b.language === 'auto' && isRomanUrdu(`${b.business || ''} ${b.offer || ''} ${b.tone || ''}`).isUrdu);
  const bank = urdu ? URDU_PHRASES : EN_PHRASES;
  const seed = `${b.business}|${b.city}|${b.offer}|${Date.now()}`;
  const variants = [];

  for (let v = 0; v < 3; v += 1) {
    const lines = [];
    const hook = fill(pick(bank.hook, v, seed + v), b);
    lines.push(hook);
    lines.push('');
    if (b.kind === 'festival') lines.push(fill(pick(bank.festival, v, seed + v), b));
    lines.push(fill(pick(bank.problem, v, seed + v), b));
    lines.push('');
    const offer = fill(pick(bank.offer, v, seed + 'o' + v), b);
    lines.push(b.offer ? `${offer}${b.price ? ` — ${fill(b.price, b)}` : ''}` : offer);
    if (b.business) lines.push(urdu ? `${fill(b.business, b)} — ${fill(b.city || 'shehar', b)} mein bharose ka naam.` : `${fill(b.business, b)} — trusted in ${fill(b.city || 'town', b)}.`);
    lines.push('');
    lines.push(fill(pick(bank.proof, v, seed + 'p' + v), b));
    if (b.kind === 'sale' || b.kind === 'festival') {
      lines.push(fill(pick(bank.urgency, v, seed + 'u' + v), b));
    }
    lines.push('');
    lines.push(fill(pick(bank.cta, v, seed + 'c' + v), b));
    variants.push(lines.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim());
  }

  const hashKind = b.kind === 'festival' ? 'festival' : (b.kind === 'ads' ? 'ads' : (b.kind === 'sale' ? 'sale' : 'general'));
  const hashtags = hashtagLine(hashKind, 6, b.city);

  const used = ['hook', 'problem', 'offer', 'proof', 'cta'];
  if (b.kind === 'sale' || b.kind === 'festival') used.push('urgency');
  if (b.kind === 'festival') used.push('festival');

  return {
    variants,
    language: urdu ? 'ur' : 'en',
    principles: used.map((k) => `${k}: ${PRINCIPLE_NOTES[k]}`),
    hashtags,
  };
}

export function copygenStats() {
  return {
    englishPhrases: Object.values(EN_PHRASES).reduce((n, a) => n + a.length, 0),
    urduPhrases: Object.values(URDU_PHRASES).reduce((n, a) => n + a.length, 0),
    kinds: Object.keys(URDU_HASHTAGS).length,
  };
}
