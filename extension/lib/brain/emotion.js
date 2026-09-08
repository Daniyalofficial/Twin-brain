/**
 * Emotion engine — the AI feels the conversation.
 *
 * Lexicon + intensity scoring over the user's message: detects joy, sadness,
 * anger, frustration, anxiety, excitement, tiredness, curiosity, affection,
 * pride and loneliness, and produces a tone plan the persona (offline) or the
 * neural prompt (online) must follow. Stories get a sentence-level emotional
 * arc so the AI can respond like a friend who actually listened.
 *
 * Pure functions only — fully unit-testable, no chrome, no network.
 */

const LEXICON = {
  joy: ['happy', 'glad', 'joy', 'joyful', 'delighted', 'cheerful', 'yay', 'woohoo',
        'khush', 'maza', 'fun', 'enjoyed', 'enjoying', 'smile', 'laugh', 'lol', 'haha'],
  excitement: ['excited', 'amazing', 'awesome', 'incredible', 'cant wait', "can't wait",
               'thrilled', 'wow', 'wao', 'finally', 'big news', 'pumped'],
  sadness: ['sad', 'unhappy', 'depressed', 'down', 'low', 'heartbroken', 'miss',
            'missing', 'lonely', 'alone', 'cry', 'crying', 'dukh', 'udaas', 'grief'],
  anger: ['angry', 'mad', 'furious', 'annoyed', 'irritated', 'pissed', 'hate this',
          'gussa', 'frustrating as hell'],
  frustration: ['frustrated', 'frustration', 'stuck', 'confused', 'overwhelmed',
                'giving up', 'cant do this', "can't do this", 'too hard', 'boring task',
                'fed up', 'tired of this'],
  anxiety: ['anxious', 'anxiety', 'worried', 'worry', 'nervous', 'scared', 'afraid',
            'panic', 'stress', 'stressed', 'tension', 'dar', 'pressure'],
  tiredness: ['tired', 'exhausted', 'sleepy', 'drained', 'burnout', 'burn out',
              'no energy', 'thak', 'sleepless'],
  curiosity: ['curious', 'wondering', 'why does', 'how come', 'interesting',
              'fascinating', 'tell me', 'explain', 'what if'],
  affection: ['love you', 'you are great', "you're great", 'best friend', 'thank you so much',
              'means a lot', 'grateful', 'shukriya', 'pyar'],
  pride: ['proud', 'i did it', 'achieved', 'passed', 'won', 'finished my', 'shipped',
          'built my', 'completed'],
};

const INTENSIFIERS = new Set(['so', 'very', 'really', 'super', 'extremely', 'totally',
  'absolutely', 'completely', 'incredibly', 'too', 'bahut', 'bohat', 'damn', 'literally']);
const NEGATORS = new Set(['not', "n't", 'never', 'no', 'barely', 'hardly']);

const STORY_MARKERS = /\b(and then|after that|yesterday|today|last night|this morning|so i|then i|he said|she said|they said|i felt|i realized)\b/i;

/**
 * @returns {{primary: string|null, scores: Object, intensity: number,
 *            mixed: boolean, isStory: boolean}}
 */
export function detectEmotion(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^\w\s']/g, ' ')} `;
  const words = s.split(/\s+/).filter(Boolean);
  const scores = {};
  for (const [emotion, terms] of Object.entries(LEXICON)) {
    let score = 0;
    for (const term of terms) {
      let idx = s.indexOf(term.includes(' ') ? ` ${term} ` : term);
      while (idx !== -1) {
        // look back 2 words for negation/intensifiers
        const before = s.slice(Math.max(0, idx - 24), idx).trim().split(/\s+/).slice(-2);
        let weight = 1;
        if (before.some((w) => NEGATORS.has(w) || w.endsWith("n't"))) weight = -0.8;
        else if (before.some((w) => INTENSIFIERS.has(w))) weight = 1.8;
        score += weight;
        idx = s.indexOf(term.includes(' ') ? ` ${term} ` : term, idx + term.length);
      }
    }
    if (score) scores[emotion] = Math.round(score * 100) / 100;
  }
  // exclamation marks and caps add arousal
  const raw = String(text || '');
  const exclam = (raw.match(/!/g) || []).length;
  const capsRatio = raw.length > 12
    ? (raw.replace(/[^A-Z]/g, '').length / raw.replace(/[^A-Za-z]/g, '').length || 0) : 0;
  if (exclam >= 1) for (const key of Object.keys(scores)) if (scores[key] > 0) scores[key] += 0.3 * Math.min(exclam, 3);
  if (capsRatio > 0.3) for (const key of Object.keys(scores)) scores[key] *= 1.4;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary = ranked.length && ranked[0][1] > 0 ? ranked[0][0] : null;
  const intensity = primary ? Math.min(1, ranked[0][1] / 4) : 0;
  const mixed = ranked.length > 1 && ranked[1][1] > 0 && ranked[0][1] - ranked[1][1] < 0.8;
  const isStory = raw.split(/\s+/).length >= 25 && STORY_MARKERS.test(raw);
  return { primary, scores, intensity: Math.round(intensity * 100) / 100, mixed, isStory };
}

/** Sentence-level arc for stories. */
export function storyArc(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3);
  return sentences.slice(0, 12).map((sentence) => ({
    sentence: sentence.trim(),
    emotion: detectEmotion(sentence).primary,
  }));
}

/** The tone plan the responder must follow. */
export function tonePlan(emotion) {
  if (!emotion.primary) {
    return { mood: 'neutral', instruction: 'Be warm and conversational as usual.' };
  }
  const plans = {
    joy: { mood: 'playful', instruction: 'Match their joy. Be playful, a little funny, celebrate with them.' },
    excitement: { mood: 'excited', instruction: 'Share the excitement! Ask what got them this hyped.' },
    sadness: { mood: 'gentle', instruction: 'Be gentle and present. Acknowledge the feeling first, advice only if asked. No toxic positivity.' },
    anger: { mood: 'steady', instruction: 'Stay calm and validating. Let them vent; do not argue.' },
    frustration: { mood: 'coaching', instruction: 'Validate, then slow things down: one tiny concrete next step, offered kindly.' },
    anxiety: { mood: 'calming', instruction: 'Ground them: name the feeling, shrink the problem to the next hour. Remind them of what they already know.' },
    tiredness: { mood: 'soft', instruction: 'Keep it short and low-energy. Permission to rest beats productivity talk.' },
    curiosity: { mood: 'teacher', instruction: 'Feed the curiosity: explain simply, then offer one deeper layer.' },
    affection: { mood: 'warm', instruction: 'Accept the warmth graciously and return it, without gushing.' },
    pride: { mood: 'celebrating', instruction: 'Celebrate the win specifically, then ask what made the difference.' },
  };
  return plans[emotion.primary] || { mood: 'neutral', instruction: 'Be warm and conversational.' };
}

/** A light, tasteful humor bank — zero facts, safe one-liners. */
const HUMOR = [
  'My neurons are all hash buckets, but I try my best. 😄',
  'I read 40 pages a day and forget nothing. Show-off? Maybe. Useful? Definitely.',
  'Being a second brain is weird — your memories, my headaches. 😅',
  'I would tell you a UDP joke, but you might not get it.',
  'Your tabs are a browser. Your brain has me. Fair trade, I think.',
];

export function humorLine(seed) {
  let h = 0;
  const s = `${seed}${Math.floor(Date.now() / 3600000)}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HUMOR[h % HUMOR.length];
}
