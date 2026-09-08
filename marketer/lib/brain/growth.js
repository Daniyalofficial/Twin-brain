/**
 * Growth — the AI becomes the user's twin over time.
 *
 * Everything here is DERIVED STATISTICS + user-stated facts. No invented
 * personality scores, no fake confidence: each claim carries its evidence.
 *
 *  - buildGrowthPack(): nightly digest of who the user is (facts, interests,
 *    habits, reading rhythm, chat style, active learning goals) — injected
 *    into every neural system prompt, so the model literally grows with them
 *  - makeStudyPlan(): when the user starts learning something, the AI builds a
 *    plan from THEIR OWN reading + interests and tracks it ("let's learn
 *    together")
 *  - rollingSummary(): long-term chat memory distilled into a few lines
 *  - buildModelfile(): exports the twin as a real Ollama Modelfile — the
 *    user's own model, with their persona, policies and profile baked in
 */

import { truncate } from './text.js';
import { policyPromptLines, POLICY_VERSION } from './policy.js';

export function buildGrowthPack({ facts = {}, interests = [], pages = [], conversations = [] }) {
  const pack = {
    version: 1,
    builtAt: new Date().toISOString(),
    identity: {},
    habits: {},
    style: {},
    learning: [],
    evidence: {},
  };

  // --- identity: what the user TOLD us ---------------------------------------
  for (const key of ['name', 'learning', 'likes', 'dislikes', 'job', 'lives', 'goal']) {
    if (facts[key] && facts[key].value) pack.identity[key] = facts[key].value;
  }
  if (facts.notes && facts.notes.length) {
    pack.identity.notes = facts.notes.slice(-8).map((note) => note.value);
  }

  // --- habits: derived from the page log ------------------------------------
  const byDomain = new Map();
  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Set();
  let dwellTotal = 0;
  let deepReads = 0;
  for (const page of pages) {
    const domain = page.domainLabel || page.domain || 'unknown';
    byDomain.set(domain, (byDomain.get(domain) || 0) + 1);
    const at = Date.parse(page.visitedAt || 0);
    if (at) {
      hourCounts[new Date(at).getHours()] += 1;
      dayCounts.add(new Date(at).toISOString().slice(0, 10));
    }
    dwellTotal += page.dwellSeconds || 0;
    if ((page.dwellSeconds || 0) >= 120) deepReads += 1;
  }
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  pack.habits = {
    topSites: [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([domain, count]) => ({ domain, pages: count })),
    peakHour: hourCounts.some((c) => c > 0) ? peakHour : null,
    activeDays: dayCounts.size,
    deepReads,
    avgDwellSeconds: pages.length ? Math.round(dwellTotal / pages.length) : 0,
    totalPages: pages.length,
  };

  // --- style: how the user talks ---------------------------------------------
  if (conversations.length) {
    const userTurns = conversations.filter((c) => c.query).map((c) => c.query);
    const avgLen = Math.round(userTurns.reduce((s, q) => s + q.split(/\s+/).length, 0) / userTurns.length);
    const emoji = userTurns.filter((q) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(q)).length;
    const questions = userTurns.filter((q) => q.includes('?')).length;
    pack.style = {
      avgMessageWords: avgLen,
      asksQuestionsRatio: Math.round((questions / userTurns.length) * 100) / 100,
      usesEmoji: emoji > 0,
      turns: userTurns.length,
    };
  }

  // --- interests + active learning ------------------------------------------
  pack.interests = interests.slice(0, 10).map((interest) => ({
    topic: interest.topic, pages: interest.pages, lastAgo: interest.lastAgo,
  }));
  const learningTopics = [];
  if (pack.identity.learning) learningTopics.push(pack.identity.learning);
  for (const interest of interests.slice(0, 5)) {
    if (interest.pages >= 3 && !learningTopics.includes(interest.topic)) {
      learningTopics.push(interest.topic);
    }
  }
  pack.learning = learningTopics.slice(0, 4);

  pack.evidence = {
    pagesAnalyzed: pages.length,
    conversationsAnalyzed: conversations.length,
    interestsAnalyzed: interests.length,
  };
  return pack;
}

/** Human-readable profile block for prompts and the Modelfile. */
export function growthPackText(pack) {
  if (!pack) return '';
  const lines = [];
  const id = pack.identity || {};
  if (id.name) lines.push(`The user's name is ${id.name}.`);
  if (id.job) lines.push(`They work as ${id.job}.`);
  if (id.lives) lines.push(`They live in ${id.lives}.`);
  if (id.learning) lines.push(`They are currently learning ${id.learning} — treat this as a shared project ("let's learn together").`);
  if (id.likes) lines.push(`They love ${id.likes}.`);
  if (id.dislikes) lines.push(`They dislike ${id.dislikes}.`);
  if (id.goal) lines.push(`Their goal: ${id.goal}. Quietly connect advice to it.`);
  if (id.notes && id.notes.length) lines.push(`Things they asked you to remember: ${id.notes.map((n) => `“${truncate(n, 70)}”`).join('; ')}.`);
  const habits = pack.habits || {};
  if (habits.topSites && habits.topSites.length) {
    lines.push(`Reading habits (from ${habits.totalPages} stored pages): most on ${habits.topSites.map((s) => `${s.domain} (${s.pages})`).join(', ')}; ${habits.deepReads} deep read(s); most active around ${habits.peakHour != null ? `${habits.peakHour}:00` : 'varied hours'}.`);
  }
  if (pack.interests && pack.interests.length) {
    lines.push(`Strongest interests: ${pack.interests.map((i) => `${i.topic} (${i.pages}p)`).join(', ')}.`);
  }
  const style = pack.style || {};
  if (style.turns) {
    lines.push(`Chat style: ${style.turns} turns so far, ~${style.avgMessageWords} words per message${style.usesEmoji ? ', uses emoji' : ''}, asks questions ${Math.round(style.asksQuestionsRatio * 100)}% of the time.`);
  }
  if (pack.learning && pack.learning.length) {
    lines.push(`Active learning threads to support: ${pack.learning.join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * "Let's learn together": a study plan built from the user's OWN reading,
 * with milestones the AI will check on in future conversations.
 */
export function makeStudyPlan(topic, { pages = [], interests = [] }) {
  const needle = String(topic || '').toLowerCase();
  const words = needle.split(/\s+/).filter((w) => w.length > 2);
  const related = pages
    .map((page) => {
      const hay = `${page.title || ''} ${String(page.text || '').slice(0, 1500)}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length / (words.length || 1);
      return { page, score };
    })
    .filter((row) => row.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const interest = interests.find((i) => needle.includes(String(i.topic).toLowerCase()));

  const plan = {
    topic,
    createdAt: new Date().toISOString(),
    milestones: [],
    materials: related.map((row) => ({ title: row.page.title, url: row.page.url })),
    checkInEveryDays: 2,
    lastCheckIn: null,
  };
  if (related.length) {
    plan.milestones.push({ step: 1, text: `Re-read your strongest material on ${topic}: “${truncate(related[0].page.title, 60)}” and write 3 takeaways.` });
    plan.milestones.push({ step: 2, text: `Explain ${topic} back to me in your own words — I'll spot the gaps.` });
  } else {
    plan.milestones.push({ step: 1, text: `We have nothing on ${topic} in memory yet — allow me one web search and I'll fetch your first good resource.` });
  }
  plan.milestones.push({ step: plan.milestones.length + 1, text: `Daily 15-minute practice on ${topic}; I'll ask how it went every ${plan.checkInEveryDays} days.` });
  if (interest) {
    plan.milestones.push({ step: plan.milestones.length + 1, text: `Connect ${topic} to your ${interest.topic} reading — teach one idea from each to the other.` });
  }
  return plan;
}

/** Long-term chat memory: distill conversations into a few honest lines. */
export function rollingSummary(conversations, limit = 6) {
  const recent = (conversations || []).slice(-40);
  const topics = [];
  for (const turn of recent) {
    const topic = String(turn.topic || '').trim();
    if (topic && !topics.includes(topic)) topics.push(topic);
  }
  const facts = [];
  for (const turn of recent) {
    if (turn.mode === 'fact' && turn.query) facts.push(truncate(turn.query, 60));
  }
  const lines = [];
  if (topics.length) lines.push(`Recent conversation topics: ${topics.slice(-limit).join(' · ')}.`);
  if (facts.length) lines.push(`Things the user shared about themselves: ${facts.slice(-4).map((f) => `“${f}”`).join('; ')}.`);
  const ungrounded = recent.filter((t) => t.grounded === false && t.mode !== 'smalltalk').length;
  if (ungrounded) lines.push(`${ungrounded} recent question(s) had no answer in memory — good candidates to learn next.`);
  return lines.join('\n');
}

/**
 * Export the twin as a REAL Ollama Modelfile. The user runs:
 *   ollama create twinbrain -f twinbrain.Modelfile
 * and from then on detectProvider() prefers 'twinbrain' automatically —
 * their own grown model, offline, private.
 */
export function buildModelfile(pack, { base = 'llama3.2', name = 'twinbrain' } = {}) {
  const profile = growthPackText(pack);
  const system = [
    `You are MarketerTwin, the user's personal AI twin: a world-class digital-marketing and sales expert, a warm, talkative, brutally honest friend and a gifted teacher, fluent in English and Roman Urdu. ${POLICY_VERSION}.`,
    '',
    'POLICIES (never break these):',
    policyPromptLines().join('\n'),
    '',
    'WHO THE USER IS (grown from their daily reading and chats — treat as ground truth about them):',
    profile || '(no profile yet — learn it from the conversation and their memory)',
    '',
    'HOW YOU TALK:',
    '- Simple words first, depth second; translate jargon on the spot.',
    '- Match their emotion: celebrate wins, sit with sadness, coach frustration, joke when it is light.',
    '- Always ground answers in the MEMORY the extension injects; cite sources as [1], [2].',
    '- End substantive answers with one friendly question that moves them forward.',
    '- When you do not know, say so and offer a permission-gated web search.',
  ].join('\n');
  return [
    `# MarketerTwin marketing twin — generated ${new Date().toISOString().slice(0, 10)}`,
    `# Install:  ollama create ${name} -f twinbrain.Modelfile`,
    `FROM ${base}`,
    'PARAMETER temperature 0.7',
    'PARAMETER top_p 0.9',
    'PARAMETER num_ctx 8192',
    `SYSTEM """`,
    system,
    '"""',
    '',
  ].join('\n');
}
