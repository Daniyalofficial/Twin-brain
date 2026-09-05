"""Daily digest + insight/notification bookkeeping.

The digest is built from real activity rows. If a neural LLM is configured it
polishes the wording; if not, the deterministic renderer below is used — same
facts either way, because the LLM only ever sees the activity list.

Notifications are budgeted: `notification_daily_budget` (default 5/day) is
enforced here, so "only 5 times in a whole day" is a hard limit, not a hope.
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from typing import Any

from . import db
from .text import format_dwell, human_time, pretty_domain, truncate

log = logging.getLogger("twinbrain.digest")

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


# ---------------------------------------------------------------------------
# activity
# ---------------------------------------------------------------------------


def _day_bounds(day: str | None) -> tuple[str, str]:
    if not day:
        day = db.today_str()
    start = f"{day}T00:00:00"
    end = f"{day}T23:59:59"
    return start, end


def daily_activity(day: str | None = None, limit: int = 200) -> dict[str, Any]:
    day = day or db.today_str()
    start, end = _day_bounds(day)
    rows = db.query(
        """SELECT id, url, title, domain, registrable_domain, word_count, visit_count,
                  dwell_seconds, total_dwell_seconds, max_scroll_depth, excerpt,
                  COALESCE(last_visited_at, visited_at) AS visited_at
           FROM pages
           WHERE ai_visible = 1
             AND (COALESCE(last_visited_at, visited_at) BETWEEN ? AND ?
                  OR id IN (SELECT page_id FROM page_visits WHERE visited_at BETWEEN ? AND ?))
           ORDER BY visited_at DESC LIMIT ?""", (start, end, start, end, limit))

    # dwell for THIS day only — a page visited five times over a month must not
    # put its lifetime total into today's recap
    dwell_today: dict[str, int] = {}
    for row in db.query(
            "SELECT page_id, dwell_seconds FROM page_visits WHERE visited_at BETWEEN ? AND ?",
            (start, end)):
        if row["page_id"]:
            dwell_today[row["page_id"]] = dwell_today.get(row["page_id"], 0) + \
                int(row["dwell_seconds"] or 0)

    pages: list[dict[str, Any]] = []
    dwell_total = 0
    words_total = 0
    domains: Counter = Counter()
    domain_dwell: Counter = Counter()
    for r in rows:
        dwell = dwell_today.get(r["id"], int(r["dwell_seconds"] or 0))
        words = int(r["word_count"] or 0)
        dwell_total += dwell
        words_total += words
        reg = r["registrable_domain"] or r["domain"] or ""
        if reg:
            domains[reg] += 1
            domain_dwell[reg] += dwell
        pages.append({
            "page_id": r["id"], "url": r["url"], "title": r["title"] or r["url"],
            "domain": r["domain"] or "", "domain_label": pretty_domain(r["domain"] or ""),
            "visited_at": r["visited_at"], "visited_ago": human_time(r["visited_at"]),
            "dwell_seconds": dwell, "word_count": words, "visit_count": r["visit_count"] or 1,
            "scroll_depth": r["max_scroll_depth"] or 0.0, "excerpt": r["excerpt"] or "",
        })

    visits_today = db.query_one(
        "SELECT COUNT(*) AS c FROM page_visits WHERE visited_at BETWEEN ? AND ?",
        (start, end))

    # domains first seen today == genuinely new ground for the user
    new_domains: list[str] = []
    for d in domains:
        first = db.query_one(
            "SELECT MIN(first_visited_at) AS f FROM pages "
            "WHERE registrable_domain=? OR domain=?", (d, d))
        if first and first["f"] and str(first["f"]).startswith(day):
            new_domains.append(d)

    topics: Counter = Counter()
    for r in db.query("SELECT topics FROM pages WHERE ai_visible=1 AND topics IS NOT NULL "
                      "AND COALESCE(last_visited_at, visited_at) BETWEEN ? AND ?",
                      (start, end)):
        try:
            for item in json.loads(r["topics"]):
                topics[str(item.get("topic", "")).lstrip("#")] += float(item.get("weight", 1))
        except (TypeError, ValueError):
            continue

    long_reads = [p for p in pages if p["dwell_seconds"] >= 120]
    return {
        "day": day,
        "weekday": WEEKDAYS[time.strptime(day, "%Y-%m-%d").tm_wday],
        "pages": pages,
        "page_count": len(pages),
        "visit_count": int(visits_today["c"] or 0) if visits_today else 0,
        "dwell_seconds": dwell_total,
        "dwell_label": format_dwell(dwell_total),
        "word_count": words_total,
        "top_domains": [{"domain": d, "label": pretty_domain(d), "pages": c,
                         "dwell_label": format_dwell(domain_dwell[d])}
                        for d, c in domains.most_common(8)],
        "top_topics": [{"topic": t, "weight": round(w, 2)}
                       for t, w in topics.most_common(10) if t],
        "long_reads": long_reads[:6],
        "new_domains": new_domains[:8],
        "words_per_minute": round(words_total / max(dwell_total / 60.0, 0.01), 1)
        if dwell_total else 0,
    }


def render_digest(activity: dict[str, Any]) -> str:
    """Deterministic recap — every number here came from the activity dict."""
    if not activity["pages"]:
        return (f"Nothing was captured on {activity['weekday']} {activity['day']}. "
                f"Either you didn't browse, capture was paused, or the pages you "
                f"visited are on your exclusion list.")

    lines: list[str] = []
    lines.append(
        f"{activity['weekday']} {activity['day']}: {activity['page_count']} pages, "
        f"{activity['dwell_label']} of reading, ~{activity['word_count']:,} words.")

    if activity["top_domains"]:
        top = activity["top_domains"][:3]
        lines.append("Most time on: " + ", ".join(
            f"{d['label']} ({d['dwell_label']}, {d['pages']} pages)" for d in top) + ".")

    if activity["top_topics"]:
        lines.append("Topics: " + ", ".join(t["topic"] for t in activity["top_topics"][:6]) + ".")

    deep = activity["long_reads"][:3]
    if deep:
        lines.append("Deep reads: " + "; ".join(
            f"\u201c{truncate(p['title'], 60)}\u201d ({format_dwell(p['dwell_seconds'])})"
            for p in deep) + ".")

    if activity["new_domains"]:
        lines.append("New sites you hit today: "
                     + ", ".join(pretty_domain(d) for d in activity["new_domains"][:5]) + ".")

    if activity["words_per_minute"]:
        lines.append(f"Reading pace: ~{activity['words_per_minute']} words/min.")
    return " ".join(lines)


def build_digest(day: str | None = None, *, notify: bool = False) -> dict[str, Any]:
    activity = daily_activity(day)
    text = render_digest(activity)

    # optional LLM polish — same facts, it only sees the activity list
    provider = "deterministic"
    from .llm import get_llm

    llm = get_llm()
    if llm.name != "extractive" and bool(db.get_setting("digest_llm_polish", True)):
        try:
            from .llm.prompts import DIGEST_PROMPT

            compact = {
                "day": activity["day"], "pages": activity["page_count"],
                "reading_time": activity["dwell_label"], "words": activity["word_count"],
                "top_sites": activity["top_domains"][:5],
                "topics": [t["topic"] for t in activity["top_topics"][:8]],
                "deep_reads": [{"title": p["title"], "time": format_dwell(p["dwell_seconds"]),
                                "site": p["domain_label"]} for p in activity["long_reads"][:5]],
                "new_sites": activity["new_domains"][:6],
                "words_per_minute": activity["words_per_minute"],
            }
            prompt = DIGEST_PROMPT.format(activity=json.dumps(compact, indent=1)[:4000])
            polished = llm.complete([{"role": "system", "content": prompt},
                                     {"role": "user", "content": "Write today's recap."}],
                                    max_tokens=350)
            if polished and len(polished.strip()) > 40:
                text = polished.strip()
                provider = llm.name
        except Exception as exc:
            log.debug("digest polish failed: %s", exc)

    insight = save_insight(
        kind="digest",
        title=f"Your day in {activity['page_count']} pages",
        body=text,
        page_ids=[p["page_id"] for p in activity["pages"][:20]],
        dedupe_key=f"digest:{activity['day']}",
        score=float(activity["page_count"]),
        url=None,
    )
    if notify and insight:
        push_notification(insight)
    return {"day": activity["day"], "digest": text, "activity": activity,
            "provider": provider, "insight_id": (insight or {}).get("id")}


# ---------------------------------------------------------------------------
# insights & notification budget
# ---------------------------------------------------------------------------


def notification_budget() -> dict[str, Any]:
    day = db.today_str()
    budget = int(db.get_setting("notification_daily_budget", 5))
    row = db.query_one("SELECT COUNT(*) AS c FROM insights WHERE day=? AND notified=1", (day,))
    used = int(row["c"] or 0) if row else 0
    return {"day": day, "used": used, "budget": budget, "remaining": max(0, budget - used)}


def insight_budget() -> dict[str, Any]:
    """Enrichment budget — the 'only 5 times a day' cap from the spec."""
    day = db.today_str()
    budget = int(db.get_setting("enrichment_daily_budget", 5))
    row = db.query_one("SELECT COUNT(*) AS c FROM enrichment_runs WHERE day=?", (day,))
    used = int(row["c"] or 0) if row else 0
    return {"day": day, "used": used, "budget": budget, "remaining": max(0, budget - used)}


def save_insight(*, kind: str, title: str, body: str, page_ids: list[str] | None = None,
                 url: str | None = None, dedupe_key: str | None = None,
                 score: float = 0.0) -> dict[str, Any] | None:
    dedupe_key = dedupe_key or f"{kind}:{url or title}"
    existing = db.query_one("SELECT * FROM insights WHERE dedupe_key=?", (dedupe_key,))
    now = db.now_iso()
    day = db.today_str()
    if existing:
        db.execute("UPDATE insights SET body=?, title=?, score=?, page_ids=?, url=? WHERE id=?",
                   (body, title, score, json.dumps(page_ids or []), url, existing["id"]))
        row = db.query_one("SELECT * FROM insights WHERE id=?", (existing["id"],))
        return dict(row) if row else None
    insight_id = f"ins_{int(time.time() * 1000)}_{abs(hash(dedupe_key)) % 9973}"
    db.execute(
        "INSERT INTO insights(id, day, kind, title, body, url, page_ids, score, dedupe_key, "
        "created_at, notified, seen, dismissed) VALUES(?,?,?,?,?,?,?,?,?,?,0,0,0)",
        (insight_id, day, kind, truncate(title, 160), body, url,
         json.dumps(page_ids or []), score, dedupe_key, now))
    row = db.query_one("SELECT * FROM insights WHERE id=?", (insight_id,))
    return dict(row) if row else None


def push_notification(insight: dict[str, Any]) -> bool:
    """Mark an insight as notified if the daily budget allows it."""
    if not bool(db.get_setting("notifications_enabled", True)):
        return False
    budget = notification_budget()
    if budget["remaining"] <= 0:
        log.info("notification budget exhausted (%s/%s)", budget["used"], budget["budget"])
        return False
    db.execute("UPDATE insights SET notified=1 WHERE id=?", (insight["id"],))
    _pending.append(dict(insight))
    return True


# Notifications are pulled by the extension (MV3 service workers cannot receive
# server pushes without a socket), so we keep a small in-memory outbox and let
# /api/notifications drain it.
_pending: list[dict[str, Any]] = []


def drain_notifications(*, limit: int = 5) -> list[dict[str, Any]]:
    out = _pending[:limit]
    del _pending[:limit]
    return out


def pending_notifications() -> list[dict[str, Any]]:
    return list(_pending)


def list_insights(limit: int = 50, unseen_only: bool = False,
                  day: str | None = None) -> list[dict[str, Any]]:
    clauses = ["dismissed = 0"]
    params: list[Any] = []
    if unseen_only:
        clauses.append("seen = 0")
    if day:
        clauses.append("day = ?")
        params.append(day)
    rows = db.query(
        f"SELECT * FROM insights WHERE {' AND '.join(clauses)} "
        f"ORDER BY created_at DESC LIMIT ?", (*params, limit))
    out = []
    for r in rows:
        item = dict(r)
        try:
            item["page_ids"] = json.loads(item.get("page_ids") or "[]")
        except (TypeError, ValueError):
            item["page_ids"] = []
        item["created_ago"] = human_time(item.get("created_at"))
        out.append(item)
    return out


def mark_seen(insight_id: str, dismissed: bool = False) -> bool:
    cur = db.execute("UPDATE insights SET seen=1, dismissed=? WHERE id=?",
                     (1 if dismissed else 0, insight_id))
    return bool(cur.rowcount)
