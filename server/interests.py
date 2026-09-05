"""Derived interest & habit profile — "understand what the user actually reads".

Ground rules (this is where these systems usually start lying):

* Every interest is computed from stored pages, with the evidence listed.
  Nothing is inferred from a vibe.
* The profile is recomputed from scratch, so it can never drift out of sync
  with a deletion: forget a page and it leaves the profile immediately.
* The "what kind of person is this" line is emitted only when the evidence is
  strong, is always labelled as an inference, and always shows its evidence.
"""

from __future__ import annotations

import json
import logging
import math
import time
from collections import Counter, defaultdict
from typing import Any

from . import db
from .embeddings.hashing import CONCEPTS
from .text import (bigrams, content_words, format_dwell, human_time, pretty_domain,
                   registrable_domain, truncate)

log = logging.getLogger("twinbrain.interests")

PERSONA_LABELS = {
    "programming": "a software developer",
    "ai": "someone working with AI / ML",
    "design": "a designer",
    "finance": "someone focused on markets or personal finance",
    "security": "a security practitioner",
    "health": "someone tracking health topics closely",
    "science": "a researcher or science reader",
    "gaming": "a gamer",
    "music": "a music listener/creator",
    "cooking": "someone who cooks",
    "travel": "a traveller",
    "learning": "a student / active learner",
    "work": "a job seeker or hiring manager",
    "auto": "a car enthusiast",
    "news": "a heavy news reader",
    "shopping": "an active online shopper",
    "home": "a home/DIY improver",
    "database": "someone working with databases",
    "python": "a Python developer",
    "javascript": "a JavaScript/web developer",
}

DEV_DOMAIN_HINTS = {
    "github.com", "gitlab.com", "stackoverflow.com", "stackexchange.com", "dev.to",
    "medium.com", "news.ycombinator.com", "reddit.com", "developer.mozilla.org",
    "docs.python.org", "pypi.org", "npmjs.com", "codepen.io", "leetcode.com",
    "hackerrank.com", "freecodecamp.org", "realpython.com", "w3schools.com",
    "geeksforgeeks.org", "baeldung.com", "digitalocean.com", "vercel.com",
    "netlify.com", "aws.amazon.com", "cloud.google.com", "learn.microsoft.com",
    "kaggle.com", "huggingface.co", "arxiv.org", "postgresql.org", "sqlite.org",
}


def _tz_offset_minutes() -> int:
    try:
        return int(db.get_setting("tz_offset_minutes", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _local_hour(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        epoch = time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (ValueError, OverflowError):
        return None
    return (time.gmtime(epoch + _tz_offset_minutes() * 60).tm_hour) % 24


# ---------------------------------------------------------------------------
# concept detection
# ---------------------------------------------------------------------------


def detect_concepts(text: str, title: str = "", domain: str = "") -> Counter:
    """Count lexicon concept hits in a page's own text (transparent, no model)."""
    hits: Counter = Counter()
    words = content_words((title or "") + " " + (text or "")[:6000])
    if not words:
        return hits
    counts = Counter(words)
    for word, count in counts.items():
        for concept in _CONCEPT_WORDS.get(word, ()):
            hits[concept] += math.log1p(count)
    reg = registrable_domain(domain or "")
    if reg in DEV_DOMAIN_HINTS:
        hits["programming"] += 1.2
    return hits


_CONCEPT_WORDS: dict[str, list[str]] = {}
for _concept, _words in CONCEPTS.items():
    for _w in _words:
        _CONCEPT_WORDS.setdefault(_w, []).append(_concept)


# ---------------------------------------------------------------------------
# recompute
# ---------------------------------------------------------------------------


def recompute(*, limit_pages: int = 20_000) -> dict[str, Any]:
    """Rebuild the whole profile from stored pages. Idempotent."""
    started = time.perf_counter()
    if not bool(db.get_setting("interest_learning_enabled", True)):
        return {"ok": True, "skipped": "interest learning disabled"}

    rows = db.query(
        """SELECT id, url, title, domain, registrable_domain, COALESCE(topics,'') AS topics,
                  COALESCE(excerpt,'') AS excerpt, word_count, visit_count,
                  total_dwell_seconds, max_scroll_depth,
                  COALESCE(last_visited_at, visited_at) AS visited_at
           FROM pages WHERE ai_visible = 1 AND word_count > 0
           ORDER BY visited_at DESC LIMIT ?""", (limit_pages,))

    topic_scores: dict[str, float] = defaultdict(float)
    topic_pages: dict[str, set] = defaultdict(set)
    topic_evidence: dict[str, list[dict]] = defaultdict(list)
    concept_scores: Counter = Counter()
    concept_pages: dict[str, set] = defaultdict(set)
    concept_evidence: dict[str, list[dict]] = defaultdict(list)
    site_dwell: Counter = Counter()
    site_pages: Counter = Counter()
    site_visits: Counter = Counter()
    total_dwell = 0
    total_words = 0
    now = time.time()

    for row in rows:
        pid = row["id"]
        dwell = float(row["total_dwell_seconds"] or 0)
        visits = int(row["visit_count"] or 1)
        words = int(row["word_count"] or 0)
        total_dwell += dwell
        total_words += words
        visited_epoch = _epoch(row["visited_at"]) or now
        recency = math.exp(-math.log(2) * max(0.0, (now - visited_epoch) / 86400.0) / 45.0)
        # engagement weight: real signals only (time spent + repeat visits)
        engage = (math.log1p(dwell) * 0.6 + math.log1p(visits) * 0.4 +
                  0.4 * float(row["max_scroll_depth"] or 0)) * (0.6 + 0.4 * recency)

        try:
            topics = json.loads(row["topics"]) if row["topics"] else []
        except (TypeError, ValueError):
            topics = []
        title = row["title"] or ""
        for item in topics[:12]:
            topic = str(item.get("topic", "")).strip().lower()
            if not topic or len(topic) < 3:
                continue
            weight = float(item.get("weight", 1.0)) * engage
            title_bonus = 2.2 if topic in content_words(title) else 1.0
            topic_scores[topic] += weight * title_bonus
            topic_pages[topic].add(pid)
            if len(topic_evidence[topic]) < 4:
                topic_evidence[topic].append({
                    "page_id": pid, "title": truncate(title, 90),
                    "domain": row["domain"] or "", "visited_at": row["visited_at"]})

        concepts = detect_concepts((row["excerpt"] or "") + " " + title, title,
                                   row["domain"] or "")
        for concept, score in concepts.items():
            concept_scores[concept] += score * engage
            concept_pages[concept].add(pid)
            if len(concept_evidence[concept]) < 4:
                concept_evidence[concept].append({
                    "page_id": pid, "title": truncate(title, 90),
                    "domain": row["domain"] or "", "visited_at": row["visited_at"]})

        reg = row["registrable_domain"] or registrable_domain(row["domain"] or "")
        if reg:
            site_dwell[reg] += dwell
            site_pages[reg] += 1
            site_visits[reg] += visits

    # ---- normalise + persist -------------------------------------------
    max_topic = max(topic_scores.values(), default=0.0) or 1.0
    max_concept = max(concept_scores.values(), default=0.0) or 1.0
    max_topics_setting = int(db.get_setting("interest_max_topics", 40))
    now_iso = db.now_iso()

    db.execute("DELETE FROM interests WHERE source='derived'")
    written = 0
    combined: list[tuple[str, float, int, list]] = []
    for topic, score in topic_scores.items():
        combined.append((topic, score / max_topic, len(topic_pages[topic]),
                         topic_evidence[topic]))
    for concept, score in concept_scores.items():
        combined.append((f"#{concept}", score / max_concept, len(concept_pages[concept]),
                         concept_evidence[concept]))
    combined.sort(key=lambda t: -t[1])
    for topic, weight, pages, evidence in combined[:max_topics_setting]:
        if weight <= 0.02 or pages < 1:
            continue
        db.execute(
            "INSERT INTO interests(topic, weight, hits, pages, first_seen, last_seen, "
            "source, evidence) VALUES(?,?,?,?,?,?,?,?) "
            "ON CONFLICT(topic) DO UPDATE SET weight=excluded.weight, hits=excluded.hits, "
            "pages=excluded.pages, last_seen=excluded.last_seen, evidence=excluded.evidence",
            (topic, round(weight, 5), pages, pages, now_iso, now_iso, "derived",
             json.dumps(evidence[:4])))
        written += 1

    db.set_setting("interests_updated_at", now_iso)
    db.set_setting("profile_totals", {
        "pages": len(rows), "topics": written, "total_dwell": int(total_dwell),
        "total_words": total_words,
    })
    return {
        "ok": True, "pages_scanned": len(rows), "topics_written": written,
        "total_dwell_seconds": int(total_dwell), "total_words": total_words,
        "took_ms": int((time.perf_counter() - started) * 1000),
    }


def _epoch(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return time.mktime(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (ValueError, OverflowError):
        return None


# ---------------------------------------------------------------------------
# read side
# ---------------------------------------------------------------------------


def top_topics(n: int = 15) -> list[dict[str, Any]]:
    rows = db.query(
        "SELECT topic, weight, pages, last_seen, evidence FROM interests "
        "WHERE source='derived' ORDER BY weight DESC LIMIT ?", (n,))
    out = []
    for r in rows:
        try:
            evidence = json.loads(r["evidence"]) if r["evidence"] else []
        except (TypeError, ValueError):
            evidence = []
        out.append({"topic": r["topic"], "weight": round(float(r["weight"]), 4),
                    "pages": r["pages"], "last_seen": r["last_seen"],
                    "is_concept": r["topic"].startswith("#"),
                    "label": r["topic"].lstrip("#").replace("_", " "),
                    "evidence": evidence})
    return out


def top_sites(n: int = 12) -> list[dict[str, Any]]:
    rows = db.query(
        """SELECT registrable_domain AS domain, COUNT(*) AS pages,
                  COALESCE(SUM(visit_count),0) AS visits,
                  COALESCE(SUM(total_dwell_seconds),0) AS dwell,
                  MAX(COALESCE(last_visited_at, visited_at)) AS last_seen
           FROM pages WHERE ai_visible=1 AND registrable_domain IS NOT NULL
                        AND registrable_domain != ''
           GROUP BY registrable_domain
           ORDER BY (dwell * 0.5 + pages * 60 + visits * 20) DESC LIMIT ?""", (n,))
    return [{"domain": r["domain"], "label": pretty_domain(r["domain"]), "pages": r["pages"],
             "visits": r["visits"], "dwell_seconds": r["dwell"],
             "dwell_label": format_dwell(r["dwell"]), "last_seen": r["last_seen"],
             "last_seen_ago": human_time(r["last_seen"])} for r in rows]


def habits() -> dict[str, Any]:
    """Time-of-day / cadence patterns, computed from real visit rows."""
    rows = db.query(
        "SELECT visited_at, dwell_seconds, url, domain, page_id FROM page_visits "
        "ORDER BY visited_at DESC LIMIT 20000")
    by_hour: Counter = Counter()
    by_weekday: Counter = Counter()
    dwell_total = 0
    dwell_count = 0
    long_reads = 0
    day_pages: Counter = Counter()
    for r in rows:
        hour = _local_hour(r["visited_at"])
        if hour is not None:
            by_hour[hour] += 1
        epoch = _epoch(r["visited_at"])
        if epoch:
            by_weekday[time.localtime(epoch).tm_wday] += 1
            day_pages[time.strftime("%Y-%m-%d", time.localtime(epoch))] += 1
        dwell = int(r["dwell_seconds"] or 0)
        dwell_total += dwell
        dwell_count += 1
        if dwell >= 120:
            long_reads += 1

    peak_hour = max(by_hour, key=lambda h: by_hour[h]) if by_hour else None
    peak_day = max(by_weekday, key=lambda d: by_weekday[d]) if by_weekday else None
    weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                     "Saturday", "Sunday"]
    daily = sorted(day_pages.values(), reverse=True) if day_pages else []
    median_daily = daily[len(daily) // 2] if daily else 0

    # session detection: gap > 30 min starts a new session
    sessions = 0
    prev = None
    for r in reversed(rows):
        epoch = _epoch(r["visited_at"])
        if epoch is None:
            continue
        if prev is None or epoch - prev > 1800:
            sessions += 1
        prev = epoch

    return {
        "visits_analysed": len(rows),
        "peak_hour": peak_hour,
        "peak_hour_label": _hour_label(peak_hour),
        "hour_histogram": {str(h): by_hour.get(h, 0) for h in range(24)},
        "peak_weekday": weekday_names[peak_day] if peak_day is not None else None,
        "weekday_histogram": {weekday_names[d]: by_weekday.get(d, 0) for d in range(7)},
        "avg_dwell_seconds": int(dwell_total / dwell_count) if dwell_count else 0,
        "long_reads": long_reads,
        "long_read_ratio": round(long_reads / max(dwell_count, 1), 3),
        "median_pages_per_day": median_daily,
        "active_days": len(day_pages),
        "sessions_detected": sessions,
        "tz_offset_minutes": _tz_offset_minutes(),
    }


def _hour_label(hour: int | None) -> str:
    if hour is None:
        return ""
    if 5 <= hour < 12:
        return f"{hour:02d}:00 (morning)"
    if 12 <= hour < 17:
        return f"{hour:02d}:00 (afternoon)"
    if 17 <= hour < 22:
        return f"{hour:02d}:00 (evening)"
    return f"{hour:02d}:00 (night)"


def persona() -> dict[str, Any]:
    """A carefully-hedged read on who the user is, with its evidence attached."""
    topics = top_topics(30)
    concepts = [(t["label"], t["weight"], t["pages"], t["evidence"]) for t in topics
                if t["is_concept"]]
    sites = top_sites(10)
    site_domains = {s["domain"] for s in sites}
    habit_data = habits()

    if not concepts:
        return {"available": False, "reason": "not enough readable history yet",
                "statements": [], "evidence": []}

    top_concept, top_weight, top_pages, top_evidence = concepts[0]
    total_weight = sum(w for _, w, _, _ in concepts) or 1.0
    share = top_weight / total_weight
    dev_sites = sorted(site_domains & DEV_DOMAIN_HINTS)

    statements: list[str] = []
    evidence: list[str] = []
    confidence = "low"

    if share >= 0.28 and top_pages >= 5:
        label = PERSONA_LABELS.get(top_concept, f"a heavy {top_concept} reader")
        statements.append(f"You read mostly about {top_concept} — you look like {label}.")
        evidence.append(f"{top_pages} pages matched the '{top_concept}' topic "
                        f"({int(share * 100)}% of your topical weight)")
        confidence = "high" if (share >= 0.4 and top_pages >= 12) else "medium"
    elif top_pages >= 3:
        statements.append(f"Your strongest topic so far is {top_concept} "
                          f"({top_pages} pages), but the picture isn't settled yet.")
        evidence.append(f"top concept share: {int(share * 100)}%")
        confidence = "low"

    if dev_sites and any(c[0] in ("programming", "python", "javascript", "ai", "database")
                         for c in concepts[:4]):
        statements.append(f"Developer sites are a large share of your reading: "
                          f"{', '.join(dev_sites[:5])}.")
        evidence.append(f"{len(dev_sites)} known developer domains in your top sites")
        if confidence == "low":
            confidence = "medium"

    if len(concepts) >= 2 and concepts[1][1] / max(top_weight, 1e-9) >= 0.55:
        statements.append(f"Second strong interest: {concepts[1][0]} "
                          f"({concepts[1][2]} pages) — you switch between the two.")
        evidence.append(f"{concepts[1][0]} weight is "
                        f"{int(concepts[1][1] / max(top_weight, 1e-9) * 100)}% of your top topic")

    if habit_data.get("peak_hour") is not None and habit_data["visits_analysed"] >= 30:
        statements.append(f"You read most around {habit_data['peak_hour_label']}"
                          + (f", and {habit_data['peak_weekday']} is your busiest day."
                             if habit_data.get("peak_weekday") else "."))
        evidence.append(f"{habit_data['visits_analysed']} visits analysed, "
                        f"median {habit_data['median_pages_per_day']} pages/day")
    if habit_data.get("avg_dwell_seconds"):
        statements.append(f"Average time per page: "
                          f"{format_dwell(habit_data['avg_dwell_seconds'])}"
                          f"; {habit_data['long_reads']} pages got a real read (2 min+).")
        evidence.append(f"long-read ratio {int(habit_data['long_read_ratio'] * 100)}%")

    return {
        "available": bool(statements),
        "statements": statements,
        "evidence": evidence,
        "page_evidence": top_evidence,
        "confidence": confidence if statements else "low",
        "top_concepts": [{"concept": c, "weight": round(w, 4), "pages": p}
                         for c, w, p, _ in concepts[:8]],
        "top_sites": sites[:6],
        "habits": habit_data,
        "caveat": "Inferred only from pages you let me read. Nothing here is a "
                  "personality claim — it is a summary of your own history.",
    }


def profile() -> dict[str, Any]:
    return {
        "updated_at": db.get_setting("interests_updated_at"),
        "totals": db.get_setting("profile_totals", {}),
        "topics": top_topics(20),
        "sites": top_sites(12),
        "habits": habits(),
        "persona": persona(),
    }


def keywords_for_query(query: str, n: int = 8) -> list[str]:
    """Topic words from the user's own history that relate to a query."""
    words = [w for w in content_words(query)]
    if not words:
        return []
    rows = db.query("SELECT topic, weight FROM interests WHERE source='derived' "
                    "ORDER BY weight DESC LIMIT 200")
    scored = []
    for r in rows:
        topic = r["topic"].lstrip("#")
        if any(w in topic or topic in w for w in words):
            scored.append((float(r["weight"]), topic))
    scored.sort(reverse=True)
    seen: list[str] = []
    for _, topic in scored:
        if topic not in seen:
            seen.append(topic)
        if len(seen) >= n:
            break
    return seen


def related_topics(topic: str, n: int = 5) -> list[str]:
    """Topics that co-occur with `topic` on the same pages (real co-occurrence)."""
    rows = db.query(
        "SELECT id, topics FROM pages WHERE ai_visible=1 AND topics IS NOT NULL "
        "ORDER BY COALESCE(last_visited_at, visited_at) DESC LIMIT 20000")
    target = topic.lstrip("#").lower()
    co: Counter = Counter()
    for row in rows:
        try:
            topics = json.loads(row["topics"])
        except (TypeError, ValueError):
            continue
        names = [str(t.get("topic", "")).lower() for t in topics]
        if target in names:
            for name in names:
                if name and name != target:
                    co[name] += 1
    return [name for name, _ in co.most_common(n)]


def phrase_topics(n: int = 10) -> list[str]:
    """Frequent bigrams across the corpus — 'what you actually read about'."""
    rows = db.query("SELECT excerpt, title FROM pages WHERE ai_visible=1 "
                    "ORDER BY COALESCE(last_visited_at, visited_at) DESC LIMIT 500")
    text = " ".join((r["title"] or "") + " " + (r["excerpt"] or "") for r in rows)
    return bigrams(text, top_n=n, min_count=3)
