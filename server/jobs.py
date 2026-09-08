"""Background jobs: indexing, retention, maintenance.

Every job is idempotent, logged in `jobs_log`, and safe to trigger manually
from the dashboard (`POST /api/jobs/run/<name>`).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from . import capture, db, digest, enrichment, interests, lexical, vector_store
from .config import get_config
from .embeddings import get_embedder

log = logging.getLogger("twinbrain.jobs")


def _log_job(name: str, fn: Callable[[], dict]) -> dict:
    started = time.perf_counter()
    db.execute("INSERT INTO jobs_log(name, started_at, status) VALUES(?,?,?)",
               (name, db.now_iso(), "running"))
    job_id = int(db.get_conn().execute("SELECT last_insert_rowid()").fetchone()[0])
    try:
        out = fn() or {}
        status = "ok"
    except Exception as exc:
        log.exception("job %s failed", name)
        out = {"error": str(exc)[:400]}
        status = "error"
    took = int((time.perf_counter() - started) * 1000)
    out["took_ms"] = took
    db.execute("UPDATE jobs_log SET finished_at=?, status=?, detail=? WHERE id=?",
               (db.now_iso(), status, str(out)[:2000], job_id))
    db.set_setting(f"job_last_run:{name}", db.now_iso())
    db.set_setting(f"job_last_status:{name}", status)
    return {"job": name, "status": status, **out}


def job_last_run(name: str) -> str | None:
    return db.get_setting(f"job_last_run:{name}")


# ---------------------------------------------------------------------------
# embeddings / index
# ---------------------------------------------------------------------------


def ensure_embedding_model() -> dict[str, Any]:
    """If the embedder changed, re-embed everything so vectors stay comparable."""
    embedder = get_embedder()
    vector_store.ensure_ready(embedder.dim)
    stored_model = db.get_setting("embedding_model")
    stored_dim = db.get_setting("embedding_dim")
    if stored_model == embedder.name and int(stored_dim or 0) == int(embedder.dim):
        return {"ok": True, "action": "none", "model": embedder.name, "dim": embedder.dim}
    log.info("embedding model changed (%s/%s -> %s/%s): re-embedding",
             stored_model, stored_dim, embedder.name, embedder.dim)
    out = reindex_all(reason=f"model {stored_model} -> {embedder.name}")
    db.set_setting("embedding_model", embedder.name)
    db.set_setting("embedding_dim", embedder.dim)
    return {"ok": True, "action": "reindexed", "model": embedder.name,
            "dim": embedder.dim, **out}


def reindex_all(batch_size: int = 64, reason: str = "manual") -> dict[str, Any]:
    """Re-chunk + re-embed every page from its stored text."""
    embedder = get_embedder()
    vector_store.ensure_ready(embedder.dim)
    rows = db.query(
        "SELECT id, title, extracted_text FROM pages "
        "WHERE extracted_text IS NOT NULL AND extracted_text != '' "
        "ORDER BY COALESCE(last_visited_at, visited_at) DESC")
    pages = 0
    chunks = 0
    started = time.perf_counter()
    db.execute("DELETE FROM chunks")
    if db.capabilities().get("sqlite_vec"):
        try:
            db.execute("DELETE FROM vec_chunks")
        except Exception:
            pass
    if lexical.has_fts():
        try:
            lexical.rebuild()
        except Exception:
            pass

    pending: list[tuple[int, str]] = []
    for row in rows:
        out = capture._index_page(row["id"], row["title"] or "", row["extracted_text"],
                                  embed=False)
        pages += 1
        chunks += out["chunks"]
    # embed in batches for speed (matters for neural/API embedders)
    chunk_rows = db.query("SELECT c.id, c.text, p.title FROM chunks c "
                          "JOIN pages p ON p.id = c.page_id ORDER BY c.id")
    conn = db.get_conn()
    for i in range(0, len(chunk_rows), batch_size):
        batch = chunk_rows[i:i + batch_size]
        try:
            vectors = embedder.embed_texts(
                [f"{r['title'] or ''}\n{r['text']}".strip()[:8000] for r in batch])
        except Exception as exc:
            log.warning("batch embed failed at %d: %s", i, exc)
            continue
        conn.execute("BEGIN")
        for row, vec in zip(batch, vectors):
            conn.execute("UPDATE chunks SET embedding=? WHERE id=?",
                         (vector_store.pack(vec), row["id"]))
        conn.execute("COMMIT")
        vector_store.upsert_many([(row["id"], vec) for row, vec in zip(batch, vectors)])

    db.set_setting("embedding_model", embedder.name)
    db.set_setting("embedding_dim", embedder.dim)
    db.set_setting("last_reindex_at", db.now_iso())
    db.set_setting("last_reindex_reason", reason)
    return {"ok": True, "pages": pages, "chunks": chunks,
            "embedder": embedder.name, "dim": embedder.dim,
            "took_ms": int((time.perf_counter() - started) * 1000)}


def embed_pending(limit: int = 500) -> dict[str, Any]:
    """Fill in vectors for chunks that do not have one yet."""
    rows = db.query("SELECT c.id, c.text, p.title FROM chunks c "
                    "JOIN pages p ON p.id = c.page_id "
                    "WHERE c.embedding IS NULL ORDER BY c.id LIMIT ?", (limit,))
    if not rows:
        return {"ok": True, "embedded": 0}
    embedder = get_embedder()
    vector_store.ensure_ready(embedder.dim)
    vectors = embedder.embed_texts(
        [f"{r['title'] or ''}\n{r['text']}".strip()[:8000] for r in rows])
    conn = db.get_conn()
    conn.execute("BEGIN")
    for row, vec in zip(rows, vectors):
        conn.execute("UPDATE chunks SET embedding=? WHERE id=?",
                     (vector_store.pack(vec), row["id"]))
    conn.execute("COMMIT")
    vector_store.upsert_many([(row["id"], vec) for row, vec in zip(rows, vectors)])
    return {"ok": True, "embedded": len(rows)}


def rebuild_lexical() -> dict[str, Any]:
    n = lexical.rebuild()
    return {"ok": True, "indexed": n, "backend": lexical.backend()}


# ---------------------------------------------------------------------------
# maintenance
# ---------------------------------------------------------------------------


def purge_retention() -> dict[str, Any]:
    return capture.purge_retention()


def prune_cache() -> dict[str, Any]:
    from . import web_search

    return {"ok": True, "removed": web_search.prune_cache()}


def vacuum() -> dict[str, Any]:
    before = get_config().db_path.stat().st_size
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.execute("VACUUM")
    after = get_config().db_path.stat().st_size
    return {"ok": True, "before_bytes": before, "after_bytes": after,
            "saved_bytes": max(0, before - after)}


def recompute_interests() -> dict[str, Any]:
    return interests.recompute()


def build_digest(notify: bool = True) -> dict[str, Any]:
    if not bool(db.get_setting("digest_enabled", True)):
        return {"ok": True, "skipped": "digest disabled"}
    out = digest.build_digest(db.today_str(), notify=notify)
    return {"ok": True, **out}


def run_enrichment() -> dict[str, Any]:
    if not bool(db.get_setting("enrichment_enabled", True)):
        return {"ok": True, "skipped": "enrichment disabled"}
    return {"ok": True, **enrichment.run_daily()}


def daily_maintenance() -> dict[str, Any]:
    """The once-a-day sweep: digest -> enrichment -> interests -> retention."""
    out: dict[str, Any] = {}
    out["interests"] = _log_job("interests", recompute_interests)
    out["digest"] = _log_job("digest", lambda: build_digest(notify=True))
    out["enrichment"] = _log_job("enrichment", run_enrichment)
    out["retention"] = _log_job("retention", purge_retention)
    out["prune_cache"] = _log_job("prune_cache", prune_cache)
    return out


REGISTRY: dict[str, Callable[[], dict]] = {
    "ensure_embedding_model": ensure_embedding_model,
    "reindex_all": reindex_all,
    "embed_pending": embed_pending,
    "rebuild_lexical": rebuild_lexical,
    "interests": recompute_interests,
    "digest": lambda: build_digest(notify=True),
    "enrichment": run_enrichment,
    "retention": purge_retention,
    "prune_cache": prune_cache,
    "vacuum": vacuum,
    "daily_maintenance": daily_maintenance,
}


def run(name: str) -> dict[str, Any]:
    fn = REGISTRY.get(name)
    if fn is None:
        return {"ok": False, "error": f"unknown job '{name}'",
                "available": sorted(REGISTRY)}
    return _log_job(name, fn)


def recent_runs(limit: int = 30) -> list[dict[str, Any]]:
    rows = db.query("SELECT * FROM jobs_log ORDER BY id DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


def status() -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in REGISTRY:
        out[name] = {"last_run": job_last_run(name),
                     "last_status": db.get_setting(f"job_last_status:{name}")}
    return out
