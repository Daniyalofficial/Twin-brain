/**
 * Direct answers: some questions deserve a straight reply, not an essay.
 *
 * "When did I read about sourdough?" -> the exact date + page, no fluff.
 * "How many pages about Python?"    -> a count and the top titles.
 * "Did I read anything about X?"    -> yes/no with evidence (or an honest no).
 * "What did I read this week?"      -> a recap built from YOUR stored pages.
 * "Compare X and Y"                 -> what your memory holds on each side.
 *
 * Everything here reads only local data; citations are always included.
 */

import { stem, humanTime, fmtDuration, truncate } from './text.js';

function cite(page, n) {
  return {
    n, kind: 'memory', title: page.title || page.url, url: page.url,
    domain: page.domainLabel || page.domain, when: humanTime(page.visitedAt),
    dwell: page.dwellSeconds || 0,
  };
}

function pageMatches(page, stemmed) {
  if (!stemmed.length) return 0;
  const hay = `${page.title || ''} ${String(page.text || '').slice(0, 4000)}`.toLowerCase();
  let hits = 0;
  for (const term of stemmed) {
    const prefix = term.slice(0, 4);
    if (hay.includes(term) || (term.length >= 4 && hay.includes(prefix))) hits += 1;
  }
  return hits / stemmed.length;
}

function sortByMatch(pages, stemmed) {
  return pages
    .map((page) => ({ page, score: pageMatches(page, stemmed) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.page.visitedAt) - Date.parse(a.page.visitedAt));
}

function topicLabel(parsed) {
  return parsed.topicWords.length ? parsed.topicWords.join(' ') : 'that';
}

/**
 * @returns {{text: string, citations: Array, found: boolean} | null}
 */
export function directAnswer(parsed, retrieval, state, opts = {}) {
  const pages = state.pages || [];
  switch (parsed.type) {
    case 'when': return answerWhen(parsed, pages, retrieval);
    case 'count': return answerCount(parsed, pages);
    case 'which_source': return answerWhichSource(parsed, pages);
    case 'verify': return answerVerify(parsed, pages, retrieval);
    case 'recap': return answerRecap(parsed, pages);
    case 'compare': return answerCompare(parsed, pages);
    default: return null;
  }
}

function answerWhen(parsed, pages, retrieval) {
  const best = (retrieval.matches || [])[0];
  const candidate = best
    ? { url: best.url, title: best.title, domain: best.domainLabel || best.domain,
        visitedAt: best.visitedAt, dwellSeconds: best.dwellSeconds, pageId: best.pageId }
    : sortByMatch(pages, parsed.stemmed)[0];
  if (!candidate) {
    return { text: `I have no page about ${topicLabel(parsed)} in your memory, so there's no date to give you. I won't guess one.`,
             citations: [], found: false };
  }
  const page = candidate.pageId
    ? pages.find((p) => p.pageId === candidate.pageId) || candidate
    : candidate.page;
  const date = new Date(page.visitedAt);
  const day = date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [`You read “${truncate(page.title || page.url, 80)}” on ${day} (${humanTime(page.visitedAt)}).`];
  if (page.dwellSeconds) lines.push(`You spent ${fmtDuration(page.dwellSeconds)} on it${page.visitCount > 1 ? `, across ${page.visitCount} visits` : ''} — that's a real read, not a glance.`);
  lines.push(`Source: ${page.domainLabel || page.domain}`);
  return { text: lines.join(' '), citations: [cite(page, 1)], found: true };
}

function answerCount(parsed, pages) {
  const matches = sortByMatch(pages, parsed.stemmed);
  const topic = topicLabel(parsed);
  if (!matches.length) {
    return { text: `Zero, honestly — nothing in your memory matches “${topic}” yet. Read something about it and I'll start counting.`,
             citations: [], found: false };
  }
  const top = matches.slice(0, 3).map((row) => `“${truncate(row.page.title || row.page.url, 60)}” (${humanTime(row.page.visitedAt)})`);
  const dwell = matches.reduce((sum, row) => sum + (row.page.dwellSeconds || 0), 0);
  return {
    text: `You have ${matches.length} page(s) about ${topic} in your memory` +
          (dwell ? `, totalling ${fmtDuration(dwell)} of reading` : '') +
          `. The strongest: ${top.join('; ')}.`,
    citations: matches.slice(0, 5).map((row, i) => cite(row.page, i + 1)),
    found: true,
  };
}

function answerWhichSource(parsed, pages) {
  const matches = sortByMatch(pages, parsed.stemmed);
  if (!matches.length) {
    return { text: `No site in your memory covers ${topicLabel(parsed)} yet — I can check the web if you allow me.`,
             citations: [], found: false };
  }
  const byDomain = new Map();
  for (const row of matches) {
    const key = row.page.domainLabel || row.page.domain || 'unknown';
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(row.page);
  }
  const ranked = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  const parts = ranked.map(([domain, list]) =>
    `${domain} (${list.length} page${list.length === 1 ? '' : 's'}, e.g. “${truncate(list[0].title || list[0].url, 50)}”)`);
  return {
    text: `For ${topicLabel(parsed)}, your reading comes mostly from: ${parts.join(' · ')}.`,
    citations: matches.slice(0, 5).map((row, i) => cite(row.page, i + 1)),
    found: true,
  };
}

function answerVerify(parsed, pages, retrieval) {
  const matches = sortByMatch(pages, parsed.stemmed);
  const topic = topicLabel(parsed);
  const strong = matches.filter((row) => row.score >= 0.5).slice(0, 3);
  if (retrieval.grounded || strong.length) {
    const list = (strong.length ? strong : matches.slice(0, 2))
      .map((row) => `“${truncate(row.page.title || row.page.url, 60)}” (${humanTime(row.page.visitedAt)})`);
    return {
      text: `Yes — you definitely read about ${topic}. Proof from your own memory: ${list.join('; ')}.`,
      citations: (strong.length ? strong : matches.slice(0, 2)).map((row, i) => cite(row.page, i + 1)),
      found: true,
    };
  }
  if (matches.length) {
    return {
      text: `Sort of — something touched ${topic} once (“${truncate(matches[0].page.title || matches[0].page.url, 60)}”, ${humanTime(matches[0].page.visitedAt)}), but it wasn't a real read on that topic. Want me to check the web?`,
      citations: [cite(matches[0].page, 1)],
      found: true,
    };
  }
  return {
    text: `No — and I'd rather say it plainly than pretend. Nothing about ${topic} is in your memory yet. Say the word and I'll ask the web (with your permission).`,
    citations: [],
    found: false,
  };
}

function answerRecap(parsed, pages) {
  const range = parsed.timeRange || { label: 'recently', sinceMs: Date.now() - 86400000, untilMs: Date.now() };
  const inRange = pages
    .filter((page) => {
      const at = Date.parse(page.visitedAt || 0);
      return at >= range.sinceMs && at <= range.untilMs + 3600000;
    })
    .sort((a, b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt));
  if (!inRange.length) {
    return { text: `Nothing captured ${range.label} — the memory for that window is empty (and I won't invent pages that aren't there).`,
             citations: [], found: false };
  }
  const dwell = inRange.reduce((sum, page) => sum + (page.dwellSeconds || 0), 0);
  const byDomain = new Map();
  for (const page of inRange) {
    const key = page.domainLabel || page.domain || 'unknown';
    byDomain.set(key, (byDomain.get(key) || 0) + 1);
  }
  const topDomains = [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([domain, n]) => `${domain} (${n})`);
  const deep = inRange.filter((page) => (page.dwellSeconds || 0) >= 120)
    .sort((a, b) => b.dwellSeconds - a.dwellSeconds).slice(0, 3);
  const lines = [
    `${capitalize(range.label)}: ${inRange.length} page(s), ${fmtDuration(dwell)} of real reading.`,
    topDomains.length ? `Most-visited: ${topDomains.join(', ')}.` : '',
    deep.length ? `Deep reads: ${deep.map((page) => `“${truncate(page.title || page.url, 55)}” (${fmtDuration(page.dwellSeconds)})`).join('; ')}.` : '',
    `Freshest: “${truncate(inRange[0].title || inRange[0].url, 60)}” (${humanTime(inRange[0].visitedAt)}).`,
  ].filter(Boolean);
  return {
    text: lines.join(' '),
    citations: inRange.slice(0, 6).map((page, i) => cite(page, i + 1)),
    found: true,
  };
}

function answerCompare(parsed, pages) {
  const raw = parsed.raw;
  const split = raw.split(/\bdifference between\b|\bcompare\b|\bvs\.?\b|\bversus\b|\band\b/i);
  const sides = split.map((part) => part.replace(/[?.,!]/g, '').trim())
    .filter((part) => part.length > 1)
    .slice(0, 2)
    .map((part) => ({
      label: part,
      stems: [...new Set(part.toLowerCase().split(/\W+/).filter((w) => w.length > 2).map(stem))],
    }));
  if (sides.length < 2) return null;
  const results = sides.map((side) => {
    const matches = sortByMatch(pages, side.stems).slice(0, 2);
    return { side, matches };
  });
  const lines = [];
  const citations = [];
  for (const row of results) {
    if (row.matches.length) {
      lines.push(`${capitalize(row.side.label)}: your memory has ${row.matches.length > 1 ? 'pages like' : 'a page like'} “${truncate(row.matches[0].page.title || row.matches[0].page.url, 55)}” (${humanTime(row.matches[0].page.visitedAt)}).`);
      row.matches.forEach((m) => citations.push(m.page));
    } else {
      lines.push(`${capitalize(row.side.label)}: nothing in your memory yet — I can't compare what you haven't read (and I won't make things up).`);
    }
  }
  const both = results.every((row) => row.matches.length);
  if (both) lines.push('Want me to explain each side in simple words from those pages, or fetch fresh comparisons from the web (with your permission)?');
  return {
    text: lines.join(' '),
    citations: citations.slice(0, 6).map((page, i) => cite(page, i + 1)),
    found: both,
  };
}

function capitalize(text) {
  const s = String(text || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
