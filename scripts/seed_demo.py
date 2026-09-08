#!/usr/bin/env python3
"""Seed Twin-Brain with realistic demo history.

    ./.venv/bin/python scripts/seed_demo.py            # add demo memory
    ./.venv/bin/python scripts/seed_demo.py --wipe     # wipe first, then seed
    ./.venv/bin/python scripts/seed_demo.py --days 30  # spread over more days

This is how you see Phase 2/3 working immediately: real titles, real text,
realistic dwell times and visit patterns, spread over several days so the
recency re-ranking, the daily digest and the interest profile all have
something to work with.

Nothing here is fetched from the network — it is all local, deterministic text.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

PAGES: list[dict] = [
    # ---- cooking -----------------------------------------------------------
    dict(url="https://www.simplyrecipes.com/creamy-garlic-chicken-pasta-8612345",
         title="Creamy Garlic Chicken Pasta Recipe | Simply Recipes",
         domain_hint="simplyrecipes.com", hours_ago=26, dwell=480, scroll=0.92,
         text="""This creamy garlic chicken pasta comes together in one pan in 25 minutes.
Ingredients: 2 chicken breasts, 3 cloves garlic, 1 cup heavy cream, half a cup of grated
parmesan, 8 oz penne pasta, olive oil, salt and black pepper. Boil the pasta in salted water
until al dente and reserve a cup of the starchy water. Season the chicken and sear it in olive
oil until golden, about four minutes per side. Remove the chicken, add the minced garlic to the
same pan and cook for one minute until fragrant. Pour in the heavy cream, simmer for three
minutes, then whisk in the parmesan until the sauce coats a spoon. Slice the chicken, return it
to the pan, toss with the pasta and loosen the sauce with the reserved pasta water. Finish with
cracked black pepper and fresh parsley. Serves four.""",
         visits=2),
    dict(url="https://www.seriouseats.com/one-pan-lemon-garlic-shrimp-orzo",
         title="One-Pan Lemon Garlic Shrimp Orzo Recipe",
         domain_hint="seriouseats.com", hours_ago=52, dwell=310, scroll=0.8,
         text="""A weeknight shrimp orzo that uses one pan and takes twenty minutes. Toast the
orzo in butter before adding stock, which keeps the grains separate. Use cold unsalted butter
mounted at the end for a glossy sauce, and finish with lemon zest rather than extra juice so the
dish does not turn sour. Shrimp only needs ninety seconds per side; overcooked shrimp is the
most common mistake in this recipe.""",
         visits=1),
    dict(url="https://www.bbcgoodfood.com/howto/guide/sourdough-bread",
         title="How to make sourdough bread - step by step guide",
         domain_hint="bbcgoodfood.com", hours_ago=200, dwell=900, scroll=1.0,
         text="""Sourdough needs only flour, water and salt, plus a starter you build over seven
days by discarding half and feeding with equal weights of flour and water. Autolyse the dough for
an hour before adding salt to develop gluten without kneading. Bulk ferment at room temperature
until the dough has risen by half and shows bubbles, then shape and cold retard in the fridge
overnight. Bake in a preheated dutch oven at 240C with the lid on for twenty minutes, then
uncovered for another twenty five. Hydration of 72 percent is a good target for beginners.""",
         visits=3),
    # ---- programming / databases ------------------------------------------
    dict(url="https://realpython.com/python-sqlite3/",
         title="Python and SQLite: A Complete Guide - Real Python",
         domain_hint="realpython.com", hours_ago=8, dwell=900, scroll=1.0,
         text="""SQLite is a self-contained, serverless SQL database engine embedded in your
application. In Python the sqlite3 module ships with the standard library, so you need no driver
installation. Connect with sqlite3.connect(path), set row_factory = sqlite3.Row to access columns
by name, and always parameterise queries with placeholders to avoid SQL injection. Write-ahead
logging, enabled with PRAGMA journal_mode=WAL, allows one writer and many readers concurrently,
which is what you want in a Flask application. Use one connection per thread because SQLite
objects are not thread-safe by default. An index on a frequently filtered column turns a full
table scan into a logarithmic lookup. Use PRAGMA busy_timeout to survive lock contention instead
of crashing with SQLITE_BUSY.""",
         visits=4),
    dict(url="https://github.com/asg017/sqlite-vec",
         title="asg017/sqlite-vec: A vector search SQLite extension",
         domain_hint="github.com", hours_ago=6, dwell=300, scroll=0.6,
         text="""sqlite-vec is a vector search extension for SQLite that stores and queries float,
int8 and bit vectors in virtual tables called vec0. It supports brute-force KNN queries with
cosine, euclidean and L2 distance metrics, metadata filtering and partitioning. Because it is a
loadable extension it works anywhere SQLite works, including Python, Node, Rust and the browser
through WASM. Insert vectors with serialize_float32 and query with MATCH plus a k parameter.
Upsert is not implemented for vec0 virtual tables, so delete the rowid first and then insert.
It is a practical way to embed a small semantic search index inside an existing SQLite database
instead of running a separate vector server.""",
         visits=3),
    dict(url="https://flask.palletsprojects.com/en/stable/quickstart/",
         title="Quickstart - Flask Documentation (3.x)",
         domain_hint="flask.palletsprojects.com", hours_ago=20, dwell=220, scroll=0.75,
         text="""Flask is a lightweight WSGI web application framework. Define routes with the
app.route decorator, read JSON request bodies with request.get_json, and return a dictionary
which Flask serialises to JSON automatically. Blueprints let you split a large application into
modules. Run app.run with threaded=True during development and use a production server such as
gunicorn behind nginx in deployment. The application factory pattern, create_app, makes
configuration and testing simpler because you can create an isolated app instance per test.""",
         visits=2),
    dict(url="https://stackoverflow.com/questions/21743172/sqlite3-python-threading",
         title="python - SQLite3 threading: 'SQLite objects created in a thread...'",
         domain_hint="stackoverflow.com", hours_ago=9, dwell=180, scroll=0.45,
         text="""The accepted answer explains that sqlite3 connections default to
check_same_thread=True and must not be shared between threads. Options are to open one connection
per thread using threading.local, to pass check_same_thread=False and serialise access yourself
with a lock, or to use a connection pool. Sharing a single connection across threads without a
lock causes 'database is locked' errors and corrupted cursors under load.""",
         visits=1),
    dict(url="https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
         title="Prompt caching - Anthropic Docs",
         domain_hint="docs.anthropic.com", hours_ago=30, dwell=420, scroll=0.7,
         text="""Prompt caching lets you mark a prefix of your prompt with cache_control so
repeated system prompts and long context blocks are not reprocessed on every call. Cached input
tokens cost a fraction of a normal input token and the cache lives for five minutes, refreshed on
each hit. Put stable content first (system prompt, tool definitions, long documents) and variable
content last (the user turn), because a cache breakpoint only helps for the prefix before it.
Check usage.cache_read_input_tokens in the response to confirm the cache is actually being hit.""",
         visits=2),
    dict(url="https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Anatomy_of_a_WebExtension",
         title="Anatomy of a WebExtension - MDN",
         domain_hint="developer.mozilla.org", hours_ago=48, dwell=600, scroll=0.85,
         text="""A Manifest V3 extension consists of a manifest.json file, an optional background
service worker, content scripts that run in pages, a popup action, an options page and permission
declarations. The service worker is event-driven and can be terminated at any time, so never keep
state in global variables; use chrome.storage instead. Content scripts run in an isolated world
and must message the background worker to reach extension APIs. host_permissions control where
chrome.scripting.executeScript may inject, and the activeTab permission grants temporary access
after a user gesture.""",
         visits=3),
    dict(url="https://github.com/mozilla/readability",
         title="mozilla/readability: A standalone version of the reader view algorithm",
         domain_hint="github.com", hours_ago=50, dwell=260, scroll=0.5,
         text="""Readability is the library Firefox Reader Mode uses. It parses a document, removes
unlikely candidates such as navigation and sidebars by class and id heuristics, scores remaining
nodes by paragraph length, comma count and link density, then returns an article object with
title, byline, textContent, length and excerpt. Link density is the key signal: boilerplate blocks
are mostly links, prose blocks are mostly text.""",
         visits=1),
    # ---- AI / embeddings ---------------------------------------------------
    dict(url="https://www.sbert.net/docs/sentence_transformer/pretrained_models.html",
         title="Pretrained Models - Sentence-Transformers",
         domain_hint="sbert.net", hours_ago=70, dwell=540, scroll=0.9,
         text="""all-MiniLM-L6-v2 maps sentences to 384 dimensional vectors and is a good default
for semantic search: it is small, fast on CPU and scores well on the STS benchmark. For higher
accuracy use all-mpnet-base-v2 with 768 dimensions. Normalise embeddings so cosine similarity
becomes a dot product. The model downloads once from the Hugging Face hub and then runs fully
offline, which matters for privacy-sensitive local tools.""",
         visits=2),
    dict(url="https://huggingface.co/blog/rag-with-sqlite",
         title="Retrieval augmented generation without a vector database",
         domain_hint="huggingface.co", hours_ago=96, dwell=700, scroll=0.95,
         text="""For a personal corpus of tens of thousands of documents you do not need a hosted
vector database. Store embeddings as BLOBs in SQLite, load them into numpy and compute cosine
similarity in a single matrix multiplication; a scan over 50k 384-dimensional vectors takes tens
of milliseconds. Hybrid retrieval, combining BM25 from SQLite FTS5 with vector similarity and
reciprocal rank fusion, beats either signal alone because BM25 supplies corpus-level IDF while
the embeddings supply paraphrase tolerance. Always re-rank with a recency or engagement term so
stale matches do not crowd out current ones.""",
         visits=2),
    dict(url="https://simonwillison.net/2024/embeddings-hallucination/",
         title="Grounding LLM answers in retrieved context to avoid hallucination",
         domain_hint="simonwillison.net", hours_ago=120, dwell=380, scroll=0.65,
         text="""The reliable way to stop a model inventing facts is to constrain what it is
allowed to say: give it a small retrieved context, tell it explicitly that it may only reference
what is in that context, and make 'I don't know' an acceptable answer. Cite sources in the
response so the user can verify each claim. A system prompt that says 'never say you don't know'
is an instruction to hallucinate. Keep the retrieved context small: long contexts dilute
attention and increase the chance of the model blending two documents into one false claim.""",
         visits=1),
    # ---- general reading ---------------------------------------------------
    dict(url="https://news.ycombinator.com/item?id=41234567",
         title="Ask HN: What is your favourite local-first tool?",
         domain_hint="news.ycombinator.com", hours_ago=12, dwell=400, scroll=0.55,
         text="""A discussion about local-first software where your data lives on your device and
syncing is optional. Comments mention SQLite as the ideal local store, CRDTs for conflict-free
merging, and the privacy advantage of never sending personal data to a server. Several developers
describe building personal knowledge tools that index browsing history locally with embeddings
computed on the device, and warn that a browser extension capturing everything needs an explicit
exclusion list for banking and health sites before it is trustworthy.""",
         visits=2),
    dict(url="https://www.theverge.com/2026/8/28/on-device-ai-browser-privacy",
         title="On-device AI is quietly becoming the default in browsers",
         domain_hint="theverge.com", hours_ago=60, dwell=240, scroll=0.5,
         text="""Browser vendors are shipping local inference APIs, but capability is still
limited compared with server models, and the memory footprint of even a small transformer rules
out running embeddings for every page visit on low-end hardware. The pragmatic architecture is a
local capture layer, a local index and an optional cloud model called with a tiny retrieval-
limited prompt rather than a full history.""",
         visits=1),
    dict(url="https://www.nhs.uk/live-well/sleep-and-tiredness/how-to-get-to-sleep/",
         title="How to get to sleep - NHS",
         domain_hint="nhs.uk", hours_ago=300, dwell=150, scroll=0.4,
         text="""Keep a regular sleep schedule, avoid screens for an hour before bed, and keep the
bedroom cool and dark. If you cannot sleep after twenty minutes, get up and do something calm
rather than lying awake. Caffeine after midday and alcohol in the evening both reduce sleep
quality even when they help you fall asleep faster.""",
         visits=1),
    dict(url="https://www.rtings.com/headphones/reviews/best/noise-cancelling",
         title="The 5 Best Noise Cancelling Headphones of 2026",
         domain_hint="rtings.com", hours_ago=150, dwell=520, scroll=0.75,
         text="""Measured attenuation across the low, mid and high frequency bands, plus battery
life with ANC enabled and comfort over a four hour session. The top pick cancels 22 dB at 100 Hz
and lasts 31 hours; the budget pick gives up 4 dB of low-frequency attenuation for a third of the
price. Wireless codecs matter less than fit for perceived isolation.""",
         visits=2),
    dict(url="https://jvns.ca/blog/2024/01/debugging-tools/",
         title="A list of debugging tools I actually use",
         domain_hint="jvns.ca", hours_ago=180, dwell=660, scroll=0.9,
         text="""tcpdump and wireshark for network problems, strace and lsof for syscall-level
surprises, perf and flamegraphs for CPU hotspots, and curl with -v for anything HTTP. The common
thread is observing what the program actually did rather than reasoning about what it should have
done. For SQLite specifically, the .timer and EXPLAIN QUERY PLAN commands inside the sqlite3 CLI
answer most performance questions in seconds.""",
         visits=1),
    dict(url="https://roadmap.sh/backend",
         title="Backend Developer Roadmap",
         domain_hint="roadmap.sh", hours_ago=220, dwell=340, scroll=0.6,
         text="""A visual roadmap covering languages, frameworks, databases, APIs, caching,
message queues, containers and observability for backend developers. Recommends learning one
relational database deeply before touching a NoSQL store, and understanding HTTP semantics and
authentication before picking a framework.""",
         visits=1),
]


def build(days: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    now = time.time()
    span = max(days, 1) * 24
    out: list[dict] = []
    for page in PAGES:
        base = page["hours_ago"]
        scale = span / max(p["hours_ago"] for p in PAGES)
        hours = max(0.5, base * scale) if scale > 1 else base
        for visit in range(int(page.get("visits", 1))):
            jitter = rng.uniform(0.4, 1.0) if visit else 1.0
            visited = now - hours * 3600 * jitter
            out.append({
                "url": page["url"],
                "title": page["title"],
                "text": page["text"] if visit == int(page.get("visits", 1)) - 1 else "",
                "visited_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(visited)),
                "dwell_seconds": int(page["dwell"] * rng.uniform(0.6, 1.1)),
                "scroll_depth": round(min(1.0, page["scroll"] * rng.uniform(0.85, 1.05)), 2),
                "source": "extension",
            })
    out.sort(key=lambda p: p["visited_at"])
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wipe", action="store_true", help="delete existing memory first")
    parser.add_argument("--days", type=int, default=14, help="spread history over N days")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--no-jobs", action="store_true", help="skip digest/interest jobs")
    args = parser.parse_args()

    from server import capture, db, jobs

    if args.wipe:
        print("wiping existing memory...")
        capture.wipe_all(keep_settings=True)

    payloads = build(args.days, args.seed)
    print(f"seeding {len(payloads)} visits across {len(PAGES)} distinct pages...")
    result = capture.ingest_many(payloads)
    print(f"  ingested={result['ingested']} created={result['created']} "
          f"skipped={result['skipped']} chunks={result['chunks']}")
    if result["errors"]:
        for err in result["errors"][:5]:
            print(f"  error: {err}")

    if not args.no_jobs:
        print("recomputing interests...")
        print(" ", jobs.recompute_interests())
        print("building digest...")
        digest = jobs.build_digest(notify=False)
        print(" ", str(digest.get("digest"))[:300])

    stats = db.stats()
    print("\nmemory now:")
    for key in ("pages", "visits", "chunks", "embedded_chunks", "domains", "total_words",
                "total_dwell_seconds"):
        print(f"  {key:22s} {stats[key]}")
    print(f"\nDashboard: http://127.0.0.1:{os.environ.get('TWINBRAIN_PORT','8765')}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
