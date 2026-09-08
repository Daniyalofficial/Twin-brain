/**
 * ROMAN-URDU DESK — detection + the phrase banks MarketerTwin writes with.
 *
 *  1. isRomanUrdu(): marker-word scoring, so the twin replies in the same
 *     language the user typed (English or Roman Urdu) and the FB description
 *     generator picks the right voice.
 *  2. Phrase banks by persuasion role (hook / problem / offer / proof /
 *     urgency / CTA / festival) — natural marketing Roman Urdu, ready for
 *     template-free recomposition in posts and ad copy.
 *  3. Bilingual hashtag banks.
 *
 * All original phrasing written for MarketerTwin.
 */

// ---------------------------------------------------------------------------
// 1. detection
// ---------------------------------------------------------------------------

export const ROMAN_MARKERS = [
  'hai', 'hain', 'tha', 'thi', 'the', 'ho', 'hota', 'hoti', 'hote', 'kya', 'kyu',
  'kyun', 'kaise', 'kaisa', 'kaisi', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'me',
  'par', 'pe', 'aur', 'ya', 'bhi', 'nahi', 'nahin', 'mujhe', 'mera', 'meri',
  'mere', 'tum', 'tumhe', 'aap', 'apka', 'hum', 'hamara', 'woh', 'yeh', 'jo',
  'kab', 'kahan', 'kitna', 'kitne', 'kitni', 'acha', 'achi', 'bhai', 'yaar',
  'karo', 'karun', 'karna', 'karne', 'karta', 'karti', 'raha', 'rahi', 'diya',
  'dena', 'dijiye', 'batao', 'batana', 'bataye', 'sun', 'suno', 'ruk', 'chalo',
  'theek', 'sahi', 'zyada', 'kam', 'bohat', 'bahut', 'thoda', 'jaldi', 'der',
  'paisa', 'paise', 'paisay', 'rupee', 'dukaan', 'log', 'logon', 'banda',
  'shukriya', 'salam', 'assalam', 'allah', 'hafiz', 'khuda', 'g', 'sb',
];

const MARKER_SET = new Set(ROMAN_MARKERS);
const ENGLISH_HEAVY = new Set(['the', 'is', 'are', 'was', 'were', 'this', 'that',
  'what', 'when', 'where', 'which', 'your', 'with', 'have', 'has', 'for', 'and']);

/**
 * Score-based Roman-Urdu detection. Returns {isUrdu, ratio}.
 * Two or more distinct markers (or a high marker ratio) wins.
 */
export function isRomanUrdu(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z']+/).filter(Boolean);
  if (!words.length) return { isUrdu: false, ratio: 0 };
  let markers = 0;
  const distinct = new Set();
  let english = 0;
  for (const w of words) {
    if (MARKER_SET.has(w)) { markers += 1; distinct.add(w); }
    if (ENGLISH_HEAVY.has(w)) english += 1;
  }
  const ratio = markers / words.length;
  const isUrdu = (distinct.size >= 2 && english <= distinct.size) || ratio >= 0.28;
  return { isUrdu, ratio: Math.round(ratio * 100) / 100 };
}

// ---------------------------------------------------------------------------
// 2. phrase banks by persuasion role
// ---------------------------------------------------------------------------

export const URDU_PHRASES = {
  hook: [
    'Ruk jao — yeh post aapke liye hai',
    'Ek sawal: aapka business online kyun nahi barh raha?',
    'Yeh galti 9 out of 10 local businesses kar rahe hain',
    'Agar aap [city] mein business karte ho to yeh zaroor parho',
    'Log aapke competitors se kyun khareed rahe hain? Wajah simple hai',
    'Free mein seekho — jo agencies 50,000 le kar batati hain',
    'Aapki ad dekh kar log scroll kyun kar dete hain?',
    'Sirf 30 second mein samajh aa jayega',
  ],
  problem: [
    'Customers aate hain par tikte nahi',
    'Post to roz karte ho, lekin message koi nahi bhejta',
    'Ad budget jal raha hai aur result zero hai',
    'Phone ghanta hai, order nahi',
    'Har mahine wahi problem: naye customers kahan se layein',
    'Competitor ki shop bhari hai aur aapki khali',
    'Log price pooch kar ghayab ho jate hain',
  ],
  offer: [
    'Aaj hum aapko exactly wahi system denge jo baray brands use karte hain',
    'Complete step-by-step guide — Urdu mein, aasan lafzon mein',
    'Ek chhoti si setting badalne se results double ho sakte hain',
    'Yeh checklist save kar lo — kabhi kaam aayegi',
    'Free consultation: aapka business, humara plan',
    'Limited seats — har client ko poora waqt dena hai is liye',
  ],
  proof: [
    'Hamare clients ke results khud bolte hain',
    'Pichle mahine [niche] business ko [number] naye customers mile',
    'Yehi strategy 50+ local businesses pe azmai gayi hai',
    'Screenshot dekhein — numbers jhoot nahi bolte',
    'Client ne khud kaha: pehli baar samajh aya ke marketing hoti kya hai',
  ],
  urgency: [
    'Offer sirf is hafte ke liye hai',
    'Seats khatam hone wali hain — aaj hi message karein',
    'Eid se pehle shuru karna hai to abhi decide karein',
    'Kal se price barh jayegi',
    'Pehle 10 logon ke liye special discount',
  ],
  cta: [
    'Abhi "HI" ka message bhejein — hum detail mein batate hain',
    'Comment mein "PLAN" likhein, hum DM kar denge',
    'WhatsApp button dabayein — pehli consultation free hai',
    'Bio ke link se register karein',
    'Aaj hi book karein — kal ki slot bhar sakti hai',
    'Share karein us dost ke sath jiska business slow chal raha hai',
  ],
  festival: [
    'Eid ki tayyari shuru — aapka business tayyar hai?',
    'Ramazan ke mahine log online zyada dekhte hain — fayda uthayein',
    'Shaadi season aa gaya — ab har din qeemti hai',
    '14 August sale — customers wait kar rahe hain',
    'Winter season stock aa gaya — pehle aao, pehle pao',
  ],
};

// ---------------------------------------------------------------------------
// 3. hashtag banks
// ---------------------------------------------------------------------------

export const URDU_HASHTAGS = {
  general: ['#Business', '#Marketing', '#Pakistan', '#ChotaKarobar', '#OnlineBusiness'],
  local: ['#Lahore', '#Karachi', '#Islamabad', '#LocalBusiness', '#MadeInPakistan'],
  ads: ['#MetaAds', '#FacebookAds', '#InstagramAds', '#DigitalMarketing', '#AdTips'],
  sale: ['#Sale', '#Discount', '#Offer', '#OrderNow', '#FreeDelivery'],
  festival: ['#Eid', '#EidSale', '#Ramadan', '#ShaadiSeason', '#IndependenceDay'],
};

/** Pick n items from a bank without repeats (stable for a given seed string). */
export function pickPhrases(bank, n = 1, seed = '') {
  const arr = URDU_PHRASES[bank] || [];
  if (!arr.length) return [];
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const start = Math.abs(h) % arr.length;
  const out = [];
  for (let i = 0; i < Math.min(n, arr.length); i += 1) out.push(arr[(start + i) % arr.length]);
  return out;
}

/** Build a hashtag line: n general + role-specific tags. */
export function hashtagLine(kind = 'general', n = 6, city = '') {
  const pool = (URDU_HASHTAGS[kind] || URDU_HASHTAGS.general).concat(URDU_HASHTAGS.general);
  const out = [];
  if (city) out.push(`#${city.replace(/\s+/g, '')}`);
  for (const tag of pool) {
    if (out.length >= n) break;
    if (!out.includes(tag)) out.push(tag);
  }
  return out.join(' ');
}

export function urduDataSize() {
  return {
    markers: ROMAN_MARKERS.length,
    phrases: Object.values(URDU_PHRASES).reduce((n, arr) => n + arr.length, 0),
    banks: Object.keys(URDU_PHRASES).length,
    hashtagKinds: Object.keys(URDU_HASHTAGS).length,
  };
}
