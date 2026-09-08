/**
 * On-device hybrid retrieval — the same tuned maths as server/retrieval.py:
 * calibrated vector cosine + BM25, embedder-aware fusion, an evidence gate so
 * hash collisions never count as "grounded", recency re-rank, whole-sentence
 * quotes and the quote floor that keeps weak matches out of the answer body.
 */

import { cosine, embedQuery, NOISE_FLOOR, REFERENCE_SIMILARITY, FUSION } from './embed.js';
import { bestSentences, queryTerms, humanTime } from './text.js';

export const MIN_GROUNDING = 0.20;
export const GATE_MULTIPLE = 2.2;
export const LEXICAL_CAP = 0.42;          // vector-only hits from a lexical embedder
export const RECENCY_HALFLIFE_DAYS = 14;

export function quoteFloor(bestRelevance) {
  // Adaptive: a grounded answer (best >= 0.20) must always be able to cite
  // its best match — a fixed 0.50 floor silently produced "grounded" answers
  // with an empty lesson body. Never above the best score itself.
  return Math.min(bestRelevance, Math.max(MIN_GROUNDING, bestRelevance * 0.55));
}

/**
 * @param {Array} chunks  on-device chunks: {id, pageId, title, text, pageText,
 *                        vec, url, domain, domainLabel, visitedAt, dwellSeconds,
 *                        visitCount, source}
 * @param {LexicalIndex} index
 * @param {string} query
 */
export function retrieve(chunks, index, query, { topK = 8 } = {}) {
  const started = Date.now();
  const terms = queryTerms(query);
  const out = {
    query, terms, grounded: false, bestRelevance: 0, matches: [],
    evidence: { lexical: false, vector: false }, tookMs: 0, engine: 'on-device hybrid',
  };
  if (!chunks.length || !terms.length) { out.tookMs = Date.now() - started; return out; }

  const qvec = embedQuery(terms.join(' '));
  const lexScores = index.search(terms, 80);

  const perChunk = [];
  for (const chunk of chunks) {
    if (!chunk.vec || !chunk.vec.length) continue;   // defensive: never crash on vector-less rows
    const raw = cosine(qvec, chunk.vec);
    const vecCal = Math.max(0, Math.min(1, raw / REFERENCE_SIMILARITY));
    const bm25 = lexScores.get(chunk.id) || 0;
    const lexNorm = bm25 > 0 ? bm25 / (bm25 + 5) : 0;

    let relevance;
    if (vecCal > 0 && lexNorm > 0) {
      relevance = FUSION.vec * vecCal + FUSION.lex * lexNorm;
    } else if (vecCal > 0) {
      relevance = FUSION.soloVec * vecCal;
    } else {
      relevance = FUSION.soloLex * lexNorm;
    }
    // a lexical embedder with zero lexical coverage is almost always a
    // character-n-gram collision ("mode" vs "model") — cap it hard
    if (lexNorm === 0) relevance = Math.min(relevance, LEXICAL_CAP);
    if (relevance <= 0.01) continue;
    perChunk.push({ chunk, raw, vecCal, bm25, lexNorm, relevance });
  }
  if (!perChunk.length) { out.tookMs = Date.now() - started; return out; }
  perChunk.sort((a, b) => b.relevance - a.relevance);

  // page level: best chunk wins, sentences come from the whole page text
  const byPage = new Map();
  for (const item of perChunk) {
    const pageId = item.chunk.pageId;
    const existing = byPage.get(pageId);
    if (!existing || item.relevance > existing.relevance) byPage.set(pageId, item);
  }
  const now = Date.now();
  const pages = [...byPage.values()].map((item) => {
    const ageDays = Math.max(0, (now - Date.parse(item.chunk.visitedAt || now)) / 86400000);
    const recency = Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
    const final = 0.7 * item.relevance + 0.3 * recency;
    return {
      pageId: item.chunk.pageId,
      url: item.chunk.url,
      title: item.chunk.title,
      domain: item.chunk.domain,
      domainLabel: item.chunk.domainLabel || item.chunk.domain,
      visitedAt: item.chunk.visitedAt,
      visitedAgo: humanTime(item.chunk.visitedAt),
      dwellSeconds: item.chunk.dwellSeconds || 0,
      visitCount: item.chunk.visitCount || 1,
      source: item.chunk.source || 'extension',
      assistantFetched: item.chunk.source === 'web_enrichment',
      text: item.chunk.pageText || item.chunk.text,
      excerpt: item.chunk.text,
      sentences: bestSentences(item.chunk.pageText || item.chunk.text, terms, 3,
                               item.chunk.title),
      scores: {
        relevance: round4(item.relevance), final: round4(final),
        vectorRaw: round4(item.raw), lexical: round4(item.bm25),
      },
    };
  });
  pages.sort((a, b) => b.scores.final - a.scores.final);

  out.matches = pages.slice(0, topK);
  out.bestRelevance = out.matches[0] ? out.matches[0].scores.relevance : 0;

  const top3 = perChunk.slice(0, 3);
  out.evidence.lexical = top3.some((c) => c.bm25 > 0);
  out.evidence.vector = top3.some((c) => c.raw >= GATE_MULTIPLE * NOISE_FLOOR);
  out.grounded = out.bestRelevance >= MIN_GROUNDING &&
                 (out.evidence.lexical || out.evidence.vector);
  out.tookMs = Date.now() - started;
  return out;
}

function round4(value) { return Math.round(value * 10000) / 10000; }

/** Cheap "pages related to this topic" list for the explainer's further reading. */
export function relatedPages(chunks, terms, excludePageId, limit = 4) {
  const wanted = new Set(terms.map((t) => t.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const chunk of chunks) {
    if (chunk.pageId === excludePageId) continue;
    if (seen.has(chunk.pageId)) continue;
    const hay = `${chunk.title} ${chunk.text.slice(0, 400)}`.toLowerCase();
    let hits = 0;
    for (const term of wanted) if (hay.includes(term)) hits += 1;
    if (hits >= Math.min(2, wanted.size)) {
      seen.add(chunk.pageId);
      out.push({ pageId: chunk.pageId, title: chunk.title, url: chunk.url,
                 domain: chunk.domain, visitedAgo: humanTime(chunk.visitedAt) });
    }
    if (out.length >= limit) break;
  }
  return out;
}
