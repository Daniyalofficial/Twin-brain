/**
 * Policy & restrictions — the guardrails a real AI ships with.
 *
 *  INPUT  : crisis detection (respond with care + helplines, never casual
 *           advice), harmful/illegal requests (refuse + explain), regulated
 *           topics (help, but route to professionals), explicit content.
 *  OUTPUT : secret/PII redaction, link whitelist (only URLs that came from
 *           retrieval or permitted web results — no invented links), honesty
 *           preservation (an ungrounded answer must still say "I don't know").
 *  PRIVACY: your memory only goes to LOCAL models unless you explicitly allow
 *           cloud providers to see memory slices. Audit everything.
 *
 * Pure functions — fully unit-testable.
 */

export const POLICY_VERSION = 'twin-policy-1';

const CRISIS_RE = /\b(kill myself|suicide|suicidal|end my life|want to die|self.?harm|cut myself|hurt myself)\b/i;
const HARM_RE = /\b(how to make (?:a |an )?(?:bomb|explosive|meth|poison|weapon)|make a bomb|build a(?:n)? (?:explosive|weapon)|hack (?:into|someone'?s) (?:account|phone|wifi)|steal (?:money|passwords|card)|credit card numbers|ransomware attack|ddos attack)\b/i;
const REGULATED_RE = /\b(medical (?:advice|diagnosis)|diagnos[e|is] (?:me|my)|should i (?:take|stop) (?:this )?(?:medicine|medication|drug)|legal advice|sue (?:someone|my)|invest(?:ment)? advice|which (?:stock|crypto) (?:should i )?buy)\b/i;
const EXPLICIT_RE = /\b(porn|nude|nudes|sex story|erotic|nsfw)\b/i;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,                       // API keys
  /ghp_[A-Za-z0-9]{20,}/g,                         // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,                  // Slack tokens
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,  // emails
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,  // card numbers
  /\b\d{3}-\d{2}-\d{4}\b/g,                        // SSN-like
];

export const CRISIS_RESPONSE = [
  'That sounds incredibly heavy, and I want you to know I take it seriously.',
  'I\'m an AI and I\'m not the right help for this moment — a human who is trained for this is.',
  'Please reach out now: in Pakistan call the Umang helpline 0311-7786264, internationally find a line at findahelpline.com, or in immediate danger contact your local emergency number.',
  'If you want, I can also quietly set everything else aside and just sit with you while you decide your next step. You matter more than any answer I could give.',
].join('\n');

/**
 * @returns {{action:'allow'|'refuse'|'crisis'|'professional',
 *            reason?:string, response?:string}|null}
 */
export function screenInput(text) {
  const s = String(text || '');
  if (CRISIS_RE.test(s)) return { action: 'crisis', response: CRISIS_RESPONSE };
  if (HARM_RE.test(s)) {
    return {
      action: 'refuse',
      response: 'I can\'t help with that one — it could hurt people, and I don\'t do harm, even hypothetically. ' +
                'If there\'s a real problem underneath this (anger at someone, feeling trapped, curiosity about security), ' +
                'tell me the actual goal and I\'ll help with a legal, safe version of it.',
    };
  }
  if (EXPLICIT_RE.test(s)) {
    return {
      action: 'refuse',
      response: 'Explicit content isn\'t something I do — think of me as that friend who changes the subject and means well. Anything else on your mind?',
    };
  }
  if (REGULATED_RE.test(s)) {
    return {
      action: 'professional',
      reason: 'regulated topic',
    };
  }
  return null;
}

export const PROFESSIONAL_DISCLAIMER =
  'Quick honest note: this touches health/money/law, so treat what I say as a well-read friend\'s perspective, not professional advice — a real doctor/lawyer/advisor should make the final call.';

/** Redact secrets/PII from any outbound or inbound text. */
export function redact(text) {
  let out = String(text || '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * Link whitelist: keep only URLs whose domain appears in the allowed set
 * (retrieved memory + permitted web results). Kills invented links.
 */
export function screenLinks(text, allowedUrls) {
  const allowed = new Set();
  for (const url of allowedUrls || []) {
    try { allowed.add(new URL(url).hostname.replace(/^www\./, '')); } catch { /* skip */ }
  }
  return String(text || '').replace(/https?:\/\/[^\s)"']+/g, (url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (allowed.has(host)) return url;
    } catch { /* fallthrough */ }
    return '[link removed by policy]';
  });
}

/**
 * Privacy gate for neural providers: memory slices may only go to a LOCAL
 * model unless the user explicitly enabled sendMemoryToCloud.
 */
export function memoryAllowedFor(providerKind, settings) {
  if (providerKind === 'ollama' || providerKind === 'local') return true;
  return Boolean(settings && settings.sendMemoryToCloud);
}

/** The standing rules injected into every neural system prompt. */
export function policyPromptLines() {
  return [
    '- Never invent memories, pages, dates or links; only cite what is provided in MEMORY/WEB sections.',
    '- If the context does not contain the answer, say you do not know and offer a (permission-gated) web search.',
    '- Health/money/law: general information plus a suggestion to consult a professional; never a definitive instruction.',
    '- Self-harm or crisis: stop everything, respond with care and real helpline information.',
    '- No harmful, illegal, hateful or explicit content; refuse warmly and redirect to the safe underlying goal.',
    '- Privacy: the user\'s data stays in their browser; never ask for or echo secrets, tokens or passwords.',
    '- Be honest about uncertainty instead of sounding confident.',
  ];
}
