# Twin-Brain — a private, local-first second brain

Twin-Brain is a browser extension plus a small local backend that remembers what you
read and answers questions **only from what it actually stored**. It is the "digital
twin" from the original spec, built to run with zero configuration and zero API keys,
and to stay honest when it does not know something.

- **Everything stays on your machine.** One SQLite file, one local HTTP server on
  `127.0.0.1:8765`, one token in `data/token.txt`.
- **No API keys needed.** The default answer engine is a grounded extractive engine:
  it quotes sentences from your own pages and nothing else, so it cannot invent a
  memory. Better engines (Claude, OpenAI-compatible, local Ollama) plug in and
  activate automatically when a key is present.
- **Privacy filters run before capture, not after.** Excluded content never touches
  disk, not even briefly. Incognito is never captured, full stop.
- **Never forget, unless you say so.** Every link you open is logged (including repeat
  visits). "Forget this page" deletes it *and* tombstones the URL so it is never
  re-captured.
- **Optional growth.** The backend may search the web about topics *you* already read
  about, capped by daily budgets (default 5 enrichment runs and 5 notifications a day),
  with a full audit log of every outbound query.

---

> **New:** the brain now lives *inside the extension*. Capture, retrieval and
> answers all work with **no backend, no `run.bat`, and no internet** — see
> [The on-device brain](#the-on-device-brain-no-backend-needed). The Flask
> backend below is now an *optional* mirror that powers the web dashboard.

## 🆕 MarketerTwin v1.0 — the digital-marketing & Meta-Ads twin

A **second, standalone extension** lives in [`marketer/`](marketer/) and ships as
`MarketerTwin-v1.0.zip`: an AI marketing brain (Meta Ads expert, sales-psychology
master, English + Roman Urdu, 5,148 built-in chat turns, 80 marketing topics,
56 sales tactics with ready scripts, six marketing books taught in full), a
Facebook **click-position recorder/player** for posting & share-to-groups flows
(Branding + Meta modes, 40-second image waits, saved manual descriptions),
**group monitors** that watch Facebook groups on an interval, multi-chat memory,
style learning, daily budgeted web learning, and an optional OpenAI-compatible
API mode driven by a pre-made sales-master system prompt. **No server, no
localhost** — one IndexedDB inside Chrome. Load it via `chrome://extensions` →
*Load unpacked*. Full manual: [marketer/README.md](marketer/README.md).

---

## Quickstart (optional backend + dashboard)

```bash
./run.sh                 # Linux/macOS: creates .venv on first run, then starts
run.bat                  # Windows: double-click it (same thing, .venv included)
```

Both launchers create `.venv` + install requirements on first run (internet needed
once), then start the backend and **keep the window open** — if anything goes wrong
the window now stays up with a readable error instead of flashing shut.

The startup banner prints the dashboard URL and the API token:

```
Twin-Brain backend ready
  dashboard : http://127.0.0.1:8765/
  api token : xxxxxxxx
  database  : .../data/twinbrain.db
```

1. **Open the dashboard** at <http://127.0.0.1:8765/> — it pairs itself automatically
   (same-origin), or paste the token once.
2. **Load the extension**: `chrome://extensions` → enable *Developer mode* →
   *Load unpacked* → choose the `extension/` folder. Click its icon → gear →
   *Connection* → **auto-fill** to pair it with the backend (or open
   <http://127.0.0.1:8765/pair>).
3. **Browse normally.** After ~5 s on a page the extension captures it; the toolbar
   badge shows how many pages were remembered today.
4. **Ask**: toolbar popup, dashboard, or right-click → *Ask Twin-Brain*.

Want demo data without browsing? `./.venv/bin/python scripts/seed_demo.py --wipe`
seeds 18 realistic pages across four topic clusters into a scratch database
(set `TWINBRAIN_DATA_DIR` first if you want it somewhere specific).

---

## The on-device brain (no backend needed)

Everything the AI knows lives in your browser:

1. **Capture → remember.** After ~5 s on a page (that isn't excluded), the
   service worker chunks the text, embeds it with a deterministic on-device
   hash embedder (`extension/lib/brain/embed.js`, 384-dim, no downloads) and
   stores it in IndexedDB (`twinbrain` database, `chunks` store). Nothing is
   ever sent anywhere. The backend, when running, only receives a *copy*.
2. **Answers.** `tb-query` runs a local hybrid retrieval — BM25 (Lucene-style
   IDF, title boost, prefix tolerance) fused with cosine similarity, an
   evidence gate so hash collisions never count as proof, and a recency
   re-rank. It's the same tuned maths as `server/retrieval.py`, ported to pure
   JavaScript and unit-tested with `node --test tests/js/`.
3. **The super explainer.** Answers arrive as a lesson, not a link dump:
   *In simple words* → *The details* → *Tricky words, translated* (a plain-English
   dictionary) → *how this connects to YOUR interests* → numbered citations
   (title + site + when you read it) → **related reading at the very end**.
4. **Honesty.** If retrieval finds nothing solid, the AI says *"I don't have
   this in your memory"* and offers the web — it never invents pages, dates or
   facts. Every factual sentence traces to a cited page.
5. **Permission-gated web.** When memory is thin the AI **asks first**
   (popup card: *Allow once / Always allow / Not now*). With permission it
   searches DuckDuckGo from the service worker, optionally deep-reads the top
   result into your memory, and explains it in the same teacher voice.
   Every outbound query is budgeted (default 40/day) and written to a local
   audit trail. Settings: `webPermission` = `ask` (default) | `always` | `never`.
6. **Self-training.** A nightly alarm (`tb-daily`) refreshes your interest
   profile from your own reading, builds your daily recap notification
   (hard cap 5/day), and — only if you chose *Always allow web* — reads fresh
   material about your top interest.
7. **Real-time friend.** The AI reads your message like a person, not a
   keyword bag (`lib/brain/understand.js`): it knows question types
   (*when / how many / which sites / did I / compare / recap / define*),
   resolves "tell me more" and "what about that?" to the topic you were just
   discussing, turns "today / last week" into real date windows, and asks a
   clarifying question instead of guessing when you're vague. It remembers
   what you tell it — "my name is Ali", "I'm learning Python", "I love
   cricket" — stores those facts in IndexedDB (they never leave the browser),
   greets you by name, notices frustration or deadlines, hedges honestly when
   it's unsure, and asks *you* a question back. Direct questions get direct
   answers ("You read “X” on Tuesday, spent 7m on it"). Answers stream into
   the popup live: thinking notes while it searches your memory
   ("hmm, “sourdough”… scanning 42 remembered pages…"), then a word-by-word
   typewriter lesson (`lib/brain/persona.js` + `lib/brain/direct.js`).

Run it: load `extension/` in `chrome://extensions` (Developer mode → Load
unpacked). That's the whole install. Start `run.bat`/`run.sh` only if you want
the browser dashboard and the backup mirror.

## The twin core: real models + real growth

The on-device brain now has a **neural slot**, an **emotion engine**, a
**policy layer**, **multi-hop research** and a **growth system** — it gets
closer to being *your* twin every day.

### Real LLM, fully local (Ollama & friends)
Install [Ollama](https://ollama.com), run `ollama pull llama3.2`, and the
extension **auto-detects it** (`lib/brain/neural.js`) and streams answers
token-by-token into the popup — a real model, offline, private, grounded in
*your* retrieved memory (RAG): every answer sees your cited pages, your
profile and your chat history, and must cite `[n]` / `[Wn]` sources.
Any OpenAI-compatible server works too (LM Studio, llama.cpp, vLLM, or a
cloud key). **No model running? Nothing breaks** — the on-device persona
engine answers instead.

### Your own model: export the twin as a Modelfile
Options → *Export my twin (Ollama Modelfile)* downloads `twinbrain.Modelfile`
— your persona, your policies and your grown profile baked in:

```bash
ollama create twinbrain -f twinbrain.Modelfile
```

From then on `auto` model selection prefers **twinbrain** — literally your own
model. Re-export any time; it grows as you do.

### Growth: the AI learns *you* nightly
`lib/brain/growth.js` builds a **growth pack** from derived statistics only
(no fake scores): identity (facts you stated), reading habits (top sites,
peak hour, deep reads), chat style, strongest interests and active learning
threads. Say *"I am learning Spanish"* and it starts a **shared study plan**
from your own reading ("let's learn together"), with milestones and check-ins.

### Emotions & stories
`lib/brain/emotion.js` reads joy, sadness, anger, frustration, anxiety,
tiredness, curiosity, affection and pride — with negation and intensifiers —
and picks a tone plan (celebrate / sit-with / coach / calm). Long personal
messages are treated as **stories**: acknowledge → reflect the emotional arc
→ one gentle question, advice only if asked. Joy gets the occasional joke.

### Policy & restrictions (like a real AI)
`lib/brain/policy.js`: crisis detection (real helplines, never casual advice),
harmful/illegal/explicit refusals with a warm redirect, regulated-topic
disclaimers, secret/PII redaction, an invented-link killer (only URLs from
retrieval or permitted web results survive), and a hard privacy rule:
**your memory only goes to LOCAL models** unless you explicitly enable
`sendMemoryToCloud`.

### Multi-hop research
One search not enough? `lib/brain/research.js` measures answer coverage,
refines the query from the gaps and searches again (default 3 hops, daily
budget, every hop audited) — deep-reading full pages when snippets are thin.
Still permission-gated: `ask` / `always` / `never`.

## The complete English AI tool (all offline, all built in)

Three engines make the twin a fluent, talkative English companion — none of
them need the internet, a backend, or neural training:

### 1. The experience bank — thousands of chats
`lib/brain/data/chatcorpus.js` holds **3,081 conversation turns across 88
intents** (greetings, emotions, motivation, money, books, English practice,
identity, fun, daily life, philosophy…). `lib/brain/fluent.js` builds its own
BM25 index over them with a *tiny* stopword list — deliberately keeping
"how", "good", "night", "what", the exact words short chats depend on — and
answers through a **coverage gate**: a chitchat reply is only allowed when the
user's meaningful words actually appear in the matched intent's experience.
That is what separates *"i am so tired"* (warm, personal, talkative reply that
ends with a question) from *"how does DNS recursion work"* (never hijacked
into chitchat). Replies rotate per message hash + day, and use your name when
the twin knows it.

### 2. The built-in knowledge core — basic world knowledge, honestly labelled
`lib/brain/data/corekb.js` ships **105 core topics in 14 categories** (how the
internet/DNS/AI works, money and markets, science, health, history, space…) —
the "low-level LLM" baseline every assistant is expected to know. Retrieval is
**precision-anchored**: a built-in entry may only answer when one of your
*meaningful* query words appears in its title or aliases (so "bread" can never
surface "breathing"). Answers are teacher-shaped (simple version → key points
→ why it matters) and always say so:

> *From my built-in knowledge core — NOT from pages you read.*

The memory honesty contract is untouched: "did **I** read about gravity?" still
answers an honest no, even though the core knows gravity. Core answers are
badged `knowledge core` in the popup and never disguised as your reading.

### 3. The bookshelf — the books that build successful lives
`lib/brain/data/books.js` carries **6 complete books** with original
deep-commentary: *Think and Grow Rich* (1937), *Rich Dad Poor Dad* (1997),
*How to Win Friends and Influence People* (1936), *The 7 Habits of Highly
Effective People* (1989), *Atomic Habits* (2018) and — for the billionaire
question — *Zero to One* (2014). Each book: the core idea, **10+ lessons
explained in plain English with an action step each**, signature quotes, a
**7-day starter plan**, and one-line summaries for the shelf view. Ask
*"tell me about rich dad poor dad"*, *"which books should i read"*, or
*"how do I become a billionaire"* (which gets the honest four-stage answer:
mindset → high-income skill → ownership → leverage — plus the warning that no
book can promise billions). All commentary is original paraphrase, never
reproduced text.

### 4. The English desk — definitions, synonyms, idioms, grammar
`lib/brain/data/english.js`: a **429-word pocket dictionary** (meaning +
synonyms + example sentence each), **61 idioms** explained as wholes, **352
common typo fixes**, and **52 word upgrades** ("very happy" → "delighted").
`lib/brain/core.js` turns it into tools: `define resilience`, `synonym for
happy`, `meaning of piece of cake`, `correct this: i am go to school` — the
grammar fixer explains **every** change it made ("What changed and why:"),
teaches instead of silently editing, and `improveSentence` upgrades weak
phrasing. A **word of the day** rotates by date. When a word genuinely isn't
in the pocket dictionary, the desk says so — it never guesses a meaning.

Tests: `tests/js/englishai.test.mjs` (21 tests) plus drift guards in
`tests/test_ondevice_brain.py`.

## Hardened from real-world use

Every one of these came from an actual conversation with the twin, and each has
a regression test in `tests/js/fieldfixes.test.mjs`:

- **Grounded answers always cite.** The quote floor is adaptive
  (`max(0.20, best × 0.55)`, never above the best score), so a confident opener
  can never sit on top of an empty lesson again.
- **Search-result pages are link-only.** Google/Bing/DDG/YouTube result pages
  are detected at capture time (`classifyUrl` → `no_ai`), and a one-off startup
  migration purges SERP chunks older builds already stored — their scraped
  snippets never enter the AI's knowledge.
- **Junk sentences never get taught.** Nav pipes (`Title | Site`), ellipsis
  fragments (`When Tar...`), breadcrumbs, "Uploaded to YouTube" trailers,
  `### 1.` markdown artefacts and title echoes are filtered before any lesson
  sentence is picked.
- **"whats my name" is an identity question**, answered from the facts you told
  the twin (name, work, city, goals, notes) — never from fuzzy retrieval.
- **"Summarise my day" is a recap**, not a stats question.
- **Web search has a provider cascade** — DuckDuckGo HTML → DuckDuckGo Lite →
  Bing — and when every provider fails the popup says so honestly instead of
  staying silent. "seach the web" (typo included) is understood anywhere in the
  message.
- **Interests track real page ids** (`pages` is always a number — no more
  "undefined page(s) in your memory"), and interest topics are derived from the
  junk-free body text, not page headers.
- **Related reading is deduped** against citations, and reading time under a
  minute shows seconds, not "0m".

## The privacy model

The single source of truth for "may we capture this?" is `server/capture.py:check_url`,
and the extension runs the same rules **in the service worker before any content script
is injected** — so a blocked page is never even read, let alone stored.

| Per-site mode | What happens |
|---|---|
| **Remember** (`full`) | Content is captured and the AI may use it to answer. |
| **Hide from AI** (`no_ai`) | The link, title and visit stats are kept so *you* can find it; the content is never indexed and never reaches retrieval. |
| **Block** (`off`) | Nothing is recorded at all. Anything already stored for that site is deleted. |

On top of that:

- A shipped **default blocklist** (67 domains: banking, payments, crypto, health,
  government portals, password managers, webmail, messaging, adult) is pre-applied and
  mirrored in the extension so it works offline. You can change any entry.
- **Sensitive URL patterns** (`/login`, `/checkout`, `token=`, `/account/password`, …)
  are refused regardless of domain.
- **Incognito windows are never captured** — there is no setting that changes this.
- A global **pause** (toolbar icon, `Alt+Shift+P`, or settings) stops everything and is
  visible in the badge.
- **Forget** is durable: forgotten URLs and domains get tombstones, so a later visit
  cannot resurrect them.
- **Export everything** (JSON) and **delete everything** (typed confirmation) are both
  one click, in the popup, the options page and the dashboard.

### The honesty contract

- Answers are built only from retrieved pages. The extractive engine quotes verbatim
  sentences and lists `[n]` citations with **title, site and visit date** — falsifiable
  by clicking through.
- When retrieval finds nothing, the answer is a plain "I don't have anything in your
  history matching that", never an invention. Grounding requires real evidence
  (lexical overlap or vector similarity well above the embedder's noise floor), which
  is what stops a hash-based embedder from "recognising" unrelated pages.
- Pages the backend fetched itself during enrichment are labelled *assistant-fetched*
  and are never described as something you read.
- Interests and the persona are **derived statistics with evidence** (page counts,
  dwell time, links to the pages behind each topic), not scores invented by a model.

### Background activity, capped

| Knob (settings) | Default | Meaning |
|---|---|---|
| `notification_daily_budget` | 5 | Hard cap on notifications per day. |
| `enrichment_daily_budget` | 5 | Hard cap on enrichment searches per day. |
| `web_search_daily_budget` | 40 | Hard cap on all outbound searches per day. |
| `digest_hour` | 20 | Local hour for the daily recap. |

Every query the backend ever sends to the internet is logged and shown in
**Dashboard → Growth & audit**.

---

## Architecture

```
extension/                     MV3, no build step, no dependencies
  manifest.json                commands, shortcuts, permissions (no history/debugger)
  background.js                service worker: gate → inject → capture → queue → badge
  lib/defaults.js              offline copy of the privacy defaults (kept in sync by tests)
  lib/settings.js              exclusion engine: scheme → local → pause → domain modes → markers
  lib/store.js                 IndexedDB outbox + local page cache (survives backend downtime)
  lib/api.js                   backend client with token, timeouts and offline queueing
  content/extractor.js         dependency-free Readability-style extractor (classic script)
  content/observer.js          dwell/scroll tracking, SPA navigation detection
  popup/  options/             chat UI and the full privacy console
  icons/                       generated by scripts/make_icons.py (pure stdlib PNG writer)

server/                        Flask app, stdlib + numpy + sqlite-vec only
  app.py                       routes, dashboard hosting, engine introspection
  security.py                  token auth, CSRF header, CORS for extensions, pairing
  db.py                        schema v5, WAL, thread-local conns, sqlite-vec wiring
  capture.py                   check_url / ingest / modes / forget / export / import / wipe
  text.py                      cleaning (incl. hard-wrap rejoining), chunking, sentences,
                               query hygiene, time windows
  html_extract.py              dependency-free HTML → readable text (for fetched pages)
  embeddings/                  hash-v1 (default) | sentence-transformers | OpenAI-compatible
  vector_store.py              sqlite-vec KNN with exact-scan fallback
  lexical.py                   FTS5 (title+text) + Python BM25 rescore, porter tolerance
  retrieval.py                 hybrid fusion, calibration, evidence gate, page re-rank
  llm/                         extractive (default) | anthropic | openai-compatible
  assistant.py                 intent → retrieval → optional web → answer, SSE streaming
  web_search.py                duckduckgo | brave | tavily | serper, budgeted + cached
  interests.py  digest.py  enrichment.py  jobs.py  scheduler.py
  static/                      the dashboard (index.html, pair.html, app.css, app.js)

tests/                         55 stdlib-unittest tests (privacy, retrieval, grounding,
                               budgets, security, text units, extension/server sync)
scripts/                       seed_demo.py, make_icons.py
```

### Retrieval in one paragraph

Queries are matched two ways at once: FTS5 full-text (title boosted, BM25 rescored in
Python with Lucene-style IDF and porter-stem tolerance) and vector similarity
(sqlite-vec cosine, or an exact scan when the extension is unavailable). The two are
fused with per-embedder weights — the hash embedder leans lexical, real embedding
models lean vector — then pages are re-ranked `0.7·relevance + 0.3·recency`. Vector
scores are calibrated against each embedder's `reference_similarity`, and a match only
counts as *grounded* with real evidence: lexical coverage, or raw cosine ≥ 2.2× the
embedder's noise floor. A lexical-blind embedder with zero lexical coverage is capped
hard, which is what keeps char-n-gram collisions ("mode" vs "model") from producing
confident nonsense.

### Upgrades (all optional, auto-detected)

| Want | Do |
|---|---|
| Real semantic embeddings | `pip install sentence-transformers` (or set `OPENAI_API_KEY`) |
| Fluenter answers | set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` / `OPENAI_BASE_URL` (works with Ollama/vLLM) |
| Live web search | default DuckDuckGo needs nothing; `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY` for better results |

Everything degrades gracefully: with nothing installed you still get capture, hybrid
retrieval, grounded answers, digests and budgets — fully offline.

---

## API sketch

All routes are token-authenticated (`Authorization: Bearer …`, `?token=…`, or the
pairing cookie); browser writes must also send `X-Requested-With: TwinBrain`.

```
GET  /api/health  /api/engine  /api/stats  /api/suggestions  /api/token
POST /api/capture  /api/capture/visit  /api/heartbeat
GET  /api/query?q=…            POST /api/query {query, style, use_web, top_k}
GET  /api/query/stream?q=…     (SSE: intent → sources → grounding → web → answer → citations)
GET  /api/pages  /api/pages/<id>  /api/pages/<id>/text  /api/page-by-url
POST /api/forget   GET/POST /api/domains  POST /api/domains/mode
GET  /api/interests  /api/digest  /api/insights  /api/notifications
POST /api/enrichment/run   GET /api/enrichment   (the outbound audit log)
GET/POST /api/settings     POST /api/llm/provider
GET/POST /api/export       POST /api/import      POST /api/wipe
GET  /api/jobs             POST /api/jobs/run/<name>
```

## Configuration

`.env` in the repo root (see `.env.example`) or environment variables:
`TWINBRAIN_HOST`, `TWINBRAIN_PORT`, `TWINBRAIN_DATA_DIR`, `TWINBRAIN_EMBEDDER`,
`TWINBRAIN_LLM`, `TWINBRAIN_WEBSEARCH`, budgets, retrieval weights, retention.
Runtime knobs (capture switch, dwell, budgets, per-site modes…) live in the `settings`
table and are edited from the extension or the dashboard; the extension mirrors them
locally so privacy keeps working while the backend is offline.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `run.bat` window closes / "no usable Python interpreter" | Install Python 3.9+ from python.org with **"Add python.exe to PATH"** ticked, retry. |
| "Flask could not be installed into .venv" | Internet is needed once for pip; delete the `.venv` folder and run again. |
| "Address already in use / Port 8765 is in use" | Another Twin-Brain is running — close it, or `set TWINBRAIN_PORT=8766` (Windows) / `TWINBRAIN_PORT=8766 ./run.sh` and reload the extension's Connection settings. |
| Extension badge stays grey / "backend offline" | Start the backend first; then popup → gear → Connection → **auto-fill** (or paste `data/token.txt`). |
| Dashboard asks for a token | Paste it once from the terminal banner / `data/token.txt`; it is remembered in the browser. |

## Development

```bash
./.venv/bin/python -m unittest discover -s tests -v   # 108 tests, no network needed
node --test tests/js/                                 # 112 on-device brain tests:
                                                      # retrieval, real-time friend,
                                                      # twin core, field regressions
                                                      # + full end-to-end runs
                                                      # against an in-memory IDB
./.venv/bin/python scripts/make_icons.py              # regenerate extension icons
./.venv/bin/python scripts/seed_demo.py --wipe        # demo memory
```
