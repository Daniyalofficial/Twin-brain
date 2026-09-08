/**
 * Multi-hop research — when one search is not enough, the AI keeps digging.
 *
 * hop 1: search the question (spiced with the user's interests)
 * hop 2: measure coverage — which question words did the results actually
 *        answer? Build a refined query from the gaps and search again.
 * hop 3: deep-read the best page when snippets are too thin.
 *
 * Bounded by maxHops + the daily budget, audited per query, and only ever
 * called after the permission protocol said yes. search/fetch are injected so
 * the whole loop is unit-testable without a network.
 */

import { contentWords } from './text.js';

export function coverageScore(query, results) {
  const words = contentWords(query).filter((w) => w.length > 2);
  if (!words.length || !results.length) return 0;
  const hay = results.map((r) => `${r.title} ${r.snippet || ''}`).join(' ').toLowerCase();
  let hits = 0;
  for (const word of words) if (hay.includes(word.toLowerCase())) hits += 1;
  return Math.round((hits / words.length) * 100) / 100;
}

export function refinedQuery(query, results) {
  const words = contentWords(query).filter((w) => w.length > 2);
  const hay = (results || []).map((r) => `${r.title} ${r.snippet || ''}`).join(' ').toLowerCase();
  const missing = words.filter((w) => !hay.includes(w.toLowerCase()));
  const kept = words.filter((w) => hay.includes(w.toLowerCase())).slice(0, 3);
  const parts = [...kept, ...missing.slice(0, 3), 'explained'];
  return [...new Set(parts)].join(' ').slice(0, 140);
}

/**
 * @param {string} query
 * @param {object} deps {search(q)->{results,status}, fetchPage(result)->{title,text}|null,
 *                 audit(entry), budgetRemaining():number, consumeBudget()}
 * @param {object} opts {maxHops=3, deepRead=true, interests=[], note(text)}
 */
export async function researchLoop(query, deps, opts = {}) {
  const maxHops = Number(opts.maxHops || 3);
  const interests = opts.interests || [];
  const note = opts.note || (() => {});
  const log = { query, hops: [], results: [], pagesRead: 0, status: 'ok' };

  const extra = interests
    .map((i) => i.topic || i)
    .filter((topic) => topic && !query.toLowerCase().includes(String(topic).toLowerCase()))
    .slice(0, 2);

  let currentQuery = `${query} ${extra.join(' ')}`.trim().slice(0, 140);
  let allResults = [];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    if (deps.budgetRemaining && deps.budgetRemaining() <= 0) {
      log.status = 'budget';
      break;
    }
    note(hop === 1 ? 'searching the web live…' : `not enough yet — refining and searching again (hop ${hop})…`);
    let entry;
    try {
      entry = await deps.search(currentQuery);
    } catch (error) {
      log.status = `error: ${String(error.message || error).slice(0, 100)}`;
      break;
    }
    if (deps.consumeBudget) await deps.consumeBudget();
    if (deps.audit) {
      try { await deps.audit(Object.assign({ hop, kind: 'web_search' }, entry, { query: currentQuery })); } catch { /* keep going */ }
    }
    const results = (entry && entry.results) || [];
    log.hops.push({ hop, query: currentQuery, count: results.length,
                    coverage: coverageScore(query, results) });
    if (!results.length) {
      if (hop === 1) log.status = 'no_results';
      break;
    }
    let added = 0;
    for (const result of results) {
      if (!allResults.some((r) => r.url === result.url)) { allResults.push(result); added += 1; }
    }

    const coverage = coverageScore(query, allResults);
    const hasSubstance = allResults.some((r) => r.deepText || (r.snippet && r.snippet.length >= 60));
    // enough coverage AND something real to read — or refining stops finding
    // anything new (diminishing returns: don't burn budget for nothing)
    if (coverage >= 0.75 && (hasSubstance || added === 0)) break;

    if (hop < maxHops) {
      if (opts.deepRead !== false && deps.fetchPage && (!hasSubstance || coverage < 0.4)) {
        const best = allResults[0];
        note(`reading “${String(best.title || '').slice(0, 46)}” in full…`);
        try {
          const page = await deps.fetchPage(best);
          if (page && page.text && page.text.length > 200) {
            log.pagesRead += 1;
            best.deepText = page.text;
            best.deepTitle = page.title || best.title;
            if (deps.audit) {
              try { await deps.audit({ kind: 'deep_read', hop, url: best.url, status: 'read' }); } catch { /* ok */ }
            }
          }
        } catch (error) {
          if (deps.audit) {
            try { await deps.audit({ kind: 'deep_read', hop, url: best.url, status: `error: ${String(error.message).slice(0, 80)}` }); } catch { /* ok */ }
          }
        }
      }
      currentQuery = refinedQuery(query, allResults);
    }
  }

  log.results = allResults;
  return log;
}
