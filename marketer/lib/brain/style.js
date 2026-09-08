/**
 * STYLE LEARNING — the twin watches how YOU write and adapts.
 *
 * Every user message (chat, description briefs, recorded write-steps) feeds a
 * lightweight deterministic profiler: language mix, message length, question
 * habits, emoji/exclamation style, greeting words, favourite vocabulary.
 * The profile is stored in the `style` store and injected into LLM prompts so
 * replies mirror the user — and shown honestly in Settings as derived
 * statistics (never invented psychology).
 */

import * as store from '../store.js';
import { isRomanUrdu } from './data/urdu.js';
import { contentWords } from './text.js';

const MAX_WORD_SAMPLES = 40;

function emptyProfile() {
  return {
    samples: 0,
    urduSamples: 0,
    totalWords: 0,
    totalChars: 0,
    questions: 0,
    exclamations: 0,
    emojis: 0,
    capsWords: 0,
    greetings: {},          // salam/hi/hey/assalam counts
    topWords: {},           // word -> count (capped vocabulary)
    firstSeen: null,
    lastSeen: null,
  };
}

const GREETINGS = ['assalam', 'salam', 'hi', 'hey', 'hello', 'aoa', 'good morning', 'good evening'];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/** Feed one user text into the profile. Fire-and-forget; never throws. */
export async function learnFromText(text, source = 'chat') {
  try {
    const s = String(text || '').trim();
    if (s.length < 3 || s.length > 4000) return;
    const row = await store.getStyle('profile');
    const p = { ...emptyProfile(), ...(row && row.value ? row.value : {}) };
    p.samples += 1;
    p.lastSeen = new Date().toISOString();
    if (!p.firstSeen) p.firstSeen = p.lastSeen;
    const words = s.toLowerCase().split(/\s+/).filter(Boolean);
    p.totalWords += words.length;
    p.totalChars += s.length;
    if (/\?$/.test(s) || /^(?:what|how|why|when|kya|kaise|kaun|kab|kitna|kitne)\b/i.test(s)) p.questions += 1;
    if (/!/.test(s)) p.exclamations += 1;
    if (EMOJI_RE.test(s)) p.emojis += 1;
    if (isRomanUrdu(s).isUrdu) p.urduSamples += 1;
    for (const w of words) {
      if (/^[A-Z]{2,}$/.test(w)) p.capsWords += 1;
    }
    const lower = s.toLowerCase();
    for (const g of GREETINGS) {
      if (lower.includes(g)) p.greetings[g] = (p.greetings[g] || 0) + 1;
    }
    for (const w of contentWords(s)) {
      if (w.length < 3) continue;
      p.topWords[w] = (p.topWords[w] || 0) + 1;
    }
    // keep the vocabulary bounded
    const entries = Object.entries(p.topWords);
    if (entries.length > 250) {
      entries.sort((a, b) => b[1] - a[1]);
      p.topWords = Object.fromEntries(entries.slice(0, 250));
    }
    await store.putStyle('profile', p);
    if (source === 'reset') await store.putStyle('profile', emptyProfile());
  } catch { /* style learning must never break a conversation */ }
}

/** Human-readable profile for prompts and the Settings screen. */
export async function styleProfile() {
  const row = await store.getStyle('profile');
  const p = row && row.value ? row.value : emptyProfile();
  if (!p.samples) return { stats: p, summaryText: '', learned: false };

  const urduPct = Math.round((p.urduSamples / p.samples) * 100);
  const lang = urduPct >= 60 ? 'mostly Roman Urdu' : urduPct >= 25 ? 'mixed English + Roman Urdu' : 'mostly English';
  const avgWords = Math.round(p.totalWords / p.samples);
  const length = avgWords <= 8 ? 'very short messages' : avgWords <= 18 ? 'short, direct messages' : 'longer, detailed messages';
  const qRate = Math.round((p.questions / p.samples) * 100);
  const asker = qRate >= 60 ? 'asks a lot of direct questions' : qRate >= 30 ? 'mixes questions with statements' : 'mostly makes statements';
  const bits = [`${p.samples} messages observed`, `writes ${lang}`, `${length} (avg ${avgWords} words)`, asker];
  if (p.emojis / p.samples >= 0.2) bits.push('uses emoji often');
  else if (p.emojis === 0) bits.push('never uses emoji');
  if (p.exclamations / p.samples >= 0.3) bits.push('energetic tone (!)');
  const greet = Object.entries(p.greetings || {}).sort((a, b) => b[1] - a[1])[0];
  if (greet) bits.push(`typical greeting: "${greet[0]}"`);
  const top = Object.entries(p.topWords || {})
    .filter(([w]) => w.length >= 4 && !['kaise', 'karun', 'karna', 'chahiye', 'please', 'about', 'what'].includes(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WORD_SAMPLES && 8)
    .map(([w]) => w);
  if (top.length) bits.push(`favourite words: ${top.join(', ')}`);

  return {
    stats: p,
    summaryText: bits.join(' · '),
    learned: true,
  };
}

/** The prompt block injected into LLM system prompts. */
export async function stylePromptBlock() {
  const { summaryText, learned } = await styleProfile();
  if (!learned) return '';
  return `USER WRITING STYLE (learned from their own messages — mirror it naturally, never mention that you analysed them): ${summaryText}.`;
}
