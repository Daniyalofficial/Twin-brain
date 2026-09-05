"""The assistant: query in -> grounded answer out.

Orchestrates the whole chain:

    intent -> retrieval -> (optional budgeted web search) -> LLM -> persist

Meta questions ("what are my interests?", "what did I read today?") are routed
to the real data and answered *without* an LLM, because there is nothing to
generate: the numbers either exist or they don't.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any, Iterator

from . import db, digest, enrichment, interests, retrieval, web_search
from .config import get_config
from .llm import get_llm
from .llm.intent import classify
from .text import format_dwell, human_time, pretty_domain, truncate

log = logging.getLogger("twinbrain.assistant")

EXPLICIT_WEB = re.compile(r"\b(search|look|find)\s+(the\s+)?(web|internet|online)\b|"
                          r"\bgoogle\s+(it|that|this)\b|^web:|^search:", re.I)
SAVE_WEB = re.compile(r"\b(save|remember|store)\s+(this|that|these|it)\b", re.I)


# ---------------------------------------------------------------------------
# conversation history
# ---------------------------------------------------------------------------


def recent_turns(limit: int = 4) -> list[dict[str, str]]:
    rows = db.query("SELECT query, response FROM conversations "
                    "ORDER BY created_at DESC LIMIT ?", (limit,))
    turns: list[dict[str, str]] = []
    for row in reversed(rows):
        if row["query"]:
            turns.append({"role": "user", "content": row["query"]})
        if row["response"]:
            turns.append({"role": "assistant", "content": row["response"]})
    return turns


def _save_conversation(query: str, response_text: str, *, citations: list[dict],
                       provider: str, grounded: bool, used_web: bool,
                       web_results: list[dict], latency_ms: int, retrieval_ms: int,
                       mode: str) -> str:
    cid = f"c_{uuid.uuid4().hex[:16]}"
    db.execute(
        "INSERT INTO conversations(id, query, response, referenced_page_ids, citations, "
        "created_at, provider, grounded, used_web, web_results, latency_ms, retrieval_ms, mode) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, query, response_text,
         json.dumps([c["page_id"] for c in citations if c.get("page_id")]),
         json.dumps(citations), db.now_iso(), provider, 1 if grounded else 0,
         1 if used_web else 0, json.dumps(web_results[:8]) if web_results else None,
         latency_ms, retrieval_ms, mode))
    return cid


# ---------------------------------------------------------------------------
# meta answers (no LLM — straight from the data)
# ---------------------------------------------------------------------------


def _meta_answer(intent_name: str, query: str) -> dict[str, Any]:
    if intent_name == "meta_interests":
        profile = interests.profile()
        persona = profile["persona"]
        topics = [t for t in profile["topics"] if not t["is_concept"]][:12]
        concepts = [t for t in profile["topics"] if t["is_concept"]][:8]
        lines: list[str] = []
        if persona.get("available"):
            lines.extend(persona["statements"])
        else:
            lines.append("I don't have enough readable history to describe your interests yet.")
        if topics:
            lines.append("")
            lines.append("Your top topics (with the page count behind each):")
            lines.extend(f"  \u2022 {t['label']} — {t['pages']} pages, "
                         f"weight {round(t['weight'] * 100)}%" for t in topics[:10])
        if concepts:
            lines.append("")
            lines.append("Reading categories: "
                         + ", ".join(f"{c['label']} ({c['pages']} pages)" for c in concepts) + ".")
        if profile["sites"]:
            lines.append("")
            lines.append("Sites you spend the most time on: "
                         + ", ".join(f"{s['label']} ({s['dwell_label']})"
                                     for s in profile["sites"][:6]) + ".")
        habits = profile["habits"]
        if habits.get("peak_hour_label"):
            lines.append("")
            lines.append(f"Habit: you read most around {habits['peak_hour_label']}, "
                         f"median {habits['median_pages_per_day']} pages/day, "
                         f"average {format_dwell(habits['avg_dwell_seconds'])} per page.")
        if persona.get("caveat"):
            lines.append("")
            lines.append(persona["caveat"])
        return {
            "answer": "\n".join(lines),
            "data": {"profile": profile},
            "citations": [],
            "grounded": True,
            "confidence": persona.get("confidence", "low"),
        }

    if intent_name == "meta_stats":
        s = db.stats()
        budget = web_search.usage_today()
        lines = [
            f"Memory: {s['pages']:,} pages, {s['visits']:,} visits, "
            f"{s['total_words']:,} words across {s['domains']:,} domains.",
            f"Indexed: {s['chunks']:,} chunks, {s['embedded_chunks']:,} with vectors.",
            f"Reading time captured: {format_dwell(s['total_dwell_seconds'])}.",
            f"Questions answered: {s['conversations']:,}.",
            f"Privacy: {s['excluded_domains']} domains blocked, "
            f"{s['hidden_from_ai']} hidden from the AI, {s['forgotten']} things forgotten.",
            f"Backend web searches today: {budget['used']}/{budget['budget']}.",
            f"Database size: {s['db_bytes'] / 1e6:.1f} MB.",
        ]
        return {"answer": "\n".join(lines), "data": {"stats": s, "web_usage": budget},
                "citations": [], "grounded": True, "confidence": "high"}

    if intent_name == "meta_digest":
        day = db.today_str()
        m = re.search(r"\b(yesterday)\b", query, re.I)
        if m:
            day = time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
        built = digest.build_digest(day, notify=False)
        activity = built["activity"]
        lines = [built["digest"]]
        if activity["pages"]:
            lines.append("")
            lines.append("Pages:")
            lines.extend(f"  \u2022 {truncate(p['title'], 80)} — {p['domain_label']}, "
                         f"{human_time(p['visited_at'])} ({format_dwell(p['dwell_seconds'])}) "
                         f"{p['url']}" for p in activity["pages"][:8])
        return {"answer": "\n".join(lines),
                "data": {"activity": {k: v for k, v in activity.items() if k != "pages"},
                         "pages": activity["pages"][:25]},
                "citations": [{"index": i + 1, "page_id": p["page_id"], "title": p["title"],
                               "url": p["url"], "domain": p["domain"],
                               "visited_at": p["visited_at"],
                               "visited_ago": p["visited_ago"],
                               "dwell_seconds": p["dwell_seconds"], "excerpt": p["excerpt"],
                               "relevance": 0.0, "score": 0.0}
                              for i, p in enumerate(activity["pages"][:8])],
                "grounded": True, "confidence": "high"}

    if intent_name == "meta_timeline":
        days = 1
        if re.search(r"\bweek\b", query, re.I):
            days = 7
        elif re.search(r"\bmonth\b", query, re.I):
            days = 30
        since = time.time() - days * 86400
        items = retrieval.timeline(limit=25, since=since)
        if not items:
            return {"answer": f"No captured pages in the last {days} day(s).",
                    "data": {"pages": []}, "citations": [], "grounded": False,
                    "confidence": "none"}
        lines = [f"Your last {days} day(s) — {len(items)} pages shown:"]
        lines.extend(f"  \u2022 {truncate(p['title'], 70)} — {p['domain_label']}, "
                     f"{p['visited_ago']} ({format_dwell(p['dwell_seconds'])}) {p['url']}"
                     for p in items[:12])
        return {"answer": "\n".join(lines), "data": {"pages": items},
                "citations": [{"index": i + 1, "page_id": p["page_id"], "title": p["title"],
                               "url": p["url"], "domain": p["domain"],
                               "visited_at": p["visited_at"], "visited_ago": p["visited_ago"],
                               "dwell_seconds": p["dwell_seconds"], "excerpt": p["excerpt"],
                               "relevance": 0.0, "score": 0.0}
                              for i, p in enumerate(items[:12])],
                "grounded": True, "confidence": "high"}

    if intent_name == "meta_domains":
        sites = interests.top_sites(15)
        if not sites:
            return {"answer": "No sites in memory yet.", "data": {"sites": []},
                    "citations": [], "grounded": False, "confidence": "none"}
        lines = ["Sites in your memory, by time spent:"]
        lines.extend(f"  \u2022 {s['label']} — {s['pages']} pages, {s['visits']} visits, "
                     f"{s['dwell_label']}, last {s['last_seen_ago']}" for s in sites)
        return {"answer": "\n".join(lines), "data": {"sites": sites}, "citations": [],
                "grounded": True, "confidence": "high"}

    raise ValueError(f"unhandled meta intent: {intent_name}")


# ---------------------------------------------------------------------------
# web augmentation
# ---------------------------------------------------------------------------


def build_web_query(query: str, result: retrieval.RetrievalResult | None) -> str:
    """Make the outbound search specific to *this* user, using their own topics."""
    base = re.sub(r"^(web|search):\s*", "", (query or "").strip(), flags=re.I)
    base = re.sub(r"\b(search|look|find)\s+(the\s+)?(web|internet|online)\s+(for\s+)?",
                  "", base, flags=re.I).strip()
    extra_words: list[str] = []
    related = interests.keywords_for_query(base, n=4)
    for word in related:
        if word.lower() not in base.lower() and len(word) > 3:
            extra_words.append(word)
    if result and result.matches:
        top = result.matches[0]
        for word in [w for w in re.findall(r"[a-z0-9+#]{4,}", (top.title or "").lower())][:3]:
            if word not in base.lower() and word not in extra_words:
                extra_words.append(word)
    return web_search.build_query(base, " ".join(extra_words[:3]), max_words=14)


def maybe_web_search(query: str, result: retrieval.RetrievalResult | None,
                     intent: Any, *, force: bool = False) -> dict[str, Any] | None:
    if not bool(db.get_setting("web_search_enabled", True)):
        return None
    allow_for_answers = bool(db.get_setting("web_search_for_answers", True))
    explicit = bool(EXPLICIT_WEB.search(query or ""))
    if not (force or explicit or (allow_for_answers and intent.wants_web)
            or (allow_for_answers and result is not None and not result.grounded)):
        return None
    if not explicit and not force:
        # only spend budget when local memory is genuinely thin
        if result is not None and result.grounded and not intent.wants_web:
            return None
    budget = web_search.usage_today()
    if budget["remaining"] <= 0 and not force:
        return {"status": "budget", "results": [], "query": None,
                "error": "daily web-search budget exhausted"}
    web_query = build_web_query(query, result)
    if not web_query:
        return None
    return web_search.search_and_ingest(web_query, limit=5, kind="answer")


# ---------------------------------------------------------------------------
# the main entry point
# ---------------------------------------------------------------------------


def answer(query: str, *, style: str | None = None, since: float | None = None,
           until: float | None = None, domains: list[str] | None = None,
           use_web: bool | None = None, save: bool = True,
           top_k: int | None = None, use_history: bool = True) -> dict[str, Any]:
    started = time.perf_counter()
    query = (query or "").strip()
    if not query:
        return {"ok": False, "error": "empty query", "answer": "", "citations": [],
                "retrieval": None, "intent": None, "latency_ms": 0}

    intent = classify(query)
    style = style or db.get_setting("answer_style", "concise")

    # ---- meta questions: answered from data, never generated ----
    if intent.is_meta:
        try:
            meta = _meta_answer(intent.name, query)
        except Exception as exc:
            log.exception("meta answer failed")
            meta = {"answer": f"I couldn't build that view: {exc}", "data": {},
                    "citations": [], "grounded": False, "confidence": "none"}
        latency = int((time.perf_counter() - started) * 1000)
        cid = None
        if save:
            cid = _save_conversation(query, meta["answer"], citations=meta.get("citations", []),
                                     provider="data", grounded=meta.get("grounded", True),
                                     used_web=False, web_results=[], latency_ms=latency,
                                     retrieval_ms=0, mode=intent.name)
        return {
            "ok": True, "answer": meta["answer"], "citations": meta.get("citations", []),
            "data": meta.get("data", {}), "grounded": meta.get("grounded", True),
            "confidence": meta.get("confidence", "high"), "intent": intent.to_dict(),
            "retrieval": None, "web": None, "provider": "data", "latency_ms": latency,
            "conversation_id": cid, "mode": intent.name,
        }

    # ---- retrieval ----
    result = retrieval.retrieve(query, k=top_k, since=since, until=until, domains=domains)

    # If a time window was inferred from the question ("yesterday", "last week")
    # and nothing matched inside it, look again without the window. This is both
    # the honest fallback the spec asks for ("want me to check the last few days
    # instead?") and a budget guard: if we DO have the page, just outside the
    # window, there is no reason to spend a web search.
    near_miss = None
    if not result.grounded and (result.since or result.until):
        try:
            near_miss = retrieval.retrieve(query, k=3, infer_time=False)
        except Exception:
            near_miss = None
    have_answer_elsewhere = bool(near_miss and near_miss.grounded and near_miss.matches)

    # ---- optional budgeted web augmentation ----
    web_res: dict[str, Any] | None = None
    force_web = bool(EXPLICIT_WEB.search(query)) if use_web is None else bool(use_web)
    if use_web is False or (have_answer_elsewhere and not force_web):
        web_res = None
    else:
        web_res = maybe_web_search(query, result, intent, force=force_web)
    web_results = (web_res or {}).get("results") or []

    # ---- answer ----
    llm = get_llm()
    history = recent_turns(4) if use_history else None
    try:
        resp = llm.answer(query, result, web_results=web_results or None,
                          history=history, style=style, near_miss=near_miss)
    except Exception as exc:
        log.exception("LLM answer failed")
        resp = type("R", (), {})()
        resp.text = f"I hit an error while answering: {exc}"
        resp.provider = "error"
        resp.model = ""
        resp.grounded = False
        resp.citations = []
        resp.used_web = bool(web_results)
        resp.web_results = web_results
        resp.latency_ms = 0
        resp.confidence = "none"
        resp.error = str(exc)[:200]
        resp.intent = intent.name

    latency = int((time.perf_counter() - started) * 1000)
    cid = None
    if save:
        cid = _save_conversation(query, resp.text, citations=resp.citations,
                                 provider=resp.provider, grounded=resp.grounded,
                                 used_web=resp.used_web, web_results=resp.web_results,
                                 latency_ms=latency, retrieval_ms=result.took_ms,
                                 mode="memory")

    return {
        "ok": True,
        "answer": resp.text,
        "citations": resp.citations,
        "grounded": resp.grounded,
        "confidence": resp.confidence,
        "provider": resp.provider,
        "model": resp.model,
        "intent": intent.to_dict(),
        "retrieval": result.to_dict(include_context=False),
        "context_block": result.context_block(),
        "web": ({
            "query": web_res.get("query"), "provider": web_res.get("provider"),
            "status": web_res.get("status"), "cached": web_res.get("cached"),
            "took_ms": web_res.get("took_ms"), "results": web_results,
            "budget": web_search.usage_today(),
        } if web_res else None),
        "near_miss": (near_miss.to_dict() if near_miss and near_miss.matches else None),
        "latency_ms": latency,
        "conversation_id": cid,
        "error": getattr(resp, "error", None),
        "mode": "memory",
    }


def answer_stream(query: str, **kwargs: Any) -> Iterator[str]:
    """SSE stream: sources first (instant), then the answer, then metadata.

    This is what makes the UI feel real-time even when the LLM provider is slow —
    retrieval results render immediately.
    """
    def event(name: str, payload: Any) -> str:
        return f"event: {name}\ndata: {json.dumps(payload, default=str)}\n\n"

    try:
        intent = classify(query)
        yield event("intent", intent.to_dict())
        if intent.is_meta:
            full = answer(query, **kwargs)
            yield event("answer", {"text": full["answer"], "grounded": full["grounded"],
                                   "confidence": full["confidence"],
                                   "provider": full["provider"]})
            yield event("citations", full["citations"])
            yield event("done", {"conversation_id": full.get("conversation_id"),
                                 "latency_ms": full["latency_ms"]})
            return

        result = retrieval.retrieve(query)
        yield event("sources", [m.to_dict() for m in result.matches])
        yield event("grounding", {"grounded": result.grounded,
                                  "best_relevance": result.best_relevance,
                                  "took_ms": result.took_ms,
                                  "engine": {"embedder": result.embedder,
                                             "vector": result.vector_backend,
                                             "lexical": result.lexical_backend}})

        near_miss = None
        if not result.grounded and (result.since or result.until):
            near_miss = retrieval.retrieve(query, k=3, infer_time=False)

        web_res = maybe_web_search(query, result, intent) if kwargs.get("use_web") is not False \
            else None
        web_results = (web_res or {}).get("results") or []
        if web_results:
            yield event("web", {"query": web_res.get("query"), "results": web_results})

        llm = get_llm()
        resp = llm.answer(query, result, web_results=web_results or None,
                          history=recent_turns(4), style=kwargs.get("style"),
                          near_miss=near_miss)
        started = time.perf_counter()
        yield event("answer", {"text": resp.text, "grounded": resp.grounded,
                               "confidence": resp.confidence, "provider": resp.provider,
                               "model": resp.model})
        yield event("citations", resp.citations)
        cid = _save_conversation(query, resp.text, citations=resp.citations,
                                 provider=resp.provider, grounded=resp.grounded,
                                 used_web=resp.used_web, web_results=resp.web_results,
                                 latency_ms=int((time.perf_counter() - started) * 1000)
                                 + resp.latency_ms,
                                 retrieval_ms=result.took_ms, mode="memory") \
            if kwargs.get("save", True) else None
        yield event("done", {"conversation_id": cid})
    except Exception as exc:  # pragma: no cover
        log.exception("stream failed")
        yield event("error", {"message": str(exc)[:300]})


# ---------------------------------------------------------------------------
# quick actions used by the popup / dashboard
# ---------------------------------------------------------------------------


def about_this_page(url: str) -> dict[str, Any]:
    """'What do I know about this page?' — used by the context menu."""
    page = retrieval.find_by_url(url)
    if not page:
        return {"ok": False, "known": False,
                "answer": "I have nothing stored for this page yet."}
    detail = retrieval.page_detail(page["id"]) or {}
    related = retrieval.related(page["id"], limit=4)
    lines = [
        f"Yes — \u201c{detail.get('title') or url}\u201d is in your memory.",
        f"First seen {human_time(detail.get('first_visited_at'))}, last visited "
        f"{human_time(detail.get('last_visited_at') or detail.get('visited_at'))}, "
        f"{detail.get('visit_count', 1)} visit(s), "
        f"{format_dwell(detail.get('total_dwell_seconds', 0))} total, "
        f"{detail.get('word_count', 0):,} words captured.",
    ]
    if detail.get("summary"):
        lines.append(f"Summary: {detail['summary']}")
    if related:
        lines.append("Related pages you also read:")
        lines.extend(f"  \u2022 {truncate(r['title'], 70)} — {r['domain_label']}, "
                     f"{r['visited_ago']} {r['url']}" for r in related)
    return {"ok": True, "known": True, "answer": "\n".join(lines), "page": detail,
            "related": related}


def suggest_questions(limit: int = 5) -> list[str]:
    """Real suggestions derived from what is actually in memory."""
    out: list[str] = []
    stats = db.stats()
    if not stats["pages"]:
        return ["What did I read today?", "What are my top interests?",
                "Why is my memory empty?"]
    topics = [t["label"] for t in interests.top_topics(6) if not t["is_concept"]][:3]
    for topic in topics:
        out.append(f"What have I read about {topic}?")
    recent = retrieval.timeline(limit=3)
    if recent:
        title_words = re.findall(r"[A-Za-z0-9]{4,}", recent[0]["title"])[:3]
        if title_words:
            out.append(f"Find that page about {' '.join(title_words[:2]).lower()}")
    out.append("What did I read yesterday?")
    out.append("Give me the links about " + (topics[0] if topics else "my top topic"))
    out.append("What are my top interests?")
    out.append("Summarise my day")
    seen: list[str] = []
    for q in out:
        if q not in seen:
            seen.append(q)
        if len(seen) >= limit:
            break
    return seen


def system_prompt_preview(query: str) -> dict[str, Any]:
    """Show exactly what the LLM would receive — the trust/debug feature."""
    from .llm.prompts import build_messages

    result = retrieval.retrieve(query)
    messages = build_messages(query, result.context_block())
    return {"system": messages[0]["content"], "messages": messages,
            "retrieval": result.to_dict(), "grounded": result.grounded}
