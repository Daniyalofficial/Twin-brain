"""Capture pipeline — everything that happens when a page arrives.

    validate -> exclusion check (again, server side) -> clean -> dedupe
    -> chunk -> embed -> index (sqlite-vec + FTS5) -> update domains

The extension checks exclusions *before* a content script runs, so excluded
content never touches disk even transiently. This module re-checks anyway:
defence in depth costs nothing and protects against a stale settings cache, a
manually replayed request, or a future second client.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Iterable

from . import db, lexical, vector_store
from .config import get_config
from .embeddings import get_embedder
from .text import (chunk_text, clean_text, content_hash, detect_lang, excerpt as make_excerpt,
                   extractive_summary, is_private_url, keywords, normalize_url,
                   registrable_domain, url_hash, word_count)

log = logging.getLogger("twinbrain.capture")

# page modes
MODE_FULL = "full"      # capture content + AI may use it
MODE_NO_AI = "no_ai"    # capture the link, hide it from retrieval
MODE_OFF = "off"        # never capture, never store

_VALID_MODES = {MODE_FULL, MODE_NO_AI, MODE_OFF}


# ---------------------------------------------------------------------------
# exclusions
# ---------------------------------------------------------------------------


def _load_exclusions() -> tuple[dict[str, str], list[tuple[str, str]]]:
    """-> (domain -> mode, [(url_prefix, mode)])"""
    domains: dict[str, str] = {}
    prefixes: list[tuple[str, str]] = []
    for row in db.query("SELECT domain, url_prefix, mode FROM exclusions"):
        mode = (row["mode"] or MODE_OFF).strip()
        if row["domain"]:
            domains[row["domain"].lower().lstrip(".")] = mode
        if row["url_prefix"]:
            prefixes.append((row["url_prefix"].lower(), mode))
    return domains, prefixes


def domain_mode(domain: str) -> str:
    """Effective privacy mode for a domain (exact host, then parents)."""
    domain = (domain or "").lower().lstrip(".")
    if not domain:
        return MODE_OFF
    domains, _ = _load_exclusions()
    labels = domain.split(".")
    for i in range(len(labels)):
        candidate = ".".join(labels[i:])
        if candidate in domains:
            return domains[candidate]
    row = db.query_one("SELECT mode FROM domains WHERE domain=?", (domain,))
    if row and row["mode"] in _VALID_MODES:
        return row["mode"]
    return MODE_FULL


def check_url(url: str) -> dict[str, Any]:
    """The single source of truth for "may we capture this?".

    Returns {allowed, mode, reason, domain}.  `allowed=False` means the content
    must never be written to disk.
    """
    url = (url or "").strip()
    if not url:
        return {"allowed": False, "mode": MODE_OFF, "reason": "empty url", "domain": ""}
    lowered = url.lower()
    if is_private_url(url):
        return {"allowed": False, "mode": MODE_OFF, "reason": "internal/browser page",
                "domain": ""}
    if lowered.startswith(("chrome", "about:", "edge:", "moz-", "view-source", "data:",
                           "blob:", "javascript:", "file:", "devtools")):
        return {"allowed": False, "mode": MODE_OFF, "reason": "non-http url", "domain": ""}

    from .text import domain_of

    domain = domain_of(url)
    if not domain:
        return {"allowed": False, "mode": MODE_OFF, "reason": "no host", "domain": ""}

    # explicit "never capture again" tombstones
    uid = url_hash(url)
    tomb = db.query_one("SELECT kind, value FROM forgotten WHERE id=?", (f"page:{uid}",))
    if tomb:
        return {"allowed": False, "mode": MODE_OFF, "reason": "user forgot this page",
                "domain": domain}
    tomb = db.query_one("SELECT value FROM forgotten WHERE kind='domain' AND value=?",
                        (registrable_domain(domain),))
    if tomb:
        return {"allowed": False, "mode": MODE_OFF, "reason": "user forgot this domain",
                "domain": domain}

    _, prefixes = _load_exclusions()
    for prefix, mode in prefixes:
        if lowered.startswith(prefix):
            return {"allowed": mode != MODE_OFF, "mode": mode,
                    "reason": f"url rule {prefix}", "domain": domain}

    mode = domain_mode(domain)
    if bool(db.get_setting("global_pause", False)):
        return {"allowed": False, "mode": mode, "reason": "global pause is on",
                "domain": domain}
    if mode == MODE_OFF:
        return {"allowed": False, "mode": MODE_OFF, "reason": "domain excluded",
                "domain": domain}
    if any(marker in lowered for marker in db.SENSITIVE_URL_MARKERS) and \
            bool(db.get_setting("skip_sensitive_urls", True)):
        return {"allowed": False, "mode": MODE_OFF, "reason": "sensitive url pattern",
                "domain": domain}
    return {"allowed": True, "mode": mode, "reason": "ok", "domain": domain}


def set_domain_mode(domain: str, mode: str, source: str = "user", note: str = "") -> dict:
    domain = (domain or "").lower().lstrip(".")
    if not domain:
        raise ValueError("domain required")
    if mode not in _VALID_MODES:
        raise ValueError(f"mode must be one of {sorted(_VALID_MODES)}")
    now = db.now_iso()
    # NOTE: idx_excl_domain is a PARTIAL unique index (WHERE domain IS NOT NULL),
    # so the upsert conflict target must repeat that predicate or SQLite raises
    # "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
    db.execute(
        "INSERT INTO exclusions(id, domain, url_prefix, mode, source, note, created_at) "
        "VALUES(?, ?, NULL, ?, ?, ?, ?) "
        "ON CONFLICT(domain) WHERE domain IS NOT NULL DO UPDATE SET "
        "mode=excluded.mode, source=excluded.source, note=excluded.note",
        (f"dom:{domain}", domain, mode, source, note, now))
    db.execute("UPDATE domains SET mode=?, ai_visible=? WHERE domain=?",
               (mode, 1 if mode == MODE_FULL else 0, domain))
    db.execute("UPDATE domains SET mode=?, ai_visible=? WHERE registrable_domain=?",
               (mode, 1 if mode == MODE_FULL else 0, domain))
    # enforce immediately on already-stored data
    visible = 1 if mode == MODE_FULL else 0
    db.execute("UPDATE pages SET ai_visible=? WHERE domain=? OR registrable_domain=?",
               (visible, domain, domain))
    if mode == MODE_OFF:
        removed = forget_domain(domain, reason=f"mode set to off ({source})", tombstone=False)
        return {"domain": domain, "mode": mode, "pages_removed": removed}
    return {"domain": domain, "mode": mode, "pages_hidden": visible == 0}


def list_exclusions() -> list[dict]:
    rows = db.query("SELECT id, domain, url_prefix, mode, source, note, created_at "
                    "FROM exclusions ORDER BY source DESC, domain ASC")
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------


def _index_page(page_id: str, title: str, text: str, embed: bool = True) -> dict[str, Any]:
    """Replace a page's chunks + vectors + lexical rows."""
    conn = db.get_conn()
    old = db.query(
        "SELECT c.id, c.text, COALESCE(p.title,'') AS title FROM chunks c "
        "LEFT JOIN pages p ON p.id = c.page_id WHERE c.page_id=?", (page_id,))
    if old:
        ids = [int(r["id"]) for r in old]
        vector_store.delete_chunk(ids)
        lexical.delete_chunks(ids, {int(r["id"]): (r["title"], r["text"]) for r in old})
        conn.execute("DELETE FROM chunks WHERE page_id=?", (page_id,))

    if not text or not text.strip():
        return {"chunks": 0, "embedded": 0}

    pieces = chunk_text(text)
    if not pieces:
        return {"chunks": 0, "embedded": 0}

    now = db.now_iso()
    inserted: list[tuple[int, str]] = []
    conn.execute("BEGIN")
    for piece in pieces:
        body = piece["text"]
        cur = conn.execute(
            "INSERT INTO chunks(page_id, idx, text, heading, char_start, char_end, "
            "token_count, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (page_id, piece["idx"], body, (title or "")[:200], piece.get("char_start"),
             piece.get("char_end"), len(body.split()), now))
        inserted.append((int(cur.lastrowid), body))
    conn.execute("COMMIT")

    embedded = 0
    centroid: list[float] | None = None
    if embed:
        try:
            embedder = get_embedder()
            vector_store.ensure_ready(embedder.dim)
            # Title-primed embedding text: retrieval quality goes up a lot for
            # short chunks, while the stored text stays verbatim.
            payload = [f"{title}\n{body}".strip()[:8000] for _, body in inserted]
            vectors = embedder.embed_texts(payload)
            conn.execute("BEGIN")
            for (chunk_id, _), vec in zip(inserted, vectors):
                conn.execute("UPDATE chunks SET embedding=? WHERE id=?",
                             (vector_store.pack(vec), chunk_id))
            conn.execute("COMMIT")
            vector_store.upsert_many([(cid, vec) for (cid, _), vec in zip(inserted, vectors)])
            embedded = len(vectors)
            if vectors:
                dim = len(vectors[0])
                acc = [0.0] * dim
                for vec in vectors:
                    for i, v in enumerate(vec):
                        acc[i] += v
                centroid = vector_store.normalize([a / len(vectors) for a in acc])
        except Exception as exc:
            log.warning("embedding failed for page %s: %s", page_id, exc)

    lexical.index_chunks([(cid, (title or "")[:200], body) for (cid, body) in inserted])

    if centroid is not None:
        conn.execute("UPDATE pages SET embedding=?, embedding_model=? WHERE id=?",
                     (vector_store.pack(centroid), get_embedder().name, page_id))
    return {"chunks": len(inserted), "embedded": embedded}


def ingest(payload: dict[str, Any], *, embed: bool = True,
           source: str = "extension") -> dict[str, Any]:
    """Store one captured page. Safe to call repeatedly for the same URL."""
    started = time.perf_counter()
    url = (payload.get("url") or "").strip()
    verdict = check_url(url)
    if not verdict["allowed"]:
        return {"ok": False, "stored": False, "url": url, "reason": verdict["reason"],
                "mode": verdict["mode"], "page_id": None, "took_ms": 0}

    domain = verdict["domain"]
    reg = registrable_domain(domain)
    ai_visible = 1 if verdict["mode"] == MODE_FULL else 0
    norm = normalize_url(url)
    page_id = payload.get("page_id") or url_hash(norm)

    raw_text = payload.get("text") or payload.get("extracted_text") or ""
    capture_content = bool(db.get_setting("capture_content", True)) and \
        payload.get("capture_content", True)
    text = clean_text(raw_text) if capture_content else ""
    title = clean_text(payload.get("title") or "", 300).strip() or norm
    words = word_count(text)
    description = clean_text(payload.get("description") or "", 500)

    visited_iso = payload.get("visited_at") or db.now_iso()
    dwell = int(payload.get("dwell_seconds") or 0)
    scroll = float(payload.get("scroll_depth") or 0.0)
    now = db.now_iso()

    existing = db.query_one("SELECT * FROM pages WHERE id=?", (page_id,))
    new_hash = content_hash(text) if text else None
    content_changed = bool(text) and (not existing or existing["content_hash"] != new_hash)

    summary = None
    topics_json = None
    if content_changed and text:
        summary = payload.get("summary") or extractive_summary(
            text, sentences=2, query=title, max_chars=420)
        kws = keywords(text, top_n=10, title=title)
        topics_json = json.dumps([{"topic": k, "weight": round(w, 3)} for k, w in kws])

    conn = db.get_conn()
    if existing:
        visit_count = int(existing["visit_count"] or 0) + 1
        total_dwell = int(existing["total_dwell_seconds"] or 0) + dwell
        max_scroll = max(float(existing["max_scroll_depth"] or 0.0), scroll)
        prev_avg = float(existing["avg_scroll_depth"] or 0.0)
        avg_scroll = (prev_avg * (visit_count - 1) + scroll) / max(visit_count, 1)
        fields = {
            "title": title, "last_visited_at": visited_iso, "visited_at": visited_iso,
            "visit_count": visit_count, "dwell_seconds": dwell,
            "total_dwell_seconds": total_dwell, "max_scroll_depth": max_scroll,
            "avg_scroll_depth": avg_scroll, "ai_visible": ai_visible,
            "registrable_domain": reg, "updated_at": now,
        }
        if content_changed:
            fields.update({
                "extracted_text": text, "excerpt": make_excerpt(text, 500),
                "word_count": words, "content_hash": new_hash, "lang": detect_lang(text),
                "status": "ok" if words > 20 else "thin",
            })
            if summary is not None:
                fields["summary"] = summary
            if topics_json is not None:
                fields["topics"] = topics_json
        else:
            # keep the longest text we ever saw
            if words > int(existing["word_count"] or 0) and text:
                fields.update({"extracted_text": text, "excerpt": make_excerpt(text, 500),
                               "word_count": words, "content_hash": new_hash,
                               "lang": detect_lang(text), "status": "ok"})
        sets = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE pages SET {sets} WHERE id=?", (*fields.values(), page_id))
        created = False
    else:
        conn.execute(
            """INSERT INTO pages(id, url, canonical_url, title, domain, registrable_domain,
                    extracted_text, excerpt, summary, topics, word_count, lang,
                    visited_at, first_visited_at, last_visited_at, visit_count,
                    dwell_seconds, total_dwell_seconds, scroll_depth, max_scroll_depth,
                    avg_scroll_depth, content_hash, status, source, ai_visible,
                    captured_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (page_id, norm, payload.get("canonical_url") or norm, title, domain, reg,
             text or None, make_excerpt(text, 500) if text else None, summary, topics_json,
             words, detect_lang(text) if text else None,
             visited_iso, visited_iso, visited_iso, 1, dwell, dwell, scroll, scroll, scroll,
             new_hash, ("ok" if words > 20 else ("thin" if text else "no_content")),
             payload.get("source") or source, ai_visible, now, now))
        created = True

    # every visit is logged, even repeats — "never forget the link"
    conn.execute(
        """INSERT INTO page_visits(page_id, url, title, domain, visited_at, dwell_seconds,
               scroll_depth, referrer, source, ai_visible, content_captured)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (page_id, norm, title, domain, visited_iso, dwell, scroll,
         payload.get("referrer") or "", payload.get("source") or source, ai_visible,
         1 if text else 0))

    _touch_domain(domain, reg, visited_iso, dwell, ai_visible,
                  verdict["mode"], created)

    indexed = {"chunks": 0, "embedded": 0}
    if content_changed or (created and text):
        indexed = _index_page(page_id, title, text, embed=embed)
    elif existing and not existing["embedding_model"]:
        indexed = _index_page(page_id, title, existing["extracted_text"] or "", embed=embed)

    if payload.get("description") and description:
        conn.execute("UPDATE pages SET summary=COALESCE(NULLIF(summary,''), ?) WHERE id=?",
                     (description, page_id))

    return {
        "ok": True, "stored": True, "created": created, "page_id": page_id, "url": norm,
        "title": title, "domain": domain, "mode": verdict["mode"],
        "ai_visible": bool(ai_visible), "words": words,
        "chunks": indexed["chunks"], "embedded": indexed["embedded"],
        "content_changed": content_changed,
        "took_ms": int((time.perf_counter() - started) * 1000),
    }


def ingest_many(payloads: Iterable[dict], *, embed: bool = True) -> dict[str, Any]:
    results = {"ingested": 0, "skipped": 0, "created": 0, "chunks": 0, "errors": [],
               "details": []}
    for payload in payloads:
        try:
            out = ingest(payload, embed=embed)
        except Exception as exc:
            results["errors"].append({"url": payload.get("url"), "error": str(exc)[:200]})
            continue
        if out.get("stored"):
            results["ingested"] += 1
            results["created"] += 1 if out.get("created") else 0
            results["chunks"] += out.get("chunks", 0)
        else:
            results["skipped"] += 1
        results["details"].append(out)
    return results


def record_link_only(payload: dict[str, Any]) -> dict[str, Any]:
    """Store the link + metadata with no content (extraction off / failed)."""
    payload = dict(payload)
    payload["text"] = ""
    payload["capture_content"] = False
    return ingest(payload, embed=False)


def _touch_domain(domain: str, reg: str, visited_iso: str, dwell: int, ai_visible: int,
                  mode: str, new_page: bool) -> None:
    row = db.query_one("SELECT * FROM domains WHERE domain=?", (domain,))
    if row:
        db.execute(
            "UPDATE domains SET visit_count=visit_count+1, page_count=page_count+?, "
            "total_dwell=total_dwell+?, last_visited_at=?, ai_visible=?, "
            "registrable_domain=? WHERE domain=?",
            (1 if new_page else 0, dwell, visited_iso, ai_visible, reg, domain))
    else:
        db.execute(
            "INSERT INTO domains(domain, registrable_domain, visit_count, page_count, "
            "total_dwell, first_seen, last_visited_at, mode, ai_visible) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (domain, reg, 1, 1 if new_page else 0, dwell, visited_iso, visited_iso,
             mode, ai_visible))


# ---------------------------------------------------------------------------
# forgetting (the trust features)
# ---------------------------------------------------------------------------


def _delete_page_chunks(page_id: str) -> None:
    """Remove a page's chunks from the table, the KNN index and the FTS index."""
    rows = db.query(
        "SELECT c.id, c.text, COALESCE(p.title,'') AS title FROM chunks c "
        "LEFT JOIN pages p ON p.id = c.page_id WHERE c.page_id=?", (page_id,))
    if not rows:
        return
    ids = [int(r["id"]) for r in rows]
    vector_store.delete_chunk(ids)
    lexical.delete_chunks(ids, {int(r["id"]): (r["title"], r["text"]) for r in rows})
    db.execute("DELETE FROM chunks WHERE page_id=?", (page_id,))


def forget_page(url_or_id: str, reason: str = "user request") -> dict[str, Any]:
    """Delete a page completely and tombstone it so it is never re-captured."""
    rows = db.query("SELECT id, url, domain FROM pages WHERE id=? OR url=?",
                    (url_or_id, url_or_id))
    if not rows and url_or_id.startswith("http"):
        rows = [{"id": url_hash(url_or_id), "url": normalize_url(url_or_id), "domain": ""}]
    removed = 0
    for row in rows:
        pid = row["id"]
        _delete_page_chunks(pid)
        db.execute("DELETE FROM pages WHERE id=?", (pid,))
        db.execute("DELETE FROM page_visits WHERE page_id=?", (pid,))
        db.execute("DELETE FROM conversations WHERE referenced_page_ids LIKE ?",
                   (f'%"{pid}"%',))
        db.execute("INSERT OR REPLACE INTO forgotten(id, kind, value, reason, created_at) "
                   "VALUES(?,?,?,?,?)",
                   (f"page:{pid}", "page", row["url"] or pid, reason, db.now_iso()))
        removed += 1
    _recount_domains()
    return {"ok": True, "removed": removed, "reason": reason}


def forget_domain(domain: str, reason: str = "user request", tombstone: bool = True) -> int:
    domain = (domain or "").lower().lstrip(".")
    reg = registrable_domain(domain)
    rows = db.query("SELECT id, url FROM pages WHERE domain=? OR registrable_domain=? OR domain=? OR registrable_domain=?",
                    (domain, domain, reg, reg))
    for row in rows:
        pid = row["id"]
        _delete_page_chunks(pid)
        db.execute("DELETE FROM pages WHERE id=?", (pid,))
        db.execute("DELETE FROM page_visits WHERE page_id=? OR domain=? OR domain=?",
                   (pid, domain, reg))
    if tombstone:
        db.execute("INSERT OR REPLACE INTO forgotten(id, kind, value, reason, created_at) "
                   "VALUES(?,?,?,?,?)",
                   (f"domain:{reg}", "domain", reg, reason, db.now_iso()))
    db.execute("DELETE FROM domains WHERE domain=? OR registrable_domain=?", (domain, reg))
    _recount_domains()
    return len(rows)


def forget_url_prefix(prefix: str, reason: str = "user request") -> int:
    rows = db.query("SELECT id FROM pages WHERE url LIKE ?", (prefix.rstrip("*") + "%",))
    for row in rows:
        forget_page(row["id"], reason=reason)
    return len(rows)


def _recount_domains() -> None:
    db.execute("DELETE FROM domains")
    db.execute(
        """INSERT INTO domains(domain, registrable_domain, visit_count, page_count,
               total_dwell, first_seen, last_visited_at, mode, ai_visible)
           SELECT p.domain, p.registrable_domain,
                  COALESCE(SUM(p.visit_count), COUNT(*)), COUNT(*),
                  COALESCE(SUM(p.total_dwell_seconds), 0),
                  MIN(p.first_visited_at), MAX(p.last_visited_at),
                  'full', p.ai_visible
           FROM pages p WHERE p.domain IS NOT NULL AND p.domain != ''
           GROUP BY p.domain, p.registrable_domain""")
    # re-apply stored modes
    for row in db.query("SELECT domain, mode FROM exclusions WHERE domain IS NOT NULL"):
        visible = 1 if row["mode"] == MODE_FULL else 0
        db.execute("UPDATE domains SET mode=?, ai_visible=? WHERE domain=? OR registrable_domain=?",
                   (row["mode"], visible, row["domain"], row["domain"]))


def purge_retention(days: int | None = None) -> dict[str, Any]:
    """Apply the retention window. 0 / None = keep forever ("never forget")."""
    days = int(days if days is not None else db.get_setting("retention_days",
                                                            get_config().retention_days))
    if days <= 0:
        return {"ok": True, "days": 0, "removed": 0, "kept": "everything (never forget)"}
    cutoff = db.now_iso(time.time() - days * 86400)
    rows = db.query(
        "SELECT id FROM pages WHERE COALESCE(last_visited_at, visited_at) < ?", (cutoff,))
    for row in rows:
        pid = row["id"]
        _delete_page_chunks(pid)
        db.execute("DELETE FROM pages WHERE id=?", (pid,))
        db.execute("DELETE FROM page_visits WHERE page_id=? OR visited_at < ?", (pid, cutoff))
    if rows:
        _recount_domains()
    return {"ok": True, "days": days, "removed": len(rows), "cutoff": cutoff}


def export_all(*, include_text: bool = True) -> dict[str, Any]:
    """Full JSON dump — required for user trust, not a nice-to-have."""
    pages = []
    for row in db.query("SELECT * FROM pages ORDER BY COALESCE(last_visited_at, visited_at) DESC"):
        item = dict(row)
        item.pop("embedding", None)
        if not include_text:
            item.pop("extracted_text", None)
        pages.append(item)
    visits = [dict(r) for r in db.query("SELECT * FROM page_visits ORDER BY visited_at DESC")]
    return {
        "exported_at": db.now_iso(),
        "version": db.SCHEMA_VERSION,
        "counts": db.stats(),
        "settings": db.all_settings(),
        "exclusions": list_exclusions(),
        "domains": [dict(r) for r in db.query("SELECT * FROM domains ORDER BY visit_count DESC")],
        "interests": [dict(r) for r in db.query("SELECT * FROM interests ORDER BY weight DESC")],
        "conversations": [dict(r) for r in db.query(
            "SELECT * FROM conversations ORDER BY created_at DESC LIMIT 5000")],
        "insights": [dict(r) for r in db.query("SELECT * FROM insights ORDER BY created_at DESC")],
        "pages": pages,
        "visits": visits,
    }


def import_dump(dump: dict[str, Any], *, embed: bool = True) -> dict[str, Any]:
    """Restore a JSON export (idempotent — safe to run twice)."""
    if not isinstance(dump, dict) or "pages" not in dump:
        raise ValueError("not a Twin-Brain export file")
    settings = dump.get("settings") or {}
    for key, value in settings.items():
        if key in ("schema_version", "installed_at"):
            continue
        db.set_setting(key, value)
    for excl in dump.get("exclusions") or []:
        if excl.get("domain"):
            set_domain_mode(excl["domain"], excl.get("mode") or MODE_OFF,
                            source=excl.get("source") or "import",
                            note=excl.get("note") or "")
    stats = {"pages": 0, "skipped": 0}
    for page in dump.get("pages") or []:
        url = page.get("url")
        if not url:
            stats["skipped"] += 1
            continue
        out = ingest({
            "url": url, "title": page.get("title"), "text": page.get("extracted_text"),
            "visited_at": page.get("last_visited_at") or page.get("visited_at"),
            "dwell_seconds": page.get("dwell_seconds") or 0,
            "scroll_depth": page.get("max_scroll_depth") or 0,
            "summary": page.get("summary"), "source": "import",
        }, embed=embed)
        stats["pages" if out.get("stored") else "skipped"] += 1
    return stats


def wipe_all(*, keep_settings: bool = True) -> dict[str, Any]:
    """Delete everything. Irreversible. This is the button users need."""
    before = db.stats()
    tables = ["chunks", "pages", "page_visits", "conversations", "insights",
              "enrichment_runs", "interests", "forgotten", "domains", "web_cache",
              "jobs_log"]
    for table in tables:
        db.execute(f"DELETE FROM {table}")
    if db.capabilities().get("sqlite_vec"):
        try:
            db.execute("DELETE FROM vec_chunks")
        except Exception:
            pass
    if not keep_settings:
        db.execute("DELETE FROM settings")
    if _has_sqlite_sequence():
        db.execute("DELETE FROM sqlite_sequence "
                   "WHERE name IN ('chunks','page_visits','jobs_log')")
    after = db.stats()
    return {"ok": True, "before": before, "after": after,
            "kept_settings": keep_settings, "wiped_at": db.now_iso()}


def _has_sqlite_sequence() -> bool:
    return db.query_one("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'") is not None
