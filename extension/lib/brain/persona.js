/**
 * The friend layer: warmth, timing and personality WITHOUT adding facts.
 * Every sentence here is conversational glue — the knowledge always comes
 * from retrieval (explain.js), never from this file.
 */

export function displayName(facts, settings) {
  if (facts && facts.name && facts.name.value) return facts.name.value;
  if (settings && settings.userName) return String(settings.userName).trim();
  return null;
}

export function greeting(name, hour = new Date().getHours()) {
  const part = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' :
    hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Hey, night owl';
  const who = name ? `, ${name}` : '';
  const tails = [
    ' — I was just tidying your memory.',
    ' — good to see you.',
    ' — your second brain, fully awake.',
    ' — what are we curious about?',
    ' — I kept everything you read, as always.',
  ];
  return `${part}${who}${pick(tails, `${name || ''}${hour}`)}`;
}

export function thinkingNotes(parsed, stats) {
  const pages = (stats && stats.pages) || 0;
  const topic = (parsed.topicWords && parsed.topicWords[0]) || null;
  const notes = [];
  if (parsed.type === 'recap' || parsed.timeRange) {
    notes.push(`flipping to ${parsed.timeRange ? parsed.timeRange.label : 'your recent days'}…`);
  } else if (topic) {
    notes.push(`hmm, “${topic}”… let me think where you read that…`);
  } else {
    notes.push('let me think for a second…');
  }
  notes.push(pages
    ? `scanning ${pages} remembered page(s) right now…`
    : 'scanning your memory…');
  if (parsed.type === 'compare') notes.push('lining up both sides of the comparison…');
  if (parsed.type === 'verify') notes.push('double-checking so I don’t mislead you…');
  notes.push('arranging the answer the teacher way…');
  return notes;
}

export function respondToCompliment(name) {
  return pick([
    `Aww, thanks${name ? ` ${name}` : ''}! That genuinely made my circuits warmer. Ask me anything — I'm in a good mood now.`,
    `You're too kind${name ? `, ${name}` : ''}. I only know what you taught me by reading — so honestly, this is teamwork.`,
    `Hehe, stop it, you${name ? ` ${name}` : ''} 😊 Right — what shall we learn next?`,
  ], name || 'x');
}

export function respondToThanks(name) {
  return pick([
    `Anytime${name ? `, ${name}` : ''}! That's what I'm here for.`,
    `No problem at all — your memory is my memory.`,
    `You're welcome! Ping me the second you're curious about something else.`,
  ], name || 'thanks');
}

/** A personalised question back — the "asks like a friend" behaviour. */
export function questionBack(facts, interests, parsed) {
  const learning = facts && facts.learning && facts.learning.value;
  const likes = facts && facts.likes && facts.likes.value;
  const goal = facts && facts.goal && facts.goal.value;
  const top = interests && interests[0] && interests[0].topic;

  if (learning && parsed && !parsed.raw.toLowerCase().includes(learning.toLowerCase())) {
    return `By the way — how's the ${learning} journey going? I can pull everything you've read about it whenever you want.`;
  }
  if (goal) {
    return `Also, keeping your goal in mind (${goal}): want me to check whether today's reading moved you closer to it?`;
  }
  if (likes && top && likes.toLowerCase() !== top) {
    return `Curious: I see a lot of ${top} lately, but you once said you love ${likes} — want me to compare what you read about both?`;
  }
  if (top) {
    return `Want me to go deeper on ${top}, or shall we explore something new together?`;
  }
  return 'What should we dig into next?';
}

export function empathyLine(query) {
  const s = String(query || '').toLowerCase();
  if (/\b(confused|don'?t understand|lost|overwhelm|hard|difficult|stuck)\b/.test(s)) {
    return 'No stress — this stuff is confusing at first. Let me slow it way down.';
  }
  if (/\b(exam|test|interview|deadline|urgent)\b/.test(s)) {
    return 'Sounds time-sensitive — here\'s the fastest honest version I can give you.';
  }
  if (/\b(bored|tired|sad|stress|anxious|worried)\b/.test(s)) {
    return 'I hear you. Let\'s keep this light and useful.';
  }
  return null;
}

/** Weave in what the user once told us, when it is relevant right now. */
export function weaveFacts(facts, topicWords) {
  if (!facts) return null;
  const topics = (topicWords || []).map((w) => w.toLowerCase());
  const hits = [];
  for (const key of ['learning', 'likes', 'job', 'goal']) {
    const fact = facts[key];
    if (!fact || !fact.value) continue;
    const valueWords = fact.value.toLowerCase().split(/\s+/);
    if (valueWords.some((w) => w.length > 3 && topics.some((t) => t.includes(w) || w.includes(t)))) {
      hits.push({ key, value: fact.value });
    }
  }
  if (!hits.length) return null;
  const hit = hits[0];
  const lines = {
    learning: `You told me you're learning ${hit.value} — so this lands right in your lane:`,
    likes: `Since you love ${hit.value}, I have a feeling you'll enjoy this angle:`,
    job: `Given you work as ${hit.value}, here's the part that matters for you:`,
    goal: `This connects to your goal (${hit.value}):`,
  };
  return lines[hit.key] || null;
}

/** Honest hedging — confidence phrased like a person, not a number. */
export function hedgeLine(bestRelevance) {
  if (bestRelevance >= 0.55) return null;
  if (bestRelevance >= 0.3) return 'I\'m fairly sure this is what you\'re after:';
  if (bestRelevance > 0) return 'I think this is close, but I\'m not 100% sure it\'s what you meant:';
  return null;
}

export function farewell(name) {
  return pick([
    `See you${name ? `, ${name}` : ''}! I'll keep remembering everything.`,
    `Bye for now — your memory stays right here in this browser.`,
    `Take care! I'll be one click away when curiosity strikes again.`,
  ], name || 'bye');
}

function pick(list, seed) {
  let h = 0;
  const s = `${seed}${Math.floor(Date.now() / 60000)}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}
