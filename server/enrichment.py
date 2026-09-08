"""Backend knowledge growth.

What this does: on a schedule (and on demand) it takes topics/pages from the
user's *own* history, runs a budgeted backend web search, keeps only results
that add something the user's memory does not already contain, and raises at
most `enrichment_daily_budget` (default 5) notifications a day.

What it deliberately does NOT do:
  * search for anything that is not traceable to a page the user actually read
  * mix web content into "your memory" without labelling it
  * run more than the daily budget, even if there is more to find

Auditability: every outbound query is recorded in `enrichment_runs`, and the
dashboard shows them, so you can see exactly what left your machine.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from . import db, digest, retrieval, web_search
from .capture import ingest
from .html_extract import extract_page, looks_like_html
from .http_client import HttpError, request
from .text import content_words, human_time, pretty_domain, truncate

log = logging.getLogger("twinbrain.enrichment")

_NOVEL_MIN = 2          # at least this many genuinely new terms to bother the user
_MAX_FETCH_BYTES = 900_000


# ---------------------------------------------------------------------------
# what should we go and learn more about?
# ---------------------------------------------------------------------------


def growth_candidates(limit: int = 5) -> list[dict[str, Any]]:
    """Pick the topics/pages most worth a backend search, with reasons."""
    candidates: list[dict[str, Any]] = []
    seen_topics: set[str] = set()

    # 1) pages the user actually invested time in, recently, not yet enriched
    rows = db.query(
        """SELECT p.id, p.title, p.url, p.domain, p.topics, p.total_dwell_seconds,
                  p.visit_count, COALESCE(p.last_visited_at, p.visited_at) AS visited_at
           FROM pages p
           WHERE p.ai_visible = 1 AND p.word_count > 60
             AND p.source != 'web_enrichment'
           ORDER BY (p.total_dwell_seconds * 0.6 + p.visit_count * 90) DESC
           LIMIT 60""")

    enriched_pages = {r["value"] for r in db.query(
        "SELECT DISTINCT value FROM forgotten WHERE kind='enriched_page'")}

    for row in rows:
        if row["id"] in enriched_pages:
            continue
        topics = _topics_of(row["topics"])
        topic = topics[0] if topics else ""
        title = (row["title"] or "").strip()
        if not title or len(title) < 12:
            continue
        if topic and topic in seen_topics:
            continue
        # skip pure-navigation / listicle pages: they make bad search queries
        if re.search(r"\b(home|login|sign in|cart|checkout|search results|"
                     r"watch later|notifications|inbox)\b", title, re.I):
            continue
        candidates.append({
            "kind": "page_update",
            "page_id": row["id"],
            "topic": topic or title,
            "title": title,
            "url": row["url"],
            "domain": row["domain"] or "",
            "query": web_search.build_query(title, " ".join(topics[:3]), max_words=10),
            "reason": (f"you spent {int(row['total_dwell_seconds'] or 0)}s here"
                       + (f", {row['visit_count']} visits" if (row['visit_count'] or 1) > 1
                          else "")),
            "score": float(row["total_dwell_seconds"] or 0) + 100 * int(row["visit_count"] or 1),
        })
        if topic:
            seen_topics.add(topic)
        if len(candidates) >= limit:
            return candidates

    # 2) standing interests we have not refreshed for a while
    last_run = db.query_one(
        "SELECT MAX(created_at) AS t FROM enrichment_runs WHERE kind='interest'")
    for topic_row in db.query(
            "SELECT topic, weight, pages FROM interests WHERE source='derived' "
            "AND topic NOT LIKE '#%' ORDER BY weight DESC LIMIT 12"):
        topic = topic_row["topic"]
        if topic in seen_topics or len(topic) < 4:
            continue
        seen_topics.add(topic)
        candidates.append({
            "kind": "interest",
            "page_id": None,
            "topic": topic,
            "title": topic,
            "url": None,
            "domain": "",
            "query": web_search.build_query(topic, "latest developments", max_words=8),
            "reason": f"top interest ({topic_row['pages']} pages, weight "
                      f"{round(float(topic_row['weight']), 2)})",
            "score": float(topic_row["weight"]) * 100,
        })
        if len(candidates) >= limit:
            break

    candidates.sort(key=lambda c: -c["score"])
    return candidates[:limit]


def _topics_of(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [str(i.get("topic", "")).lstrip("#") for i in items if i.get("topic")][:6]


# ---------------------------------------------------------------------------
# novelty: is this actually new for this user?
# ---------------------------------------------------------------------------


def memory_terms(topic: str, limit_pages: int = 6) -> set[str]:
    """Terms the user's memory already knows about this topic."""
    terms: set[str] = set()
    res = retrieval.retrieve(topic, k=limit_pages, infer_time=False, require_text=False)
    for m in res.matches:
        terms |= set(content_words(m.title or ""))
        terms |= set(content_words(m.excerpt or ""))
        for s in m.snippets:
            terms |= set(content_words(s))
    return {t for t in terms if len(t) > 3}


_YEAR_RE = re.compile(r"\b(20\d{2}|19\d{2})\b")
_STOP_NOVEL = {"http", "https", "html", "www", "com", "org", "page", "article", "read",
               "more", "click", "share", "comment", "comments", "posted", "updated"}


def score_novelty(result: dict[str, Any], known_terms: set[str]) -> dict[str, Any]:
    """How much does this result add on top of what the user already knows?"""
    text = f"{result.get('title','')} {result.get('snippet','')}"
    terms = {t for t in content_words(text) if len(t) > 3 and t not in _STOP_NOVEL}
    new_terms = sorted(terms - known_terms)
    years = [int(y) for y in _YEAR_RE.findall(text)]
    this_year = int(time.strftime("%Y", time.localtime()))
    recent_year = any(y >= this_year - 1 for y in years)
    freshness = 1 if recent_year else 0
    # titles that promise change are worth more
    change_words = {"new", "update", "updated", "released", "release", "launch", "launches",
                    "announced", "fix", "fixed", "patch", "v2", "beta", "ga", "price",
                    "drops", "now", "breaking", "changed", "changes", "deprecated", "eol"}
    change_hits = len(terms & change_words)
    score = len(new_terms) * 1.0 + freshness * 2.0 + change_hits * 1.5
    return {"score": round(score, 2), "new_terms": new_terms[:12],
            "new_term_count": len(new_terms), "recent_year": bool(recent_year),
            "change_hits": change_hits, "is_novel": len(new_terms) >= _NOVEL_MIN}


# ---------------------------------------------------------------------------
# running
# ---------------------------------------------------------------------------


def run_one(candidate: dict[str, Any] | None = None, *, force: bool = False,
            save_pages: bool | None = None) -> dict[str, Any]:
    """A single budgeted enrichment run."""
    budget = digest.insight_budget()
    if budget["remaining"] <= 0 and not force:
        return {"ok": False, "status": "budget",
                "detail": f"daily enrichment budget used ({budget['used']}/{budget['budget']})"}
    if not web_search.enabled():
        return {"ok": False, "status": "disabled", "detail": "backend web search is off"}

    candidate = candidate or (growth_candidates(1) or [None])[0]
    if not candidate:
        return {"ok": False, "status": "empty", "detail": "nothing worth enriching yet"}

    started = time.perf_counter()
    known = memory_terms(candidate["topic"])
    search_res = web_search.search_and_ingest(candidate["query"], limit=6,
                                              kind="enrichment")
    results = search_res.get("results") or []
    scored = []
    for r in results:
        nov = score_novelty(r, known)
        scored.append({**r, "novelty": nov})
    novel = [r for r in scored if r["novelty"]["is_novel"]]
    novel.sort(key=lambda r: -r["novelty"]["score"])

    run_id = f"enr_{int(time.time() * 1000)}"
    insight = None
    saved_pages: list[str] = []

    if novel:
        best = novel[0]
        extra = novel[1:3]
        body_lines = [
            f"New on {pretty_domain(best.get('url',''))}: "
            f"{truncate(best.get('title',''), 140)}",
        ]
        if best.get("snippet"):
            body_lines.append(truncate(best["snippet"], 320))
        if best["novelty"]["new_terms"]:
            body_lines.append("Terms not in your memory yet: "
                              + ", ".join(best["novelty"]["new_terms"][:8]) + ".")
        body_lines.append(f"Why I looked: {candidate['reason']}. "
                          f"Your related page: \u201c{truncate(candidate.get('title') or candidate['topic'], 80)}\u201d")
        for r in extra:
            body_lines.append(f"Also: {truncate(r.get('title',''), 110)} — {r.get('url','')}")

        insight = digest.save_insight(
            kind="enrichment",
            title=f"New on {candidate['topic']}: {truncate(best.get('title',''), 70)}",
            body="\n".join(body_lines),
            url=best.get("url"),
            page_ids=[candidate["page_id"]] if candidate.get("page_id") else [],
            dedupe_key=f"enrich:{best.get('url')}",
            score=best["novelty"]["score"],
        )
        if insight and bool(db.get_setting("enrichment_notify", True)):
            digest.push_notification(insight)

        # optionally pull the actual page into memory, clearly labelled as
        # assistant-fetched so answers can never call it "a page you read"
        if save_pages is None:
            save_pages = bool(db.get_setting("web_ingest_enabled", True))
        if save_pages:
            for r in novel[:int(db.get_setting("web_ingest_per_run", 2))]:
                pid = fetch_and_store(r, topic=candidate["topic"], run_id=run_id)
                if pid:
                    saved_pages.append(pid)

    if candidate.get("page_id"):
        db.execute("INSERT OR REPLACE INTO forgotten(id, kind, value, reason, created_at) "
                   "VALUES(?,?,?,?,?)",
                   (f"enriched:{candidate['page_id']}", "enriched_page",
                    candidate["page_id"], run_id, db.now_iso()))

    db.execute(
        "INSERT INTO enrichment_runs(id, day, kind, query, provider, status, results, "
        "insight_id, latency_ms, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (run_id, db.today_str(), candidate["kind"], candidate["query"],
         search_res.get("provider"), ("ok" if novel else search_res.get("status", "empty")),
         json.dumps(scored[:8]), (insight or {}).get("id"),
         int((time.perf_counter() - started) * 1000), db.now_iso()))

    return {
        "ok": True, "run_id": run_id, "candidate": candidate,
        "query": candidate["query"], "provider": search_res.get("provider"),
        "results": len(results), "novel": len(novel),
        "top_novelty": (novel[0]["novelty"] if novel else None),
        "insight_id": (insight or {}).get("id"),
        "saved_pages": saved_pages,
        "budget_after": digest.insight_budget(),
        "took_ms": int((time.perf_counter() - started) * 1000),
        "status": "ok" if novel else "no_new_info",
    }


def run_daily(max_runs: int | None = None, *, force: bool = False) -> dict[str, Any]:
    """The daily sweep — never exceeds the configured budget."""
    if not bool(db.get_setting("enrichment_enabled", True)) and not force:
        return {"ok": False, "status": "disabled", "runs": []}
    budget = digest.insight_budget()
    max_runs = int(max_runs or budget["remaining"] or 0)
    if max_runs <= 0:
        return {"ok": True, "status": "budget_reached", "runs": [],
                "budget": budget}
    candidates = growth_candidates(max_runs)
    runs = []
    for candidate in candidates:
        out = run_one(candidate, force=force)
        runs.append({"topic": candidate.get("topic"), "status": out.get("status"),
                     "novel": out.get("novel", 0), "query": candidate.get("query")})
        if not out.get("ok"):
            break
        time.sleep(0.4)
    return {"ok": True, "status": "done", "runs": runs, "count": len(runs),
            "budget_after": digest.insight_budget()}


def fetch_and_store(result: dict[str, Any], *, topic: str = "", run_id: str = "") -> str | None:
    """Fetch a web result and store it, labelled as assistant-fetched."""
    url = result.get("url")
    if not url or not url.startswith("http"):
        return None
    if not bool(db.get_setting("web_ingest_enabled", True)):
        return None
    from .capture import check_url

    verdict = check_url(url)
    if not verdict["allowed"]:
        return None
    try:
        _, body, charset = request(url, timeout=12.0)
        html_text = body[:_MAX_FETCH_BYTES].decode(charset or "utf-8", "replace")
    except (HttpError, OSError, ValueError) as exc:
        log.debug("enrichment fetch failed for %s: %s", url, exc)
        return None
    if not looks_like_html(html_text):
        return None
    page = extract_page(html_text, url)
    if not page["text"] or len(page["text"]) < 200:
        return None
    out = ingest({
        "url": page["url"] or url,
        "title": page["title"] or result.get("title"),
        "text": page["text"],
        "description": result.get("snippet") or page.get("description"),
        "dwell_seconds": 0,
        "scroll_depth": 0,
        "source": "web_enrichment",
        "visited_at": db.now_iso(),
    }, embed=True)
    if out.get("stored"):
        db.execute("UPDATE pages SET summary=COALESCE(NULLIF(summary,''), ?) WHERE id=?",
                   (f"Assistant-fetched on {db.today_str()} while researching "
                    f"\u201c{topic}\u201d (run {run_id}). You did not visit this page "
                    f"yourself.", out["page_id"]))
        return out["page_id"]
    return None


def history(limit: int = 40) -> list[dict[str, Any]]:
    rows = db.query("SELECT * FROM enrichment_runs ORDER BY created_at DESC LIMIT ?", (limit,))
    out = []
    for r in rows:
        item = dict(r)
        try:
            item["results"] = json.loads(item.get("results") or "[]")[:3]
        except (TypeError, ValueError):
            item["results"] = []
        item["created_ago"] = human_time(item.get("created_at"))
        out.append(item)
    return out


def audit_outbound(limit: int = 100) -> list[dict[str, Any]]:
    """Every query the backend sent to the internet, newest first."""
    rows = db.query("SELECT day, kind, query, provider, status, created_at "
                    "FROM enrichment_runs ORDER BY created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]
