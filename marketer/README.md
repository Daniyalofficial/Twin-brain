# MarketerTwin v1.0 — your AI digital-marketing & Meta-Ads twin

A **standalone Chrome extension** (Manifest V3) that is simultaneously:

- a **real AI brain** for digital marketing: Meta Ads expert, sales-psychology
  master, branding/copywriting/funnel coach — fluent in **English and Roman Urdu**,
  with thousands of built-in marketing conversations, 80 curated marketing topics,
  56 field-tested sales tactics with ready-to-send scripts, and six classic
  marketing books taught in full;
- a **pyautogui-style Facebook automation clicker**: record your clicks on
  Facebook, save the positions (element paths, not pixels — they survive reloads),
  add waits / text-writing / scrolls / a share-to-groups loop, then replay with
  your timing, scroll-percent, image-wait and description options — in two modes,
  **Branding** and **Meta**, each with its own saved position set;
- a **group monitor**: add Facebook group links + an interval (e.g. 5 minutes) and
  the twin snapshots posts on a schedule, diffs them and notifies you about new ones;
- a **memory system** that remembers everything: your chats (multi-chat threads),
  pages you browsed and analyzed, web research it did for you, monitor snapshots,
  and *how you write* (a learned style profile it mirrors in its replies).

**No server. No localhost. No background process.** Everything lives in one
IndexedDB (`marktertwin`) inside Chrome. The ZIP in this repo
(`MarketerTwin-v1.0.zip`, rebuild with `python3 scripts/build_marketer_zip.py`)
loads straight from `chrome://extensions` → *Load unpacked*.

---

## Load it

1. Unzip `MarketerTwin-v1.0.zip` anywhere (or use the `marketer/` folder directly).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → pick the unzipped folder.
4. Pin the icon. `Alt+Shift+M` opens the **Studio** (full tab); the popup is the
   slim remote.

## The AI brain

| Layer | What it is | Size |
|---|---|---|
| Chat experience | retrieval-matched conversational turns (EN + Roman Urdu) over 49 intents | 5,148 turns |
| Knowledge core | BM25-retrieved marketing topics, always cited as built-in | 80 topics / 13 categories |
| Sales playbook | tactics by stage (opening → referral) with EN + Roman-Urdu scripts | 56 tactics / 8 stages |
| Bookshelf | six classics taught from complete original commentary (Cialdini, Ogilvy, Miller, Brunson, Tracy, Whitman) | 6 books / 51 lessons |
| Copy writer | psychology-composed post descriptions (hook→problem→offer→proof→urgency→CTA + hashtags), EN/RU | 7 Urdu banks + EN banks |
| Memory | hybrid retrieval (vector + BM25) over everything you read/analyzed, with citations and honest "I don't know" | unbounded |
| Style learner | deterministic profile of how you write; mirrored in replies and LLM prompts | grows with you |
| Daily learning | 9 PM alarm: refresh interests + one rotating marketing topic from the web (permission-gated, budgeted) | 5 searches/day cap |

**Honesty contract (unchanged from Twin-Brain):** the twin only claims knowledge of
*your* pages/history from retrieved memory and cites title + visit date; retrieval
misses produce a plain "this isn't in my memory", never invention. Web research
needs your permission (ask / always / never), capped by daily budgets.

**Multi-chat:** every thread is a persisted chat (title, messages, citations). The
last turns of a thread become retrieval history, so "tell me more" and follow-ups
work; finished chats stay in long-term memory (`memories` store) and feed answers.

## The API system — "full our extension way"

Settings → *AI provider*: pick **OpenAI-compatible** and paste a **base URL**,
**API key** and **model** (OpenAI, Groq, DeepSeek, OpenRouter, any compat server).
MarketerTwin then sends the **pre-made sales-master system prompt** — a fully-acted
persona (7-figure Meta media buyer + direct-response copywriter + closing-trained
sales consultant, EN/RU mirrorer, honest-policy-bound) — plus retrieved memory,
your style profile and the emotion/tone read. The answer streams token-by-token
into the chat. Edit or replace the prompt in Settings; **Reset** restores the
factory act. No provider? The full built-in engine answers — nothing breaks.

## Facebook automation (the clicker)

`content/fb.js` is injected on facebook.com. Because a browser extension cannot
touch the OS mouse, "positions" are recorded as **CSS selector paths plus human
hints** (aria-label / visible text) — the same click, found again after Facebook's
DOM shuffle, with a text-based fallback. Recording happens on the live page:

- click anywhere → step recorded with its delay;
- panel buttons add **wait (n s)**, **image-pick wait** (uses your configured
  seconds, default 40 — pick the photo yourself while it counts), **write** (text
  with `{description}` / `{group}` placeholders), **scroll %**, and **loop
  START/END** markers for the share-to-groups cycle;
- **Stop & Save** stores the flow under its mode (**Branding** or **Meta**).

**Two replay engines, your choice per play:**

1. **Element mode (default, smart).** Finds each saved element again by selector
   path + human hint (survives scrolling and layout shifts), clicks it, writes
   text into Facebook's React editors safely (native setters + input events;
   `execCommand`/paste for contenteditable composers).
2. **🖱 Cursor mode (pyautogui-style).** Tick the checkbox in Play options and
   the player dispatches **true input events** — eased mouseMoved glide,
   mousePressed/mouseReleased, mouseWheel, `insertText` — at your exact saved
   x/y coordinates through Chrome's debugger input channel. Hover states, focus
   and handlers react like a real hand moving to each saved position and
   clicking it. (Honest platform note: no browser extension can move your *OS*
   mouse pointer — that is an OS-level privilege pyautogui holds outside the
   browser; cursor mode is the closest real thing inside Chrome, and a
   "debugging this browser" banner shows while it plays.)

Both modes honour your speed multiplier, the 40-second image-pick wait, element
timeouts, scroll percents and the description source (**AI-generated**, **saved
manual description**, or typed). Loop segments repeat once per group on your
list, substituting `{group}`. Progress streams to the Studio console live.

Manual descriptions are savable in the library (name + text + hashtags) and
reusable everywhere; the AI writer produces three psychology-based variants with
the principles it used, in English or Roman Urdu, hashtags included.

## Group monitors

Add a group/page URL + interval. Every minute an alarm checks which monitors are
due; due ones open in an **inactive background tab**, get scraped (post hash,
author, snippet), closed, diffed against the stored snapshot. New posts → a
budgeted notification + an audit row + a memory entry. First scan is a silent
baseline. Pause/resume/scan-now/delete per monitor; the last 60 scan results stay
in each monitor's log.

## Data — one IndexedDB, `marktertwin`

`chats` (threads) · `memories` (chat turns, monitor events, research) · `facts`
(who you are) · `style` (writing profile) · `flows` (recorded positions) ·
`descriptions` (manual library) · `monitors` (watchers + snapshots) · `queue`,
`pages`, `chunks`, `interests`, `convs`, `audit`, `meta` (engine memory +
settings + budgets). **Export everything** (JSON) or **wipe** (type WIPE) from
Memory. Settings live in `chrome.storage.local`.

## Develop

```bash
node --test tests/js/marketer.test.mjs     # 16 tests: data, routing, engines, store, brain
node --test tests/js/*.mjs                  # the whole JS suite (149 tests)
node scripts/build_mkt_corpus.mjs           # regenerate the 5,148-turn chat corpus
python3 scripts/build_marketer_zip.py       # rebuild MarketerTwin-v1.0.zip
```

Layout: `background.js` (capture + alarms + routing) · `lib/mt.js` (MarketerTwin
service desk) · `lib/store.js` (the DB) · `lib/brain/*` (engines: understand,
core, sales, fluent, copygen, style, neural, policy, research, websearch) ·
`lib/brain/data/*` (corpus, corekb, books, salesplay, urdu) · `content/fb.js`
(recorder/player/monitor) · `content/extractor.js + observer.js` (page memory) ·
`app/` (Studio) · `popup/` (slim remote).
