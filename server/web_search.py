"""Backend web search — how the twin grows knowledge beyond what you read.

Providers (auto-detected, in this order):
    brave / tavily / serper  -> if you have a key (best structured results)
    duckduckgo               -> no key needed, scrapes the HTML endpoint
    none                     -> disabled

Guard-rails, because this is the only part of the system that leaves your machine:
    * a hard daily budget (default 40 searches) stored in `web_usage`
    * result cache with TTL, so repeated questions cost nothing
    * every query is derived from *your* history/interests or your explicit ask
    * results are stored and labelled as `web`, never mixed into "your memory"
"""

from __future__ import annotations

import hashlib
import html as html_lib
import json
import logging
import re
import time
import urllib.parse
from typing import Any

from . import db
from .config import get_config
from .http_client import HttpError, get_json, get_text, post_json
from .text import domain_of, excerpt, pretty_domain, truncate

log = logging.getLogger("twinbrain.websearch")

CACHE_TTL_ANSWER = 6 * 3600        # 6 h for live question augmentation
CACHE_TTL_ENRICH = 3 * 24 * 3600   # 3 d for background enrichment
_TIMEOUT = 10.0

_TAG_RE = re.compile(r"<[^>]+>")
_DDG_RESULT = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
    r'(?:<a[^>]+class="result__snippet"[^>]*>(.*?)</a>)?',
    re.IGNORECASE | re.DOTALL)
_DDG_LITE_RESULT = re.compile(
    r"<a[^>]+href=\"(http[^\"]+)\"[^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)
_REDIRECT = re.compile(r"uddg=([^&]+)")


class SearchResult(dict):
    """A dict with attribute access, for convenience in templates."""

    def __getattr__(self, item):  # pragma: no cover
        return self.get(item)


def _result(title: str, url: str, snippet: str, provider: str,
            published: str = "") -> SearchResult:
    domain = domain_of(url)
    return SearchResult({
        "title": html_lib.unescape(_TAG_RE.sub("", title or "")).strip()[:240],
        "url": url,
        "snippet": html_lib.unescape(_TAG_RE.sub(" ", snippet or "")).strip()[:600],
        "source": pretty_domain(domain),
        "domain": domain,
        "provider": provider,
        "published": published,
        "fetched_at": db.now_iso(),
    })


# ---------------------------------------------------------------------------
# availability & budget
# ---------------------------------------------------------------------------


def resolve_provider(pref: str | None = None) -> str:
    cfg = get_config()
    pref = (pref or db.get_setting("web_search_provider") or cfg.websearch or "auto").lower()
    if pref and pref not in ("auto",):
        return pref
    if cfg.brave_key:
        return "brave"
    if cfg.tavily_key:
        return "tavily"
    if cfg.serper_key:
        return "serper"
    return "duckduckgo"


def is_configured() -> bool:
    return resolve_provider() not in ("none", "off", "disabled")


def enabled() -> bool:
    return bool(db.get_setting("web_search_enabled", True)) and is_configured()


def usage_today() -> dict[str, Any]:
    day = db.today_str()
    row = db.query_one("SELECT count FROM web_usage WHERE day=?", (day,))
    used = int(row["count"]) if row else 0
    budget = int(db.get_setting("web_search_daily_budget",
                                get_config().websearch_daily_budget))
    return {"day": day, "used": used, "budget": budget, "remaining": max(0, budget - used)}


def _consume(day: str | None = None, n: int = 1) -> None:
    day = day or db.today_str()
    db.execute("INSERT INTO web_usage(day, count) VALUES(?, ?) "
               "ON CONFLICT(day) DO UPDATE SET count = count + ?", (day, n, n))


# ---------------------------------------------------------------------------
# cache
# ---------------------------------------------------------------------------


def _cache_key(query: str, provider: str, kind: str) -> str:
    return hashlib.sha1(f"{provider}|{kind}|{query.strip().lower()}".encode()).hexdigest()


def _cache_get(key: str) -> list[dict] | None:
    row = db.query_one("SELECT results, expires_at FROM web_cache WHERE key=?", (key,))
    if not row:
        return None
    if row["expires_at"] and row["expires_at"] < db.now_iso():
        db.execute("DELETE FROM web_cache WHERE key=?", (key,))
        return None
    try:
        data = json.loads(row["results"])
        return data if isinstance(data, list) else None
    except (TypeError, ValueError):
        return None


def _cache_put(key: str, query: str, provider: str, results: list[dict], ttl: int) -> None:
    now = time.time()
    db.execute(
        "INSERT INTO web_cache(key, query, provider, results, created_at, expires_at) "
        "VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET results=excluded.results, "
        "created_at=excluded.created_at, expires_at=excluded.expires_at",
        (key, query, provider, json.dumps(results), db.now_iso(now), db.now_iso(now + ttl)))


def prune_cache(max_age_days: int = 14) -> int:
    cutoff = db.now_iso(time.time() - max_age_days * 86400)
    cur = db.execute("DELETE FROM web_cache WHERE created_at < ?", (cutoff,))
    return cur.rowcount or 0


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------


def _duckduckgo(query: str, limit: int) -> list[SearchResult]:
    out: list[SearchResult] = []
    # 1) the HTML endpoint (richer snippets)
    try:
        html = get_text("https://html.duckduckgo.com/html/",
                        headers={"Accept": "text/html,application/xhtml+xml",
                                 "Referer": "https://duckduckgo.com/"},
                        params={"q": query, "kl": "us-en", "df": ""},
                        timeout=_TIMEOUT)
        for href, title, snippet in _DDG_RESULT.findall(html)[:limit * 2]:
            url = html_lib.unescape(href)
            m = _REDIRECT.search(url)
            if m:
                url = urllib.parse.unquote(m.group(1))
            if not url.startswith("http"):
                continue
            out.append(_result(title, url, snippet or "", "duckduckgo"))
            if len(out) >= limit:
                return out
    except HttpError as exc:
        log.debug("ddg html endpoint failed: %s", exc)
    if out:
        return out
    # 2) the lite endpoint (plain table HTML, very robust)
    try:
        html = get_text("https://lite.duckduckgo.com/lite/",
                        params={"q": query}, timeout=_TIMEOUT)
        for href, title in _DDG_LITE_RESULT.findall(html):
            url = html_lib.unescape(href)
            m = _REDIRECT.search(url)
            if m:
                url = urllib.parse.unquote(m.group(1))
            if not url.startswith("http") or "duckduckgo.com" in url:
                continue
            clean_title = html_lib.unescape(_TAG_RE.sub("", title)).strip()
            if not clean_title:
                continue
            out.append(_result(clean_title, url, "", "duckduckgo-lite"))
            if len(out) >= limit:
                break
    except HttpError as exc:
        log.debug("ddg lite endpoint failed: %s", exc)
    return out


def _brave(query: str, limit: int) -> list[SearchResult]:
    cfg = get_config()
    data = get_json("https://api.search.brave.com/res/v1/web/search",
                    headers={"X-Subscription-Token": cfg.brave_key,
                             "Accept": "application/json"},
                    params={"q": query, "count": min(limit, 20)},
                    timeout=_TIMEOUT)
    out: list[SearchResult] = []
    for item in (data.get("web", {}) or {}).get("results", [])[:limit]:
        out.append(_result(item.get("title", ""), item.get("url", ""),
                           item.get("description", ""), "brave",
                           item.get("age") or item.get("page_age") or ""))
    return out


def _tavily(query: str, limit: int) -> list[SearchResult]:
    cfg = get_config()
    data = post_json("https://api.tavily.com/search",
                     {"api_key": cfg.tavily_key, "query": query,
                      "max_results": min(limit, 10), "search_depth": "basic",
                      "include_answer": False},
                     timeout=_TIMEOUT + 5)
    out: list[SearchResult] = []
    for item in data.get("results", [])[:limit]:
        out.append(_result(item.get("title", ""), item.get("url", ""),
                           item.get("content", ""), "tavily",
                           item.get("published_date", "") or ""))
    return out


def _serper(query: str, limit: int) -> list[SearchResult]:
    cfg = get_config()
    data = post_json("https://google.serper.dev/search",
                     {"q": query, "num": min(limit, 20), "gl": "us", "hl": "en"},
                     headers={"X-API-KEY": cfg.serper_key}, timeout=_TIMEOUT)
    out: list[SearchResult] = []
    for item in data.get("organic", [])[:limit]:
        out.append(_result(item.get("title", ""), item.get("link", ""),
                           item.get("snippet", ""), "serper", item.get("date", "") or ""))
    return out


PROVIDERS = {"duckduckgo": _duckduckgo, "brave": _brave, "tavily": _tavily,
             "serper": _serper, "duckduckgo-lite": _duckduckgo}


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def search(query: str, *, limit: int = 6, kind: str = "answer",
           provider: str | None = None, use_cache: bool = True,
           spend_budget: bool = True) -> dict[str, Any]:
    """Run a web search. Returns {query, provider, results, cached, status, error}."""
    query = (query or "").strip()
    empty = {"query": query, "provider": provider, "results": [], "cached": False,
             "status": "skipped", "error": None, "took_ms": 0}
    if not query:
        return {**empty, "status": "empty", "error": "empty query"}
    if not enabled():
        return {**empty, "error": "web search disabled in settings"}

    provider = resolve_provider(provider)
    if provider in ("none", "off", "disabled"):
        return {**empty, "provider": provider, "error": "no provider configured"}

    key = _cache_key(query, provider, kind)
    if use_cache:
        cached = _cache_get(key)
        if cached is not None:
            return {"query": query, "provider": provider, "results": cached, "cached": True,
                    "status": "ok" if cached else "empty", "error": None, "took_ms": 0}

    budget = usage_today()
    if spend_budget and budget["remaining"] <= 0:
        return {**empty, "provider": provider, "status": "budget",
                "error": f"daily web-search budget exhausted ({budget['used']}/{budget['budget']})"}

    started = time.perf_counter()
    fn = PROVIDERS.get(provider, _duckduckgo)
    results: list[SearchResult] = []
    error: str | None = None
    try:
        results = fn(query, limit)[:limit]
    except HttpError as exc:
        error = str(exc)[:300]
        log.info("web search failed (%s): %s", provider, error)
        if provider != "duckduckgo":
            try:  # graceful degradation to the keyless provider
                results = _duckduckgo(query, limit)[:limit]
                provider = "duckduckgo"
                error = None
            except HttpError as exc2:
                error = f"{error} | fallback: {str(exc2)[:160]}"
    except Exception as exc:  # pragma: no cover
        error = f"unexpected: {str(exc)[:200]}"

    took = int((time.perf_counter() - started) * 1000)
    payload = [dict(r) for r in results]
    if payload:
        _cache_put(key, query, provider, payload,
                   CACHE_TTL_ENRICH if kind == "enrichment" else CACHE_TTL_ANSWER)
    if spend_budget:
        _consume(n=1)

    status = "ok" if payload else ("error" if error else "empty")
    return {"query": query, "provider": provider, "results": payload, "cached": False,
            "status": status, "error": error, "took_ms": took}


def search_and_ingest(query: str, *, limit: int = 5, kind: str = "answer") -> dict[str, Any]:
    """Search, and record the run so the user can audit every outbound query."""
    res = search(query, limit=limit, kind=kind)
    db.execute(
        "INSERT INTO enrichment_runs(id, day, kind, query, provider, status, results, "
        "latency_ms, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (f"run_{int(time.time()*1000)}", db.today_str(), kind, query, res["provider"],
         res["status"], json.dumps(res["results"])[:200_000], res["took_ms"], db.now_iso()))
    return res


def build_query(topic: str, extra: str = "", max_words: int = 12) -> str:
    """Compose a tight, specific search query from a topic + optional context."""
    words = re.findall(r"[A-Za-z0-9+#._-]+", f"{topic} {extra}".strip())
    stop = {"the", "and", "for", "with", "about", "how", "what", "why", "from", "that",
            "this", "are", "was", "were", "have", "has", "you", "your", "my", "me"}
    kept = [w for w in words if w.lower() not in stop][:max_words]
    return " ".join(kept).strip() or (topic or "").strip()


def format_for_prompt(results: list[dict], limit: int = 5, per_item: int = 260) -> str:
    if not results:
        return ""
    lines = []
    for i, r in enumerate(results[:limit], start=1):
        lines.append(f"[W{i}] {truncate(r.get('title','(untitled)'), 110)}\n"
                     f"     source: {pretty_domain(r.get('domain') or domain_of(r.get('url','')))}"
                     f" | {r.get('url','')}\n"
                     f"     snippet: {truncate(excerpt(r.get('snippet',''), per_item), per_item)}")
    return "\n".join(lines)


def recent_searches(limit: int = 50) -> list[dict]:
    rows = db.query(
        "SELECT day, kind, query, provider, status, latency_ms, created_at "
        "FROM enrichment_runs ORDER BY created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]
