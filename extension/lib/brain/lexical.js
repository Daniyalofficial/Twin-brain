/**
 * On-device BM25 index — JS twin of server/lexical.py's rescoring.
 * Lucene-style IDF (log(1+x)), K1=1.4, B=0.72, coverage multiplier,
 * porter-lite prefix tolerance and a title boost.
 */

import { stem, tokenize, STOPWORDS } from './text.js';

const K1 = 1.4;
const B = 0.72;
export const TITLE_BOOST = 2.4;

export class LexicalIndex {
  constructor() {
    this.docs = new Map();      // id -> {tokens:[], titleTokens:[], len, titleLen}
    this.df = new Map();        // stemmed term -> doc count
    this.avgLen = 120;
    this.dirty = true;
  }

  clear() { this.docs.clear(); this.df.clear(); this.dirty = true; }

  add(id, title, text) {
    this.remove(id);
    const tokens = tokenize(text).filter((w) => !STOPWORDS.has(w)).map(stem);
    const titleTokens = tokenize(title).filter((w) => !STOPWORDS.has(w)).map(stem);
    this.docs.set(id, { tokens, titleTokens, len: tokens.length || 1 });
    const seen = new Set([...tokens, ...titleTokens]);
    for (const term of seen) this.df.set(term, (this.df.get(term) || 0) + 1);
    this.dirty = true;
  }

  remove(id) {
    const doc = this.docs.get(id);
    if (!doc) return;
    const seen = new Set([...doc.tokens, ...doc.titleTokens]);
    for (const term of seen) {
      const left = (this.df.get(term) || 0) - 1;
      if (left <= 0) this.df.delete(term); else this.df.set(term, left);
    }
    this.docs.delete(id);
    this.dirty = true;
  }

  get size() { return this.docs.size; }

  _refreshAvg() {
    if (!this.docs.size) { this.avgLen = 120; return; }
    let total = 0;
    for (const doc of this.docs.values()) total += doc.len;
    this.avgLen = total / this.docs.size;
  }

  /** -> Map(docId -> bm25 score), title hits boosted. */
  search(terms, limit = 60) {
    if (!this.docs.size || !terms.length) return new Map();
    if (this.dirty) { this._refreshAvg(); this.dirty = false; }
    const N = this.docs.size;
    const scores = new Map();
    const stemmed = terms.map(stem);

    for (const term of new Set(stemmed)) {
      // prefix-tolerant expansion: "embed" should reach "embedding"
      const variants = [{ term, weight: 1.0 }];
      if (term.length >= 4) {
        const prefix = term.slice(0, 4);
        for (const known of this.df.keys()) {
          if (known !== term && known.length >= 4 && known.startsWith(prefix)) {
            variants.push({ term: known, weight: 0.6 });
          }
        }
      }
      for (const variant of variants.slice(0, 8)) {
        const df = this.df.get(variant.term) || 0;
        if (!df) continue;
        // Small-corpus IDF floor: with N=2, every term has df==N and classic
        // BM25 IDF collapses to ~0.3, so obvious title matches ("who are
        // tarzans" over two Tarzan pages) could never clear the evidence gate.
        // Flooring the collection size at 8 keeps big-corpus maths untouched.
        const Neff = Math.max(8, N);
        const idf = Math.log(1 + (Neff - df + 0.5) / (df + 0.5));
        if (idf <= 0) continue;
        for (const [id, doc] of this.docs) {
          const tf = countTerm(doc.tokens, variant.term);
          const tfTitle = countTerm(doc.titleTokens, variant.term);
          if (!tf && !tfTitle) continue;
          const sat = (tf * K1) / (tf + K1 * (1 - B + B * (doc.len / this.avgLen)));
          const titleSat = tfTitle ? TITLE_BOOST * (tfTitle * K1) / (tfTitle + K1) : 0;
          const add = idf * (sat + titleSat) * variant.weight;
          scores.set(id, (scores.get(id) || 0) + add);
        }
      }
    }

    // coverage multiplier: reward docs that touch most of the question
    for (const [id, score] of scores) {
      const doc = this.docs.get(id);
      const have = new Set(doc.tokens.concat(doc.titleTokens));
      let hit = 0;
      for (const t of stemmed) if (have.has(t) || hasPrefix(have, t)) hit += 1;
      const coverage = stemmed.length ? hit / stemmed.length : 0;
      scores.set(id, score * (0.5 + 0.5 * coverage));
    }

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return new Map(sorted);
  }
}

function countTerm(tokens, term) {
  let n = 0;
  for (const t of tokens) if (t === term) n += 1;
  return n;
}

function hasPrefix(set, term) {
  if (term.length < 4) return false;
  const prefix = term.slice(0, 4);
  for (const t of set) if (t.length >= 4 && t.startsWith(prefix)) return true;
  return false;
}
