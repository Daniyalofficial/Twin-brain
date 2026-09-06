/**
 * On-device hashing embedder — the JS twin of server/embeddings/hashing.py.
 *
 * Same feature engineering (sublinear unigrams, bigrams, char 3/4-grams, a
 * readable concept lexicon, length prior), same 384-dim signed feature hashing.
 * The bucket hash differs from Python's blake2b (browsers have no blake2b), so
 * on-device vectors live in the on-device database — they are never mixed with
 * backend vectors. Everything is deterministic: no downloads, no network.
 */

import { contentWords, STOPWORDS } from './text.js';

export const DIM = 384;
export const NAME = 'hash-v1-ondevice';
/** Measured on the Python twin over unrelated pairs; same statistics apply. */
export const NOISE_FLOOR = 0.06;
export const REFERENCE_SIMILARITY = 0.18;
/** (vecWeight, lexWeight, soloVec, soloLex) — tuned for lexical-based embedders. */
export const FUSION = { vec: 0.45, lex: 0.55, soloVec: 0.55, soloLex: 0.95 };

const CONCEPTS = {
  cooking: ['recipe', 'recipes', 'cook', 'cooking', 'bake', 'baking', 'kitchen',
    'ingredients', 'dish', 'meal', 'dinner', 'lunch', 'breakfast', 'food', 'cuisine',
    'chef', 'oven', 'pan', 'sauce', 'tasty', 'delicious', 'servings', 'tablespoon',
    'teaspoon', 'simmer', 'saute', 'marinate'],
  programming: ['code', 'coding', 'program', 'programming', 'developer', 'software',
    'engineer', 'api', 'function', 'variable', 'debug', 'compiler', 'repository',
    'commit', 'framework', 'library', 'algorithm', 'syntax', 'runtime', 'backend',
    'frontend', 'script'],
  python: ['python', 'django', 'flask', 'pandas', 'numpy', 'pytest', 'pip',
    'jupyter', 'cpython', 'pythonic'],
  javascript: ['javascript', 'typescript', 'react', 'vue', 'node', 'nodejs', 'npm',
    'dom', 'es6', 'jsx', 'nextjs', 'webpack', 'vite'],
  ai: ['ai', 'artificial', 'intelligence', 'machine', 'learning', 'neural', 'model',
    'llm', 'gpt', 'transformer', 'embedding', 'inference', 'training', 'dataset',
    'prompt', 'agent', 'rag'],
  database: ['database', 'sql', 'sqlite', 'postgres', 'postgresql', 'mysql', 'mongo',
    'mongodb', 'index', 'query', 'schema', 'table', 'join', 'orm', 'migration', 'nosql'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'malware', 'phishing',
    'encryption', 'tls', 'ssl', 'authentication', 'authorization', 'privacy', 'breach',
    'firewall', 'ransomware'],
  health: ['health', 'medical', 'doctor', 'symptom', 'symptoms', 'treatment', 'disease',
    'therapy', 'medicine', 'clinical', 'patient', 'diagnosis', 'nutrition', 'vitamin',
    'exercise', 'fitness', 'workout'],
  finance: ['finance', 'investing', 'investment', 'stocks', 'stock', 'market', 'trading',
    'portfolio', 'budget', 'savings', 'tax', 'taxes', 'mortgage', 'loan', 'interest',
    'inflation', 'crypto', 'bitcoin'],
  travel: ['travel', 'trip', 'flight', 'flights', 'hotel', 'hotels', 'airport', 'visa',
    'passport', 'itinerary', 'destination', 'tourism', 'booking', 'luggage', 'airbnb'],
  shopping: ['buy', 'price', 'prices', 'deal', 'deals', 'discount', 'sale', 'amazon',
    'shop', 'shopping', 'cart', 'checkout', 'order', 'delivery', 'shipping', 'review',
    'reviews', 'best', 'cheap'],
  news: ['news', 'breaking', 'headline', 'report', 'reporter', 'journalism', 'press',
    'article', 'update', 'politics', 'election', 'government'],
  design: ['design', 'ui', 'ux', 'layout', 'typography', 'color', 'colour', 'figma',
    'css', 'sketch', 'wireframe', 'branding', 'logo'],
  learning: ['tutorial', 'course', 'learn', 'learning', 'guide', 'documentation', 'docs',
    'example', 'beginner', 'advanced', 'lesson', 'training', 'certification', 'book',
    'lecture', 'university', 'student'],
  work: ['job', 'jobs', 'career', 'hiring', 'interview', 'resume', 'cv', 'salary',
    'remote', 'office', 'meeting', 'project', 'manager', 'freelance', 'contract'],
  music: ['music', 'song', 'songs', 'album', 'artist', 'band', 'guitar', 'piano',
    'spotify', 'playlist', 'concert', 'audio', 'track'],
  gaming: ['game', 'games', 'gaming', 'player', 'steam', 'playstation', 'xbox',
    'nintendo', 'gameplay', 'esports', 'quest', 'level'],
  science: ['science', 'research', 'study', 'paper', 'physics', 'chemistry', 'biology',
    'experiment', 'theory', 'journal', 'scientist', 'nasa'],
  home: ['home', 'house', 'apartment', 'furniture', 'garden', 'diy', 'repair', 'decor',
    'kitchen', 'bedroom', 'cleaning', 'renovation'],
  auto: ['car', 'cars', 'vehicle', 'driving', 'engine', 'tire', 'tyre', 'ev',
    'electric', 'tesla', 'toyota', 'honda', 'mechanic'],
};

const CONCEPT_OF = new Map();
for (const [concept, words] of Object.entries(CONCEPTS)) {
  for (const word of words) {
    if (!CONCEPT_OF.has(word)) CONCEPT_OF.set(word, []);
    CONCEPT_OF.get(word).push(concept);
  }
}

// --- deterministic 32-bit hashing (FNV-1a + avalanche mix) -------------------
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
function bucket(feature) {
  const idx = mix32(fnv1a(feature, 0x811c9dc5)) % DIM;
  const sign = (mix32(fnv1a(feature, 0x9dc5811b)) & 1) ? 1.0 : -1.0;
  return [idx, sign];
}

const featureCache = new Map();   // text -> feature map (SW lifetime)

export function features(text) {
  const cached = featureCache.get(text);
  if (cached) return cached;
  const words = (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'+#.-]*/g)) || [];
  const content = words.filter((w) => !STOPWORDS.has(w) && w.length > 1);
  const feats = new Map();
  const add = (key, weight) => feats.set(key, (feats.get(key) || 0) + weight);

  const counts = new Map();
  for (const w of content) counts.set(w, (counts.get(w) || 0) + 1);

  for (const [w, c] of counts) add(`w:${w}`, 1.0 + Math.log(c));           // unigrams
  for (let i = 0; i < content.length - 1; i += 1) {                        // bigrams
    add(`b:${content[i]}_${content[i + 1]}`, 1.35);
  }
  for (const [w, c] of counts) {                                           // char n-grams
    if (w.length < 4) continue;
    const weight = 0.42 * (1.0 + Math.log(c));
    for (const n of [3, 4]) {
      if (w.length < n) continue;
      const grams = new Set();
      for (let i = 0; i <= w.length - n; i += 1) grams.add(w.slice(i, i + n));
      const per = weight / (grams.size * 2);
      for (const g of grams) add(`c${n}:${g}`, per);
    }
  }
  const conceptHits = new Map();                                           // concepts
  for (const [w, c] of counts) {
    for (const concept of (CONCEPT_OF.get(w) || [])) {
      conceptHits.set(concept, (conceptHits.get(concept) || 0) + Math.log1p(c));
    }
  }
  for (const [concept, score] of conceptHits) {
    add(`k:${concept}`, 0.55 + 0.30 * Math.log1p(score));
  }

  const norm = 1.0 / Math.sqrt(Math.log(2 + content.length));
  for (const [k, v] of feats) feats.set(k, v * norm);
  if (featureCache.size > 4000) featureCache.clear();
  featureCache.set(text, feats);
  return feats;
}

function toVector(feats) {
  const vec = new Float32Array(DIM);
  for (const [feature, weight] of feats) {
    const [idx, sign] = bucket(feature);
    vec[idx] += sign * weight;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-12) for (let i = 0; i < DIM; i += 1) vec[i] /= norm;
  return vec;
}

export function embed(text) {
  return toVector(features(text));
}

/** Queries repeat their content terms once, like the Python twin, so a short
 *  question carries comparable signal to a long page. */
export function embedQuery(text) {
  const words = contentWords(text);
  if (!words.length) return new Float32Array(DIM);
  const boosted = `${text} ${words.join(' ')}`;
  const feats = features(boosted);
  for (const w of new Set(words)) {
    for (const concept of (CONCEPT_OF.get(w) || [])) {
      feats.set(`k:${concept}`, (feats.get(`k:${concept}`) || 0) + 0.9);
    }
  }
  return toVector(feats);
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < DIM; i += 1) dot += a[i] * b[i];
  return dot;   // both sides are L2-normalised
}
