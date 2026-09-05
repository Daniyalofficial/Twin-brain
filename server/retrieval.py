"""The retrieval engine — the piece that makes the twin feel smart.

Pipeline (matches the architecture spec, plus a lexical stage it needed):

  1. embed the query with the *same* model used for pages
  2. vector similarity (sqlite-vec KNN, cosine) -> top N candidates
  3. BM25 lexical search (FTS5) over the same corpus
  4. fuse the two rankers, aggregate chunks -> pages
  5. re-rank:  `relevance * 0.7 + recency_boost * 0.3`
  6. take the top 5-8.  That is the *entire* memory context the LLM ever sees.

Nothing here invents information: every returned match carries the page it came
from, so answers are always falsifiable by clicking through.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from . import db, lexical, vector_store
from .config import get_config
from .embeddings import get_embedder
from .text import (clean_query_for_matching, content_words, human_time,
                   normalize_url, pretty_domain, registrable_domain,
                   time_window_from_query, truncate)

log = logging.getLogger("twinbrain.retrieval")

MAX_ALLOWED_CHUNKS = 60_000   # above this we post-filter instead of pre-filtering
RRF_K = 60


@dataclass
class Match:
    page_id: str
    url: str
    title: str
    domain: str
    visited_at: str | None
    dwell_seconds: int = 0
    visit_count: int = 1
    scroll_depth: float = 0.0
    excerpt: str = ""
    snippets: list[str] = field(default_factory=list)
    sentences: list[str] = field(default_factory=list)   # faithful, query-ranked
    score: float = 0.0
    relevance: float = 0.0
    recency: float = 0.0
    vector_sim: float = 0.0
    vector_sim_raw: float = 0.0
    lexical_score: float = 0.0
    chunk_id: int | None = None
    matched_chunks: int = 1
    summary: str = ""
    word_count: int = 0
    source: str = "extension"          # extension | import | web_enrichment

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_id": self.page_id,
            "url": self.url,
            "title": self.title,
            "domain": self.domain,
            "domain_label": pretty_domain(self.domain),
            "visited_at": self.visited_at,
            "visited_ago": human_time(self.visited_at),
            "dwell_seconds": self.dwell_seconds,
            "visit_count": self.visit_count,
            "scroll_depth": self.scroll_depth,
            "excerpt": self.excerpt,
            "snippets": self.snippets,
            "sentences": self.sentences,
            "summary": self.summary,
            "word_count": self.word_count,
            "scores": {
                "final": round(self.score, 4),
                "relevance": round(self.relevance, 4),
                "recency": round(self.recency, 4),
                "vector_similarity": round(self.vector_sim, 4),
                "vector_similarity_raw": round(self.vector_sim_raw, 4),
                "lexical": round(self.lexical_score, 4),
                "matched_chunks": self.matched_chunks,
            },
            "chunk_id": self.chunk_id,
            "source": self.source,
            "assistant_fetched": self.source == "web_enrichment",
        }


@dataclass
class RetrievalResult:
    query: str
    matches: list[Match]
    grounded: bool
    best_relevance: float = 0.0
    time_label: str | None = None
    since: float | None = None
    until: float | None = None
    domains: list[str] | None = None
    candidates_examined: int = 0
    took_ms: int = 0
    vector_gate: float = 0.0
    evidence: str = "none"
    embedder: str = ""
    vector_backend: str = ""
    lexical_backend: str = ""
    filters_applied: dict[str, Any] = field(default_factory=dict)

    @property
    def best(self) -> Match | None:
        return self.matches[0] if self.matches else None

    def to_dict(self, include_context: bool = False) -> dict[str, Any]:
        out = {
            "query": self.query,
            "grounded": self.grounded,
            "best_relevance": round(self.best_relevance, 4),
            "count": len(self.matches),
            "results": [m.to_dict() for m in self.matches],
            "time_label": self.time_label,
            "filters": {
                "since": self.since,
                "until": self.until,
                "domains": self.domains,
                **self.filters_applied,
            },
            "engine": {
                "took_ms": self.took_ms,
                "embedder": self.embedder,
                "vector_backend": self.vector_backend,
                "lexical_backend": self.lexical_backend,
                "candidates_examined": self.candidates_examined,
                "vector_gate": self.vector_gate,
                "evidence": self.evidence,
            },
        }
        if include_context:
            out["context_block"] = self.context_block()
        return out

    # -- prompt formatting -------------------------------------------------
    def context_block(self, max_chars: int = 3600, per_page_chars: int = 520) -> str:
        """`{retrieved_context}` — a small, cheap, verifiable list of memories."""
        if not self.matches:
            return "(no matching memories were retrieved)"
        blocks: list[str] = []
        used = 0
        for i, m in enumerate(self.matches, start=1):
            when = human_time(m.visited_at) or "unknown date"
            date = (m.visited_at or "")[:10] or "unknown"
            body = m.excerpt or (m.snippets[0] if m.snippets else "")
            body = truncate(body, per_page_chars)
            if m.source == "web_enrichment":
                origin = (f"fetched by your assistant on {date} while researching a topic "
                          f"you read about — YOU DID NOT VISIT THIS PAGE, never describe it "
                          f"as part of the user's browsing history")
            else:
                dwell = f", dwell {int(m.dwell_seconds)}s" if m.dwell_seconds else ""
                visits = f", visited {m.visit_count}x" if m.visit_count > 1 else ""
                origin = f"visited: {when} ({date}){dwell}{visits}"
            block = (
                f"[{i}] {m.title or '(untitled)'}\n"
                f"    site: {pretty_domain(m.domain)} | {origin}\n"
                f"    url: {m.url}\n"
                f"    excerpt: {body}"
            )
            if used + len(block) > max_chars and blocks:
                break
            blocks.append(block)
            used += len(block)
        return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# filters
# ---------------------------------------------------------------------------


def _hidden_domains() -> set[str]:
    """Domains the user hid from the AI (`no_ai`) or blocked entirely (`off`)."""
    rows = db.query("SELECT domain FROM exclusions WHERE mode IN ('no_ai','off') AND domain IS NOT NULL")
    hidden = {r["domain"] for r in rows}
    rows = db.query("SELECT domain FROM domains WHERE ai_visible = 0")
    hidden |= {r["domain"] for r in rows}
    return hidden


def _page_where(since: float | None, until: float | None, domains: Sequence[str] | None,
                hidden: set[str], include_hidden: bool) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if not include_hidden:
        clauses.append("p.ai_visible = 1")
        if hidden:
            marks = ",".join("?" * len(hidden))
            clauses.append(f"(p.domain IS NULL OR (p.domain NOT IN ({marks}) "
                           f"AND COALESCE(p.registrable_domain,'') NOT IN ({marks})))")
            params.extend(sorted(hidden))
            params.extend(sorted(hidden))
    if since:
        clauses.append("COALESCE(p.last_visited_at, p.visited_at) >= ?")
        params.append(_iso(since))
    if until:
        clauses.append("COALESCE(p.last_visited_at, p.visited_at) <= ?")
        params.append(_iso(until))
    if domains:
        norms: list[str] = []
        for d in domains:
            d = (d or "").strip().lower().lstrip(".")
            if d:
                norms.extend({d, registrable_domain(d), f"www.{d}"})
        norms = sorted(set(norms))
        marks = ",".join("?" * len(norms))
        clauses.append(f"(p.domain IN ({marks}) OR p.registrable_domain IN ({marks}))")
        params.extend(norms)
        params.extend(norms)
    return (" AND ".join(clauses) if clauses else "1=1"), params


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch))


def _epoch_from_iso(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return time.mktime(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (ValueError, OverflowError):
        return None


# ---------------------------------------------------------------------------
# main retrieval
# ---------------------------------------------------------------------------


def retrieve(query: str, *, k: int | None = None, candidates: int | None = None,
             since: float | None = None, until: float | None = None,
             domains: Sequence[str] | None = None, include_hidden: bool = False,
             infer_time: bool = True, min_score: float | None = None,
             require_text: bool = True) -> RetrievalResult:
    started = time.perf_counter()
    cfg = get_config()
    k = int(k or db.get_setting("top_k", cfg.top_k))
    candidates = int(candidates or db.get_setting("candidate_k", cfg.candidate_k))
    sim_w = float(db.get_setting("similarity_weight", cfg.similarity_weight))
    rec_w = float(db.get_setting("recency_weight", cfg.recency_weight))
    halflife = float(db.get_setting("recency_halflife_days", 30.0))
    threshold = float(db.get_setting("min_grounding_score", cfg.min_grounding_score)) \
        if min_score is None else float(min_score)

    query = (query or "").strip()
    time_label = None
    if infer_time and since is None and until is None:
        win_since, win_until, time_label = time_window_from_query(query)
        since, until = win_since, win_until

    hidden = set() if include_hidden else _hidden_domains()
    where, params = _page_where(since, until, domains, hidden, include_hidden)
    if require_text:
        where += " AND (p.word_count > 0 OR p.extracted_text IS NOT NULL)"

    embedder = get_embedder()
    vector_store.ensure_ready(embedder.dim)

    # ---- candidate chunk set (pre-filter only when it is small enough) ----
    allowed: set[int] | None = None
    filter_active = bool(since or until or domains or (not include_hidden and hidden))
    if filter_active:
        rows = db.query(
            f"SELECT c.id FROM chunks c JOIN pages p ON p.id = c.page_id "
            f"WHERE {where} LIMIT ?", (*params, MAX_ALLOWED_CHUNKS + 1))
        if len(rows) <= MAX_ALLOWED_CHUNKS:
            allowed = {int(r["id"]) for r in rows}
        if allowed is not None and not allowed:
            return RetrievalResult(
                query=query, matches=[], grounded=False, time_label=time_label,
                since=since, until=until, domains=list(domains or []) or None,
                took_ms=int((time.perf_counter() - started) * 1000),
                embedder=embedder.name, vector_backend=vector_store.backend_name(),
                lexical_backend=lexical.backend(),
                filters_applied={"hidden_domains": len(hidden), "allowed_chunks": 0})

    # ---- 1) vector stage ----
    vec_hits: list[tuple[int, float]] = []
    match_query = clean_query_for_matching(query)
    try:
        qv = embedder.embed_query(match_query or query)
        fetch = max(candidates * 8, 60)
        vec_hits = vector_store.search(qv, k=fetch, allowed_chunk_ids=allowed)
    except Exception as exc:
        log.warning("vector stage failed: %s", exc)

    # ---- 2) lexical (BM25) stage ----
    lex_hits: list[tuple[int, float]] = []
    try:
        raw = lexical.search(match_query or query, k=120)
        if allowed is not None:
            raw = [(cid, s) for cid, s in raw if cid in allowed]
        lex_hits = raw[:max(candidates * 4, 40)]
    except Exception as exc:
        log.warning("lexical stage failed: %s", exc)

    if not vec_hits and not lex_hits:
        return RetrievalResult(
            query=query, matches=[], grounded=False, time_label=time_label, since=since,
            until=until, domains=list(domains or []) or None,
            took_ms=int((time.perf_counter() - started) * 1000),
            embedder=embedder.name, vector_backend=vector_store.backend_name(),
            lexical_backend=lexical.backend(),
            filters_applied={"hidden_domains": len(hidden),
                             "allowed_chunks": (len(allowed) if allowed is not None else None)})

    # ---- 3) fuse (RRF for rank agreement, absolute scores for grounding) ----
    lex_max = max((s for _, s in lex_hits), default=0.0) or 1.0
    # calibrate raw cosines so the grounding threshold means the same thing for
    # every embedder (a 0.15 cosine is a great match for the offline embedder
    # and a poor one for MiniLM)
    reference = float(getattr(embedder, "reference_similarity", 0.5) or 0.5)
    vw, lw, solo_v, solo_l = getattr(embedder, "fusion", (0.70, 0.30, 0.95, 0.85))
    lexical_based = bool(getattr(embedder, "lexical_based", False))
    vec_raw = {cid: max(0.0, float(s)) for cid, s in vec_hits}
    vec_score = {cid: min(1.0, v / reference) for cid, v in vec_raw.items()}
    lex_score = {cid: max(0.0, float(s)) / lex_max for cid, s in lex_hits}
    vec_rank = {cid: i for i, (cid, _) in enumerate(vec_hits)}
    lex_rank = {cid: i for i, (cid, _) in enumerate(lex_hits)}

    fused: dict[int, dict[str, float]] = {}
    for cid in set(vec_score) | set(lex_score):
        rrf = 0.0
        if cid in vec_rank:
            rrf += 1.0 / (RRF_K + vec_rank[cid] + 1)
        if cid in lex_rank:
            rrf += 1.0 / (RRF_K + lex_rank[cid] + 1)
        rrf_norm = min(1.0, rrf / (2.0 / (RRF_K + 1)))
        v, l = vec_score.get(cid, 0.0), lex_score.get(cid, 0.0)
        if v and l:
            blended = vw * v + lw * l
        elif v:
            blended = v * solo_v
        else:
            blended = l * solo_l
        relevance = min(1.0, 0.72 * blended + 0.28 * rrf_norm)
        if lexical_based and l <= 0.0:
            # No word in the question appears on this page. With a lexical
            # embedder that means the vector hit is collision noise, so it can
            # be a lead but never a grounded answer.
            relevance = min(relevance, 0.42)
        fused[cid] = {
            "vector_raw": vec_raw.get(cid, 0.0),
            "vector": v,
            "lexical": l,
            "rrf": rrf_norm,
            "relevance": relevance,
        }

    ranked_chunks = sorted(fused.items(), key=lambda kv: -kv[1]["relevance"])
    top_chunk_ids = [cid for cid, _ in ranked_chunks[:max(candidates * 6, 90)]]
    if not top_chunk_ids:
        return RetrievalResult(query=query, matches=[], grounded=False, time_label=time_label,
                               since=since, until=until, embedder=embedder.name,
                               vector_backend=vector_store.backend_name(),
                               lexical_backend=lexical.backend(),
                               took_ms=int((time.perf_counter() - started) * 1000))

    # ---- 4) hydrate chunks + pages ----
    marks = ",".join("?" * len(top_chunk_ids))
    rows = db.query(
        f"""SELECT c.id AS chunk_id, c.page_id, c.text, c.idx,
                   p.url, p.title, p.domain, p.registrable_domain, p.visited_at,
                   p.last_visited_at, p.dwell_seconds, p.total_dwell_seconds,
                   p.visit_count, p.max_scroll_depth, p.excerpt, p.summary,
                   p.word_count, p.ai_visible, p.source
            FROM chunks c JOIN pages p ON p.id = c.page_id
            WHERE c.id IN ({marks})""",
        top_chunk_ids)

    if not include_hidden:
        rows = [r for r in rows if r["ai_visible"] and
                (r["domain"] or "") not in hidden and
                (r["registrable_domain"] or "") not in hidden]
    if not rows:
        return RetrievalResult(query=query, matches=[], grounded=False, time_label=time_label,
                               since=since, until=until, embedder=embedder.name,
                               vector_backend=vector_store.backend_name(),
                               lexical_backend=lexical.backend(),
                               took_ms=int((time.perf_counter() - started) * 1000))

    # ---- 5) aggregate to page level + re-rank ----
    q_words = set(content_words(match_query or query))
    q_tokens = set(w for w in q_words if len(w) > 2)
    now = time.time()
    by_page: dict[str, dict[str, Any]] = {}

    for row in rows:
        cid = int(row["chunk_id"])
        info = fused.get(cid)
        if not info:
            continue
        pid = row["page_id"]
        visited_iso = row["last_visited_at"] or row["visited_at"]
        visited = _epoch_from_iso(visited_iso) or now
        age_days = max(0.0, (now - visited) / 86400.0)
        recency = math.exp(-math.log(2) * age_days / max(halflife, 0.5))

        title = (row["title"] or "").lower()
        domain = (row["domain"] or "").lower()
        bonus = 0.0
        if q_tokens and title:
            hits = sum(1 for w in q_tokens if w in title)
            if hits:
                bonus += min(0.10, 0.045 * hits)
            # consecutive pair in the title == strong "that page called X" signal
            cleaned_words = (match_query or query).lower().split()
            for a, b in zip(cleaned_words, cleaned_words[1:]):
                if len(a) > 2 and len(b) > 2 and f"{a} {b}" in title:
                    bonus += 0.08
                    break
        for w in q_tokens:
            if w in domain:
                bonus += 0.06
                break

        relevance = min(1.0, info["relevance"] + bonus)
        final = sim_w * relevance + rec_w * recency

        entry = by_page.get(pid)
        text = row["text"] or ""
        snippet = truncate(" ".join(text.split()), 320)
        if entry is None:
            by_page[pid] = {
                "match": Match(
                    page_id=pid, url=row["url"], title=row["title"] or row["url"],
                    domain=row["domain"] or "", visited_at=visited_iso,
                    dwell_seconds=int(row["dwell_seconds"] or 0),
                    visit_count=int(row["visit_count"] or 1),
                    scroll_depth=float(row["max_scroll_depth"] or 0.0),
                    excerpt=snippet, snippets=[snippet],
                    score=final, relevance=relevance, recency=recency,
                    vector_sim=info["vector"], vector_sim_raw=info["vector_raw"],
                    lexical_score=info["lexical"], chunk_id=cid, matched_chunks=1,
                    summary=row["summary"] or "", word_count=int(row["word_count"] or 0),
                    source=row["source"] or "extension"),
                "best": final,
                "best_relevance": relevance,
            }
        else:
            m = entry["match"]
            is_better = final > entry["best"]
            if is_better:
                entry["best"] = final
                entry["best_relevance"] = max(entry["best_relevance"], relevance)
                m.excerpt = snippet
                m.chunk_id = cid
                m.relevance = relevance
                m.recency = recency
            m.matched_chunks += 1
            m.vector_sim = max(m.vector_sim, info["vector"])
            m.vector_sim_raw = max(m.vector_sim_raw, info["vector_raw"])
            m.lexical_score = max(m.lexical_score, info["lexical"])
            m.relevance = max(m.relevance, relevance)
            # small, bounded bonus for corroborating chunks — not an invented
            # "importance score", just evidence that more of the page matched
            m.score = min(1.0, entry["best"] + 0.02 * (m.matched_chunks - 1))
            if snippet not in m.snippets and len(m.snippets) < 3:
                m.snippets.append(snippet)

    matches = [e["match"] for e in by_page.values()]
    matches.sort(key=lambda m: -m.score)
    matches = matches[:k]

    # Prefer whole sentences taken from the page over a mid-chunk slice: chunk
    # boundaries can cut a sentence in half, and quoting a fragment looks like
    # the system is making things up.
    for m in matches[:6]:
        page = db.query_one("SELECT extracted_text FROM pages WHERE id=?", (m.page_id,))
        if page and page["extracted_text"]:
            from .text import best_sentences

            sents = best_sentences(page["extracted_text"], match_query or query,
                                   n=3, max_chars=700)
            if sents:
                m.sentences = sents
                m.excerpt = " ".join(sents[:2])
                if m.excerpt not in m.snippets:
                    m.snippets.insert(0, m.excerpt)

    best_relevance = max((m.relevance for m in matches), default=0.0)

    # Grounding needs EVIDENCE, not just a score above a line. A calibrated
    # relevance of 0.3 can come from nothing but hash-collision noise, which is
    # how a "capital of France" question ends up citing a SQLite page. So:
    # either the lexical stage really matched the words, or the raw cosine is
    # far enough above this embedder's measured noise floor to mean something.
    gate = float(getattr(embedder, "vector_gate", 0.15) or 0.15)
    lexical_hit = any(m.lexical_score > 0 for m in matches[:3])
    vector_hit = any(m.vector_sim_raw >= gate for m in matches[:3])
    has_evidence = lexical_hit or vector_hit
    grounded = bool(matches) and best_relevance >= threshold and has_evidence
    evidence = ("lexical+vector" if (lexical_hit and vector_hit)
                else "lexical" if lexical_hit else "vector" if vector_hit else "none")

    return RetrievalResult(
        query=query, matches=matches, grounded=grounded, best_relevance=best_relevance,
        time_label=time_label, since=since, until=until,
        domains=list(domains) if domains else None,
        candidates_examined=len(fused),
        took_ms=int((time.perf_counter() - started) * 1000),
        embedder=embedder.name, vector_backend=vector_store.backend_name(),
        lexical_backend=lexical.backend(),
        vector_gate=gate, evidence=evidence,
        filters_applied={"hidden_domains": len(hidden),
                         "allowed_chunks": (len(allowed) if allowed is not None else None),
                         "threshold": threshold})


# ---------------------------------------------------------------------------
# helpers used by the UI / digest
# ---------------------------------------------------------------------------


def search_links(query: str, *, limit: int = 25, since: float | None = None,
                 domain: str | None = None) -> list[dict[str, Any]]:
    """Pure memory search — Phase 2 of the build order, no LLM involved."""
    res = retrieve(query, k=limit, since=since,
                   domains=[domain] if domain else None, require_text=False)
    out = [m.to_dict() for m in res.matches]
    if not out:
        # title/url LIKE fallback so a brand-new store still answers
        like = f"%{(query or '').strip()}%"
        rows = db.query(
            """SELECT id, url, title, domain, last_visited_at, visited_at, dwell_seconds,
                      visit_count, excerpt
               FROM pages WHERE ai_visible=1 AND (title LIKE ? OR url LIKE ?)
               ORDER BY COALESCE(last_visited_at, visited_at) DESC LIMIT ?""",
            (like, like, limit))
        for r in rows:
            out.append({
                "page_id": r["id"], "url": r["url"], "title": r["title"] or r["url"],
                "domain": r["domain"] or "", "domain_label": pretty_domain(r["domain"] or ""),
                "visited_at": r["last_visited_at"] or r["visited_at"],
                "visited_ago": human_time(r["last_visited_at"] or r["visited_at"]),
                "dwell_seconds": r["dwell_seconds"] or 0, "visit_count": r["visit_count"] or 1,
                "excerpt": r["excerpt"] or "", "snippets": [],
                "scores": {"final": 0.0, "relevance": 0.0, "recency": 0.0,
                           "vector_similarity": 0.0, "lexical": 0.0, "matched_chunks": 0},
                "match_type": "like",
            })
    return out


def timeline(limit: int = 50, since: float | None = None,
             domain: str | None = None) -> list[dict[str, Any]]:
    clauses = ["ai_visible = 1"]
    params: list[Any] = []
    if since:
        clauses.append("COALESCE(last_visited_at, visited_at) >= ?")
        params.append(_iso(since))
    if domain:
        clauses.append("(domain = ? OR registrable_domain = ?)")
        params.extend([domain, registrable_domain(domain)])
    rows = db.query(
        f"""SELECT id, url, title, domain, COALESCE(last_visited_at, visited_at) AS visited_at,
                   dwell_seconds, total_dwell_seconds, visit_count, max_scroll_depth,
                   excerpt, word_count, source
            FROM pages WHERE {' AND '.join(clauses)}
            ORDER BY visited_at DESC LIMIT ?""", (*params, limit))
    return [{
        "page_id": r["id"], "url": r["url"], "title": r["title"] or r["url"],
        "domain": r["domain"] or "", "domain_label": pretty_domain(r["domain"] or ""),
        "visited_at": r["visited_at"], "visited_ago": human_time(r["visited_at"]),
        "dwell_seconds": r["dwell_seconds"] or 0,
        "total_dwell_seconds": r["total_dwell_seconds"] or 0,
        "visit_count": r["visit_count"] or 1,
        "scroll_depth": r["max_scroll_depth"] or 0.0,
        "excerpt": r["excerpt"] or "", "word_count": r["word_count"] or 0,
        "source": r["source"] or "extension",
        "assistant_fetched": (r["source"] or "") == "web_enrichment",
    } for r in rows]


def related(page_id: str, limit: int = 6) -> list[dict[str, Any]]:
    """Pages similar to a given page — 'more like this' in the dashboard."""
    page = db.query_one("SELECT extracted_text, title, domain FROM pages WHERE id=?", (page_id,))
    if not page:
        return []
    text = truncate((page["title"] or "") + "\n" + (page["extracted_text"] or ""), 2500)
    res = retrieve(text, k=limit + 1, infer_time=False, require_text=True)
    return [m.to_dict() for m in res.matches if m.page_id != page_id][:limit]


def page_detail(page_id: str) -> dict[str, Any] | None:
    row = db.query_one("SELECT * FROM pages WHERE id=?", (page_id,))
    if not row:
        return None
    data = dict(row)
    data.pop("extracted_text", None)
    data.pop("embedding", None)
    data["visited_ago"] = human_time(row["last_visited_at"] or row["visited_at"])
    data["domain_label"] = pretty_domain(row["domain"] or "")
    visits = db.query(
        "SELECT visited_at, dwell_seconds, scroll_depth FROM page_visits "
        "WHERE page_id=? ORDER BY visited_at DESC LIMIT 50", (page_id,))
    data["visits"] = [dict(v) for v in visits]
    chunks = db.query("SELECT id, idx, heading, LENGTH(text) AS chars FROM chunks "
                      "WHERE page_id=? ORDER BY idx LIMIT 200", (page_id,))
    data["chunk_count"] = len(chunks)
    return data


def find_by_url(url: str) -> dict[str, Any] | None:
    row = db.query_one("SELECT id, url, title, domain, ai_visible FROM pages WHERE id=?",
                       (db_url_id(url),))
    return dict(row) if row else None


def db_url_id(url: str) -> str:
    from .text import url_hash

    return url_hash(normalize_url(url))


def domains_with_memory(limit: int = 500) -> list[dict[str, Any]]:
    rows = db.query(
        """SELECT d.domain, d.registrable_domain, d.visit_count, d.page_count,
                  d.total_dwell, d.last_visited_at, d.mode, d.ai_visible, d.category
           FROM domains d ORDER BY d.visit_count DESC, d.last_visited_at DESC LIMIT ?""",
        (limit,))
    return [dict(r) for r in rows]


def chunk_ids_for_pages(page_ids: Iterable[str]) -> list[int]:
    ids = list(page_ids)
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    return [int(r["id"]) for r in db.query(
        f"SELECT id FROM chunks WHERE page_id IN ({marks})", ids)]
