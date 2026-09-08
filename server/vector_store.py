"""Vector index over `chunks.embedding`.

Two interchangeable backends:

* **sqlite-vec** (`vec0` virtual table) — real KNN index, used when the
  extension loads.  This is the spec's "sqlite-vec alongside Flask" design and
  avoids standing up a separate vector DB service.
* **exact scan** — reads the float32 BLOBs from SQLite and ranks them with
  numpy (or pure Python).  Same answers, no extension needed.

`chunks.embedding` is always the source of truth, so the KNN index can be
rebuilt from scratch at any time (`jobs.reindex_all`).
"""

from __future__ import annotations

import logging
import math
import struct
import threading

from . import db
from .config import get_config

log = logging.getLogger("twinbrain.vector")

_lock = threading.RLock()
_state: dict[str, object] = {"backend": None, "dim": None}

try:  # pragma: no cover
    import numpy as np  # type: ignore

    HAVE_NUMPY = True
except Exception:  # pragma: no cover
    np = None  # type: ignore
    HAVE_NUMPY = False

try:  # pragma: no cover
    import sqlite_vec  # type: ignore

    HAVE_SQLITE_VEC_PKG = True
except Exception:  # pragma: no cover
    sqlite_vec = None  # type: ignore
    HAVE_SQLITE_VEC_PKG = False


# ---------------------------------------------------------------------------
# serialisation
# ---------------------------------------------------------------------------


def pack(vector) -> bytes:
    """float list -> little-endian float32 blob."""
    return struct.pack(f"<{len(vector)}f", *[float(v) for v in vector])


def unpack(blob: bytes) -> list[float]:
    if not blob:
        return []
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob[:n * 4]))


def serialize(vector) -> bytes:
    if HAVE_SQLITE_VEC_PKG:
        try:
            return sqlite_vec.serialize_float32([float(v) for v in vector])
        except Exception:
            pass
    return pack(vector)


def normalize(vector) -> list[float]:
    norm = math.sqrt(sum(float(v) * float(v) for v in vector))
    if norm <= 1e-12:
        return [0.0] * len(vector)
    return [float(v) / norm for v in vector]


# ---------------------------------------------------------------------------
# backend detection
# ---------------------------------------------------------------------------


def has_sqlite_vec() -> bool:
    return bool(db.capabilities().get("sqlite_vec"))


def backend_name() -> str:
    ensure_ready()
    return str(_state.get("backend") or ("sqlite-vec" if has_sqlite_vec() else "exact-scan"))


def ensure_ready(dim: int | None = None) -> None:
    """Create/verify the KNN table for the given dimension."""
    with _lock:
        if dim is None:
            from .embeddings import get_embedder

            dim = get_embedder().dim
        current = _state.get("dim")
        if current == dim and _state.get("backend"):
            return
        conn = db.get_conn()
        if has_sqlite_vec():
            existing = conn.execute(
                "SELECT sql FROM sqlite_master WHERE name='vec_chunks'").fetchone()
            need_create = True
            if existing and existing["sql"] and f"float[{dim}]" in existing["sql"]:
                need_create = False
            if need_create:
                try:
                    conn.execute("DROP TABLE IF EXISTS vec_chunks")
                    conn.execute(
                        f"CREATE VIRTUAL TABLE vec_chunks USING vec0("
                        f"embedding float[{int(dim)}] distance_metric=cosine)")
                    log.info("created sqlite-vec index vec_chunks(dim=%s, cosine)", dim)
                except Exception as exc:
                    log.warning("sqlite-vec table creation failed (%s); using exact scan", exc)
                    _state.update({"backend": "exact-scan", "dim": dim})
                    return
            _state.update({"backend": "sqlite-vec", "dim": dim})
        else:
            _state.update({"backend": "exact-scan", "dim": dim})


def dim_matches(dim: int) -> bool:
    ensure_ready()
    return int(_state.get("dim") or 0) == int(dim)


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------


def upsert_many(rows: list[tuple[int, object]]) -> int:
    """rows = [(chunk_id, vector)]; writes the KNN index (blobs live in chunks)."""
    if not rows:
        return 0
    ensure_ready()
    conn = db.get_conn()
    n = 0
    if _state.get("backend") == "sqlite-vec":
        try:
            conn.execute("BEGIN")
            # vec0 virtual tables do not implement UPSERT -> delete then insert
            for chunk_id, vector in rows:
                cid = int(chunk_id)
                conn.execute("DELETE FROM vec_chunks WHERE rowid = ?", (cid,))
                conn.execute("INSERT INTO vec_chunks(rowid, embedding) VALUES(?, ?)",
                             (cid, serialize(normalize(vector))))
                n += 1
            conn.execute("COMMIT")
            return n
        except Exception as exc:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            log.warning("sqlite-vec upsert failed (%s); falling back to exact scan", exc)
            _state["backend"] = "exact-scan"
    return n


def delete_chunk(chunk_ids: list[int]) -> None:
    if not chunk_ids:
        return
    ensure_ready()
    if _state.get("backend") != "sqlite-vec":
        return
    conn = db.get_conn()
    try:
        marks = ",".join("?" * len(chunk_ids))
        conn.execute(f"DELETE FROM vec_chunks WHERE rowid IN ({marks})",
                     tuple(int(c) for c in chunk_ids))
    except Exception as exc:
        log.debug("vec delete failed: %s", exc)


def rebuild_from_blobs() -> int:
    """Recreate the KNN index from `chunks.embedding` (after a model change)."""
    ensure_ready()
    if _state.get("backend") != "sqlite-vec":
        return 0
    conn = db.get_conn()
    dim = int(_state.get("dim") or 0)
    conn.execute("DROP TABLE IF EXISTS vec_chunks")
    conn.execute(f"CREATE VIRTUAL TABLE vec_chunks USING vec0("
                 f"embedding float[{dim}] distance_metric=cosine)")
    rows = conn.execute(
        "SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL").fetchall()
    inserted = 0
    conn.execute("BEGIN")
    for row in rows:
        vec = unpack(row["embedding"])
        if not vec or len(vec) != dim:
            continue
        conn.execute("INSERT INTO vec_chunks(rowid, embedding) VALUES(?, ?)",
                     (row["id"], serialize(normalize(vec))))
        inserted += 1
    conn.execute("COMMIT")
    log.info("rebuilt sqlite-vec index with %d vectors (dim=%d)", inserted, dim)
    return inserted


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def search(query_vector, k: int = 15, allowed_chunk_ids: set[int] | None = None
           ) -> list[tuple[int, float]]:
    """Return [(chunk_id, cosine_similarity)] sorted best-first."""
    if not query_vector:
        return []
    ensure_ready()
    q = normalize(query_vector)
    if not any(q):
        return []
    k = max(1, int(k))

    if _state.get("backend") == "sqlite-vec":
        try:
            conn = db.get_conn()
            # over-fetch when we have to post-filter, so filtering can't starve us
            fetch = k if not allowed_chunk_ids else min(k * 6, 400)
            rows = conn.execute(
                "SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? "
                "ORDER BY distance",
                (serialize(q), fetch)).fetchall()
            out: list[tuple[int, float]] = []
            for row in rows:
                cid = int(row["rowid"])
                if allowed_chunk_ids is not None and cid not in allowed_chunk_ids:
                    continue
                sim = 1.0 - float(row["distance"])
                out.append((cid, max(-1.0, min(1.0, sim))))
                if len(out) >= k:
                    break
            if out:
                return out
        except Exception as exc:
            log.warning("sqlite-vec search failed (%s); using exact scan", exc)
            _state["backend"] = "exact-scan"

    return _exact_scan(q, k, allowed_chunk_ids)


def _exact_scan(q: list[float], k: int, allowed: set[int] | None) -> list[tuple[int, float]]:
    rows = db.query("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL")
    if not rows:
        return []
    if HAVE_NUMPY:
        ids = np.empty(len(rows), dtype=np.int64)
        vecs = np.empty((len(rows), len(q)), dtype=np.float32)
        keep = 0
        for i, row in enumerate(rows):
            if allowed is not None and int(row["id"]) not in allowed:
                continue
            v = unpack(row["embedding"])
            if len(v) != len(q):
                continue
            ids[keep] = int(row["id"])
            vecs[keep] = v
            keep += 1
        if keep == 0:
            return []
        vecs = vecs[:keep]
        ids = ids[:keep]
        norms = np.linalg.norm(vecs, axis=1)
        norms[norms < 1e-12] = 1.0
        sims = (vecs @ np.asarray(q, dtype=np.float32)) / norms
        kk = min(k, keep)
        top = np.argpartition(-sims, kk - 1)[:kk]
        top = top[np.argsort(-sims[top])]
        return [(int(ids[i]), float(sims[i])) for i in top]

    scored: list[tuple[int, float]] = []
    for row in rows:
        cid = int(row["id"])
        if allowed is not None and cid not in allowed:
            continue
        v = unpack(row["embedding"])
        if len(v) != len(q):
            continue
        dot = sum(a * b for a, b in zip(v, q))
        nv = math.sqrt(sum(a * a for a in v))
        if nv <= 1e-12:
            continue
        scored.append((cid, dot / nv))
    scored.sort(key=lambda t: -t[1])
    return scored[:k]


def stats() -> dict:
    ensure_ready()
    cfg = get_config()
    conn = db.get_conn()
    indexed = 0
    if _state.get("backend") == "sqlite-vec":
        try:
            indexed = int(conn.execute("SELECT COUNT(*) FROM vec_chunks").fetchone()[0])
        except Exception:
            indexed = 0
    total = int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
    with_blob = int(conn.execute(
        "SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL").fetchone()[0])
    return {
        "backend": _state.get("backend"),
        "dim": _state.get("dim"),
        "chunks": total,
        "chunks_with_vector": with_blob,
        "knn_indexed": indexed if _state.get("backend") == "sqlite-vec" else with_blob,
        "numpy": HAVE_NUMPY,
        "sqlite_vec_package": HAVE_SQLITE_VEC_PKG,
        "db_path": str(cfg.db_path),
    }
