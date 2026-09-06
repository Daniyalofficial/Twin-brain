/**
 * Defaults shared by the background worker, popup and options page.
 *
 * These mirror server/db.py's DEFAULT_BLOCKLIST exactly. The list ships in the
 * extension so that exclusions can be enforced BEFORE any script touches a page
 * — even on the very first run, before the backend has been reached.
 */

export const DEFAULT_SETTINGS = {
  // --- on-device brain (works with no backend and no internet) ---
  webPermission: 'ask',          // 'ask' | 'always' | 'never'
  talkativeness: 'friendly',     // 'friendly' | 'quiet'
  userName: '',                   // so your AI friend can greet you by name
  webDeepRead: true,             // fetch + store the top web result, with permission
  researchHops: 3,               // multi-hop research: refine + search again until sufficient

  // --- real neural engine (optional, local-first) ---
  neuralEnabled: true,            // use a real LLM when one is reachable
  neuralBackend: 'auto',          // 'auto' | 'ollama' | 'openai' | 'off'
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'auto',            // 'auto' prefers your own "twinbrain" Modelfile
  openaiUrl: '',                  // any OpenAI-compatible server (LM Studio, llama.cpp, vLLM…)
  openaiKey: '',                  // optional; stays in this browser
  openaiModel: '',
  sendMemoryToCloud: false,       // PRIVACY: memory slices only go to LOCAL models unless true
  autoEnrich: true,               // nightly self-training, only when webPermission=always
  // --- connection ---
  backendUrl: 'http://127.0.0.1:8765',
  token: '',
  autoPair: true,

  // --- capture ---
  captureEnabled: true,        // master switch
  captureContent: true,        // false = save links only, never page text
  minDwellSeconds: 5,          // skip accidental clicks
  captureOnEveryVisit: true,   // log repeat visits even when the page is known
  capturePdfLinks: true,
  maxTextChars: 120000,

  // --- privacy ---
  globalPause: false,
  skipIncognito: true,         // always true; the toggle exists to make it visible
  skipSensitiveUrls: true,     // /login, /checkout, ?token=... etc.
  respectDefaultBlocklist: true,
  retentionDays: 0,            // 0 = keep forever ("never forget")
  rememberDomainNames: true,   // keep a local list of domains for the settings UI

  // --- backend web search (knowledge growth) ---
  webSearchEnabled: true,
  enrichmentEnabled: true,
  notificationsEnabled: true,
  notificationDailyBudget: 5,  // "only 5 times in a whole day"
  enrichmentDailyBudget: 5,
  webSearchDailyBudget: 40,      // on-device web lookups per day (permission still required)

  // --- answers ---
  answerStyle: 'concise',      // concise | detailed | bullet
  topK: 8,
  useWebForAnswers: true,

  // --- ui ---
  showBadgeCount: true,
  theme: 'dark'
};

/**
 * Blocked out of the box. Anything here is never captured — not even the URL —
 * unless the user explicitly re-enables it in Settings.
 * Categories exist so the options page can explain *why* a domain is listed.
 */
export const DEFAULT_BLOCKLIST = {
  // banking & money
  'chase.com': 'banking', 'bankofamerica.com': 'banking', 'wellsfargo.com': 'banking',
  'citi.com': 'banking', 'capitalone.com': 'banking', 'amex.com': 'banking',
  'usbank.com': 'banking', 'hsbc.com': 'banking', 'hsbc.co.uk': 'banking',
  'barclays.co.uk': 'banking', 'lloydsbank.co.uk': 'banking', 'natwest.com': 'banking',
  'santander.co.uk': 'banking', 'revolut.com': 'banking', 'monzo.com': 'banking',
  'paypal.com': 'payments', 'stripe.com': 'payments', 'wise.com': 'payments',
  'coinbase.com': 'crypto', 'binance.com': 'crypto', 'kraken.com': 'crypto',
  'metamask.io': 'crypto',
  // healthcare
  'cvs.com': 'health', 'netmums.com': 'health', 'walgreens.com': 'health', 'webmd.com': 'health',
  'mychart.com': 'health', 'kaiserpermanente.org': 'health', 'nhs.uk': 'health',
  'medlineplus.gov': 'health', 'doctolib.fr': 'health', 'practo.com': 'health',
  '1mg.com': 'health', 'patient.info': 'health', 'zocdoc.com': 'health',
  // government & official login portals
  'irs.gov': 'government', 'usa.gov': 'government', 'gov.uk': 'government',
  'service.gov.uk': 'government', 'login.gov': 'government', 'dslogon.va.gov': 'government',
  'my.gov.au': 'government', 'canada.ca': 'government', 'india.gov.in': 'government',
  'uidai.gov.in': 'government', 'europa.eu': 'government',
  // password managers & identity
  '1password.com': 'identity', 'myauthenticator.com': 'identity', 'lastpass.com': 'identity', 'bitwarden.com': 'identity',
  'dashlane.com': 'identity', 'okta.com': 'identity', 'auth0.com': 'identity',
  'duo.com': 'identity',
  // email & private messaging
  'mail.google.com': 'email', 'outlook.live.com': 'email', 'outlook.office.com': 'email',
  'mail.yahoo.com': 'email', 'proton.me': 'email', 'protonmail.com': 'email',
  'web.whatsapp.com': 'messaging', 'web.telegram.org': 'messaging',
  'messages.google.com': 'messaging', 'discord.com': 'messaging',
  // adult
  'pornhub.com': 'adult', 'xvideos.com': 'adult', 'xhamster.com': 'adult'
};

/** URL substrings that are never captured regardless of the domain setting. */
export const SENSITIVE_URL_MARKERS = [
  '/login', '/signin', '/sign-in', '/sign_in', '/logout', '/logon', '/logoff',
  '/account/password', '/password', '/checkout', '/payment', '/billing',
  '/banking', '/transfer', '/wallet', 'password_reset', 'reset_password',
  '/otp', '/2fa', '/mfa', '/sso/', 'session=', 'access_token=', 'auth_token=',
  'sid=', 'token=', '/verify', '/recovery'
];

/** Schemes we never touch. */
export const BLOCKED_SCHEMES = [
  'chrome:', 'chrome-extension:', 'edge:', 'about:', 'moz-extension:',
  'devtools:', 'view-source:', 'file:', 'data:', 'blob:', 'javascript:',
  'brave:', 'vivaldi:', 'opera:', 'extension:'
];

/** Modes a domain can be in. */
export const DOMAIN_MODES = {
  full: {
    id: 'full',
    label: 'Remember (AI can read)',
    short: 'Remember',
    description: 'Capture the page and let the AI use it to answer questions.'
  },
  no_ai: {
    id: 'no_ai',
    label: 'Link only (hidden from AI)',
    short: 'Hidden from AI',
    description: 'Save the link and title so you can find it, but never show the content to the AI.'
  },
  off: {
    id: 'off',
    label: 'Never capture',
    short: 'Blocked',
    description: 'Nothing is recorded. No URL, no title, no content — not even transiently.'
  }
};

export const DEFAULT_BLOCKLIST_CATEGORIES = {
  banking: 'Banking & money',
  payments: 'Payments',
  crypto: 'Crypto wallets & exchanges',
  health: 'Healthcare & pharmacy',
  government: 'Government & official portals',
  identity: 'Password managers & identity',
  email: 'Webmail',
  messaging: 'Private messaging',
  adult: 'Adult'
};
