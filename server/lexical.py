"""Lexical (BM25) retrieval.

FTS5 finds the candidates; the scoring is done here with a Lucene-style IDF
(`log(1 + ...)`) instead of FTS5's own `bm25()`. Two reasons:

* FTS5's IDF is `log((N - df + 0.5) / (df + 0.5))`, which goes to ~0 (and even
  negative) on a small personal corpus, so it cannot distinguish "matched" from
  "did not match" until you have thousands of documents. The `log(1 + x)` form
  stays positive and behaves sensibly from document #1.
* `bm25()` can return NULL for contentless tables, which used to take the whole
  lexical stage down.

Candidate lookup still uses the porter-stemmed FTS5 index, so recall is good and
we only re-score a couple of hundred rows in Python.
"""

from __future__ import annotations

import logging
import math
import re
import threading

from . import db
from .text import MATCH_STOPWORDS, STOPWORDS, tokenize

log = logging.getLogger("twinbrain.lexical")

_lock = threading.RLock()
_mem_index: dict[str, list[tuple[int, int]]] | None = None
_mem_version = -1
_write_version = 0
_df_cache: dict[str, tuple[int, int]] = {}     # term -> (df, version)
_size_cache: tuple[int, int] = (-1, 0)         # (n_docs, version)
_len_cache: dict[int, int] = {}

K1 = 1.4
B = 0.72
CANDIDATE_LIMIT = 220
_MEM_MAX_DOCS = 200_000


def has_fts() -> bool:
    return bool(db.capabilities().get("fts5"))


def bump_version() -> None:
    """Invalidate caches after any chunk write."""
    global _write_version
    with _lock:
        _write_version += 1


def backend() -> str:
    return "fts5+bm25" if has_fts() else "memory-inverted-index"


# ---------------------------------------------------------------------------
# query sanitising
# ---------------------------------------------------------------------------


def query_terms(query: str, max_terms: int = 16) -> list[str]:
    """Clean, deduplicated search terms (stopwords removed)."""
    tokens = [t for t in tokenize(query or "") if t not in MATCH_STOPWORDS and len(t) > 2]
    if not tokens:
        # everything in the question was framing words -> fall back to the raw
        # tokens rather than matching nothing at all
        tokens = [t for t in tokenize(query or "") if t not in STOPWORDS and len(t) > 2]
    if not tokens:
        tokens = [t.lower() for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9+#._-]*", query or "")
                  if len(t) > 1]
    out: list[str] = []
    for tok in tokens:
        tok = re.sub(r"[^a-z0-9'+#]", "", tok.lower())
        if tok and tok not in out:
            out.append(tok)
        if len(out) >= max_terms:
            break
    return out


def fts_match_expr(query: str, mode: str = "or", max_terms: int = 16) -> str:
    """A safe FTS5 MATCH expression. Every term is quoted, so FTS5 operators
    (AND/OR/NOT/NEAR/^/*) can never be injected by a query string."""
    terms = query_terms(query, max_terms)
    if not terms:
        return ""
    joiner = " AND " if mode == "and" else " OR "
    return joiner.join(f'"{t}"' for t in terms)


# ---------------------------------------------------------------------------
# corpus statistics
# ---------------------------------------------------------------------------


def _corpus_size() -> int:
    global _size_cache
    with _lock:
        n, version = _size_cache
        if version == _write_version and n >= 0:
            return n
    row = db.query_one("SELECT COUNT(*) AS c FROM chunks")
    n = int(row["c"] or 0) if row else 0
    with _lock:
        _size_cache = (n, _write_version)
    return n


def _doc_freq(term: str) -> int:
    with _lock:
        hit = _df_cache.get(term)
        if hit and hit[1] == _write_version:
            return hit[0]
    df = 0
    if has_fts():
        try:
            row = db.query_one('SELECT COUNT(*) AS c FROM chunk_fts WHERE chunk_fts MATCH ?',
                               (f'"{term}"',))
            df = int(row["c"] or 0) if row else 0
        except Exception:
            df = 0
    else:
        df = len(_build_memory_index().get(term, []))
    with _lock:
        if len(_df_cache) > 8000:
            _df_cache.clear()
        _df_cache[term] = (df, _write_version)
    return df


def _idf(term: str, n_docs: int) -> float:
    df = _doc_freq(term)
    return math.log(1.0 + (n_docs - df + 0.5) / (df + 0.5))


def _avg_len() -> float:
    row = db.query_one("SELECT AVG(token_count) AS a FROM chunks WHERE token_count > 0")
    value = float(row["a"]) if row and row["a"] else 0.0
    return value if value > 20 else 180.0


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------


TITLE_BOOST = 2.4      # a title hit is worth more than a body hit


def _tf_map(text: str) -> dict[str, int]:
    tf: dict[str, int] = {}
    for tok in tokenize(text or ""):
        if tok in STOPWORDS or len(tok) < 2:
            continue
        tf[tok] = tf.get(tok, 0) + 1
    return tf


def _stem_freq(tf: dict[str, int], term: str) -> int:
    """Porter-ish tolerance: FTS matched a stem we may not see verbatim."""
    freq = tf.get(term, 0)
    if freq == 0 and len(term) > 3:
        head = term[:4]
        for key, value in tf.items():
            if key.startswith(head) or term.startswith(key[:4]):
                freq = max(freq, int(value * 0.6))
    return freq


def score_text(text: str, terms: list[str], idf: dict[str, float], avgdl: float,
               token_count: int | None = None, title: str = "") -> dict[str, float]:
    """BM25 (Lucene-style IDF) + title boost + a term-coverage multiplier."""
    if not terms:
        return {"score": 0.0, "matched": 0, "coverage": 0.0}
    if not text and not title:
        return {"score": 0.0, "matched": 0, "coverage": 0.0}
    tf = _tf_map(text)
    title_tf = _tf_map(title)
    dl = float(token_count if token_count else sum(tf.values())) or 1.0

    total = 0.0
    matched = 0
    for term in terms:
        freq = _stem_freq(tf, term)
        title_freq = _stem_freq(title_tf, term)
        if freq <= 0 and title_freq <= 0:
            continue
        matched += 1
        term_idf = idf.get(term, 1.0)
        if freq > 0:
            denom = freq + K1 * (1 - B + B * dl / max(avgdl, 1.0))
            total += term_idf * (freq * (K1 + 1)) / max(denom, 1e-9)
        if title_freq > 0:
            total += term_idf * TITLE_BOOST * min(title_freq, 3) * 0.5
    coverage = matched / len(terms)
    total *= 0.5 + 0.5 * coverage          # reward matching more of the question
    return {"score": total, "matched": matched, "coverage": coverage}


# ---------------------------------------------------------------------------
# indexing
# ---------------------------------------------------------------------------


def index_chunks(rows: list[tuple[int, str, str]]) -> None:
    """rows = [(chunk_id, title, text)]"""
    if not rows:
        return
    if has_fts():
        conn = db.get_conn()
        try:
            conn.execute("BEGIN")
            for chunk_id, title, text in rows:
                # contentless FTS5 needs the previous column values to delete a row
                conn.execute("INSERT INTO chunk_fts(chunk_fts, rowid, title, text) "
                             "VALUES('delete', ?, ?, ?)",
                             (int(chunk_id), title or "", text or ""))
            conn.execute("COMMIT")
        except Exception as exc:
            log.debug("fts delete-before-insert skipped: %s", exc)
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
        conn.execute("BEGIN")
        for chunk_id, title, text in rows:
            conn.execute("INSERT INTO chunk_fts(rowid, title, text) VALUES(?, ?, ?)",
                         (int(chunk_id), title or "", text or ""))
        conn.execute("COMMIT")
    global _len_cache
    _len_cache = {}
    bump_version()


def delete_chunks(chunk_ids: list[int], texts: dict[int, tuple[str, str]] | None = None) -> None:
    """texts = {chunk_id: (title, text)} — contentless FTS5 needs the exact values."""
    if not chunk_ids:
        return
    if has_fts():
        conn = db.get_conn()
        conn.execute("BEGIN")
        for cid in chunk_ids:
            pair = (texts or {}).get(int(cid))
            if pair is None:
                row = db.query_one(
                    "SELECT c.text, COALESCE(p.title,'') AS title FROM chunks c "
                    "LEFT JOIN pages p ON p.id = c.page_id WHERE c.id=?", (cid,))
                pair = ((row["title"] if row else ""), (row["text"] if row else ""))
            title, text = pair
            try:
                conn.execute("INSERT INTO chunk_fts(chunk_fts, rowid, title, text) "
                             "VALUES('delete', ?, ?, ?)", (int(cid), title or "", text or ""))
            except Exception as exc:
                log.debug("fts delete failed for %s: %s", cid, exc)
        conn.execute("COMMIT")
    global _len_cache
    _len_cache = {}
    bump_version()


def rebuild() -> int:
    """Rebuild the FTS index from `chunks` (after restoring a DB copy)."""
    conn = db.get_conn()
    if has_fts():
        conn.execute("DROP TABLE IF EXISTS chunk_fts")
        conn.executescript(db.FTS_SQL)
        rows = conn.execute(
            "SELECT c.id, c.text, COALESCE(p.title,'') AS title FROM chunks c "
            "LEFT JOIN pages p ON p.id = c.page_id").fetchall()
        conn.execute("BEGIN")
        for row in rows:
            conn.execute("INSERT INTO chunk_fts(rowid, title, text) VALUES(?, ?, ?)",
                         (row["id"], row["title"] or "", row["text"] or ""))
        conn.execute("COMMIT")
        n = len(rows)
    else:
        n = int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
    global _len_cache, _mem_index
    _len_cache = {}
    _mem_index = None
    bump_version()
    return n


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def search(query: str, k: int = 60) -> list[tuple[int, float]]:
    """[(chunk_id, score)] best-first, score > 0. Never raises."""
    terms = query_terms(query)
    if not terms:
        return []
    n_docs = _corpus_size()
    if n_docs == 0:
        return []
    avgdl = _avg_len()
    idf = {t: _idf(t, n_docs) for t in terms}

    candidates = _candidates(query, terms)
    if not candidates:
        return []

    marks = ",".join("?" * len(candidates))
    rows = db.query(
        f"""SELECT c.id, c.text, c.token_count, COALESCE(p.title,'') AS title,
                   COALESCE(p.domain,'') AS domain
            FROM chunks c LEFT JOIN pages p ON p.id = c.page_id
            WHERE c.id IN ({marks})""", candidates)
    scored: list[tuple[int, float]] = []
    for row in rows:
        # the domain counts as a weak title signal: "that github page about X"
        info = score_text(row["text"] or "", terms, idf, avgdl,
                          token_count=row["token_count"],
                          title=f"{row['title'] or ''} {row['domain'] or ''}".strip())
        if info["score"] > 0:
            scored.append((int(row["id"]), info["score"]))
    scored.sort(key=lambda t: -t[1])
    return scored[:k]


def _candidates(query: str, terms: list[str]) -> list[int]:
    if has_fts():
        expr = fts_match_expr(query)
        if not expr:
            return []
        conn = db.get_conn()
        try:
            rows = conn.execute(
                "SELECT rowid AS id FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT ?",
                (expr, CANDIDATE_LIMIT)).fetchall()
            ids = [int(r["id"]) for r in rows]
            if ids:
                return ids
        except Exception as exc:
            log.debug("fts candidate query failed: %s", exc)
        # last resort: AND -> OR degradation is already OR, so fall through to scan
    return _memory_candidates(terms)


def _build_memory_index() -> dict[str, list[tuple[int, int]]]:
    global _mem_index, _mem_version
    with _lock:
        if _mem_index is not None and _mem_version == _write_version:
            return _mem_index
    index: dict[str, list[tuple[int, int]]] = {}
    for row in db.query("SELECT id, text FROM chunks LIMIT ?", (_MEM_MAX_DOCS,)):
        counts: dict[str, int] = {}
        for tok in tokenize(row["text"] or ""):
            if tok in STOPWORDS or len(tok) < 2:
                continue
            counts[tok] = counts.get(tok, 0) + 1
        cid = int(row["id"])
        for tok, c in counts.items():
            index.setdefault(tok, []).append((cid, c))
    with _lock:
        _mem_index = index
        _mem_version = _write_version
    return index


def _memory_candidates(terms: list[str]) -> list[int]:
    index = _build_memory_index()
    counts: dict[int, int] = {}
    for term in terms:
        for cid, _ in index.get(term, []):
            counts[cid] = counts.get(cid, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [cid for cid, _ in ranked[:CANDIDATE_LIMIT]]


def stats() -> dict:
    return {"backend": backend(), "corpus": _corpus_size(),
            "cached_terms": len(_df_cache), "fts5": has_fts()}
