"""Flask API + dashboard server.

    python -m server.app          # or:  ./run.sh

Endpoints are grouped: capture, query, memory, privacy, insights, jobs, meta.
Everything is JSON except the dashboard (HTML) and the SSE stream.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from flask import (Flask, Response, abort, jsonify, request, send_file,
                   send_from_directory, stream_with_context)

from . import (assistant, capture, db, digest, enrichment, interests, jobs, lexical,
               retrieval, scheduler, security, vector_store, web_search)
from .config import get_config
from .embeddings import describe_embedder, get_embedder
from .llm import describe_llm, get_llm
from .text import human_time, pretty_domain, registrable_domain, url_hash

log = logging.getLogger("twinbrain.app")

STATIC_DIR = Path(__file__).resolve().parent / "static"

SETTINGS_SCHEMA: dict[str, type | tuple] = {
    "capture_enabled": bool, "capture_content": bool, "min_dwell_seconds": int,
    "global_pause": bool, "retention_days": int, "respect_default_blocklist": bool,
    "skip_sensitive_urls": bool, "top_k": int, "candidate_k": int,
    "similarity_weight": float, "recency_weight": float, "min_grounding_score": float,
    "recency_halflife_days": float, "answer_style": str, "always_offer_links": bool,
    "web_search_enabled": bool, "web_search_for_answers": bool, "web_search_daily_budget": int,
    "web_ingest_enabled": bool, "web_ingest_per_run": int,
    "enrichment_enabled": bool, "enrichment_daily_budget": int, "enrichment_notify": bool,
    "notification_daily_budget": int, "notifications_enabled": bool,
    "digest_enabled": bool, "digest_hour": int, "digest_llm_polish": bool,
    "interest_learning_enabled": bool, "interest_max_topics": int,
    "tz_offset_minutes": int, "extension_version": str, "client_id": str,
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _body() -> dict[str, Any]:
    if request.is_json:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}
    if request.form:
        return request.form.to_dict()
    raw = request.get_data(as_text=True) or ""
    if raw.strip().startswith("{"):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}
    return {}


def _err(message: str, status: int = 400, **extra: Any) -> tuple[Response, int]:
    payload = {"ok": False, "error": message, **extra}
    return jsonify(payload), status


def _int_arg(name: str, default: int | None = None) -> int | None:
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _coerce(key: str, value: Any) -> Any:
    expected = SETTINGS_SCHEMA.get(key)
    if expected is None:
        return value
    if expected is bool:
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)
    if expected is int:
        return int(value)
    if expected is float:
        return float(value)
    return str(value)


def engine_info() -> dict[str, Any]:
    caps = db.capabilities()
    return {
        "embedder": describe_embedder(),
        "llm": describe_llm(),
        "vector": vector_store.stats(),
        "lexical": {"backend": lexical.backend(), "fts5": caps.get("fts5", False)},
        "web_search": {
            "provider": web_search.resolve_provider(),
            "enabled": bool(db.get_setting("web_search_enabled", True)),
            "configured": web_search.is_configured(),
            "usage": web_search.usage_today(),
        },
        "sqlite_vec": bool(caps.get("sqlite_vec")),
        "fts5": bool(caps.get("fts5")),
        "db_path": str(get_config().db_path),
    }


def budgets() -> dict[str, Any]:
    return {
        "notifications": digest.notification_budget(),
        "enrichment": digest.insight_budget(),
        "web_search": web_search.usage_today(),
    }


# ---------------------------------------------------------------------------
# app factory
# ---------------------------------------------------------------------------


def create_app(*, with_scheduler: bool | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    cfg = get_config()

    logging.basicConfig(
        level=logging.DEBUG if cfg.debug else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S")

    app.config["JSON_SORT_KEYS"] = False
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024   # 64 MB captures/imports
    app.json.sort_keys = False

    db.get_conn()
    if getattr(db, "PENDING_FTS_REBUILD", False):
        log.info("rebuilding the lexical index after a schema migration...")
        jobs.rebuild_lexical()
        db.PENDING_FTS_REBUILD = False
    jobs.ensure_embedding_model()
    security.install(app)

    # ---------------------------------------------------------------- meta --
    @app.get("/api/health")
    def health():
        stats = db.stats()
        return jsonify({
            "ok": True, "service": "twin-brain", "version": _version(),
            "time": db.now_iso(), "authenticated": bool(security.token_from_request()),
            "counts": stats, "engine": engine_info(), "budgets": budgets(),
            "scheduler": {"running": scheduler.is_running()},
            "settings": _public_settings(),
        })

    @app.get("/api/engine")
    def engine():
        return jsonify({"ok": True, **engine_info(), "budgets": budgets(),
                        "stats": db.stats(), "scheduler": scheduler.status()})

    @app.get("/api/token")
    def token_endpoint():
        """Hand the token to a browser that is allowed to auto-pair."""
        origin = security.request_origin()
        if not (cfg.auto_pair or security.token_from_request()):
            return _err("pairing disabled; read data/token.txt", 403)
        if origin and not security.origin_allowed(origin):
            return _err("origin not allowed", 403)
        return jsonify({"ok": True, "token": security.get_token(),
                        "header": security.HEADER_NAME,
                        "base_url": request.url_root.rstrip("/")})

    @app.route("/pair", methods=["GET"])
    def pair_page():
        return send_from_directory(STATIC_DIR, "pair.html")

    # ------------------------------------------------------------- capture --
    @app.post("/api/capture")
    def api_capture():
        payload = _body()
        url = (payload.get("url") or "").strip()
        if not url:
            return _err("url is required")
        if not bool(db.get_setting("capture_enabled", True)):
            return jsonify({"ok": False, "stored": False, "reason": "capture disabled"})
        # the extension pre-checks exclusions; re-check here (defence in depth)
        verdict = capture.check_url(url)
        if not verdict["allowed"]:
            return jsonify({"ok": True, "stored": False, "reason": verdict["reason"],
                            "mode": verdict["mode"], "url": url})
        if not payload.get("text") and payload.get("link_only"):
            out = capture.record_link_only(payload)
        else:
            out = capture.ingest(payload)
        return jsonify({"ok": bool(out.get("stored", True)), **out})

    @app.post("/api/capture/bulk")
    def api_capture_bulk():
        payload = _body()
        items = payload.get("pages") or payload.get("items") or []
        if isinstance(payload.get("url"), str):       # tolerate a bare object
            items = [payload]
        if not isinstance(items, list) or not items:
            return _err("pages[] is required")
        out = capture.ingest_many(items[:500])
        return jsonify({"ok": True, "received": len(items),
                        "ingested": out["ingested"], "skipped": out["skipped"],
                        "created": out["created"], "chunks": out["chunks"],
                        "errors": out["errors"][:10]})

    @app.post("/api/capture/visit")
    def api_capture_visit():
        """Link-only record: no content extraction (privacy mode / failed read)."""
        payload = _body()
        url = (payload.get("url") or "").strip()
        if not url:
            return _err("url is required")
        verdict = capture.check_url(url)
        if not verdict["allowed"]:
            return jsonify({"ok": True, "stored": False, "reason": verdict["reason"]})
        out = capture.record_link_only(payload)
        return jsonify({"ok": True, **out})

    @app.post("/api/heartbeat")
    def api_heartbeat():
        """Extension <-> backend sync: settings down, state up, notifications out."""
        payload = _body()
        if "tz_offset_minutes" in payload:
            db.set_setting("tz_offset_minutes", int(payload["tz_offset_minutes"] or 0))
        if payload.get("version"):
            db.set_setting("extension_version", str(payload["version"])[:40])
        if payload.get("client_id"):
            db.set_setting("client_id", str(payload["client_id"])[:80])
        if payload.get("counts"):
            db.set_setting("extension_counts", payload["counts"])
        # domain modes the user set in the extension UI are mirrored here so the
        # dashboard and the backend enforce the same rules. Accept both the list
        # form the extension sends and a plain {domain: mode} mapping.
        raw_modes = payload.get("domain_modes") or []
        if isinstance(raw_modes, dict):
            raw_modes = [{"domain": k, "mode": v} for k, v in raw_modes.items()]
        for entry in list(raw_modes)[:2000]:
            if not isinstance(entry, dict):
                continue
            domain = str(entry.get("domain") or "").lower().strip(".")
            mode = str(entry.get("mode") or "").lower()
            if domain and mode in {"full", "no_ai", "off"}:
                current = capture.domain_mode(domain)
                if current != mode:
                    capture.set_domain_mode(domain, mode, source="extension")
        return jsonify({
            "ok": True, "time": db.now_iso(),
            "settings": _public_settings(),
            "notifications": digest.drain_notifications(limit=5),
            "insights": digest.list_insights(limit=5, unseen_only=True),
            "budgets": budgets(),
            "stats": db.stats(),
            "engine": {"embedder": get_embedder().name, "llm": get_llm().name,
                       "vector": vector_store.backend_name(),
                       "lexical": lexical.backend()},
            "suggestions": assistant.suggest_questions(5),
        })

    # --------------------------------------------------------------- query --
    @app.post("/api/query")
    def api_query():
        payload = _body()
        query = (payload.get("query") or payload.get("q") or "").strip()
        if not query:
            return _err("query is required")
        out = assistant.answer(
            query,
            style=payload.get("style"),
            domains=payload.get("domains"),
            use_web=payload.get("use_web"),
            top_k=_int_arg("k") or payload.get("top_k"),
            save=bool(payload.get("save", True)),
        )
        return jsonify(out)

    @app.get("/api/query")
    def api_query_get():
        query = (request.args.get("q") or request.args.get("query") or "").strip()
        if not query:
            return _err("q is required")
        return jsonify(assistant.answer(query, style=request.args.get("style")))

    @app.get("/api/query/stream")
    def api_query_stream():
        query = (request.args.get("q") or "").strip()
        if not query:
            return _err("q is required")
        return Response(
            stream_with_context(assistant.answer_stream(
                query, style=request.args.get("style"))),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                     "Connection": "keep-alive"})

    @app.post("/api/search")
    def api_search():
        payload = _body()
        query = (payload.get("query") or payload.get("q") or "").strip()
        limit = int(payload.get("limit") or _int_arg("limit") or 25)
        domain = payload.get("domain") or None
        since = payload.get("since")
        results = retrieval.search_links(query, limit=limit, since=since, domain=domain)
        return jsonify({"ok": True, "query": query, "count": len(results),
                        "results": results})

    @app.get("/api/suggestions")
    def api_suggestions():
        return jsonify({"ok": True, "suggestions": assistant.suggest_questions(8)})

    @app.get("/api/prompt-preview")
    def api_prompt_preview():
        query = (request.args.get("q") or "").strip()
        if not query:
            return _err("q is required")
        return jsonify({"ok": True, **assistant.system_prompt_preview(query)})

    # -------------------------------------------------------------- memory --
    @app.get("/api/pages")
    def api_pages():
        limit = min(int(_int_arg("limit", 50) or 50), 500)
        since = request.args.get("since")
        domain = request.args.get("domain")
        query = (request.args.get("q") or "").strip()
        since_epoch = None
        if since:
            try:
                since_epoch = float(since)
            except ValueError:
                since_epoch = time.time() - 86400
        if query:
            items = retrieval.search_links(query, limit=limit, since=since_epoch,
                                           domain=domain)
        else:
            items = retrieval.timeline(limit=limit, since=since_epoch, domain=domain)
        return jsonify({"ok": True, "count": len(items), "pages": items})

    @app.get("/api/pages/<page_id>")
    def api_page(page_id: str):
        detail = retrieval.page_detail(page_id)
        if not detail:
            return _err("page not found", 404)
        return jsonify({"ok": True, "page": detail})

    @app.get("/api/pages/<page_id>/text")
    def api_page_text(page_id: str):
        row = db.query_one("SELECT id, url, title, domain, extracted_text, summary, "
                           "word_count, COALESCE(last_visited_at, visited_at) AS visited_at "
                           "FROM pages WHERE id=?", (page_id,))
        if not row:
            return _err("page not found", 404)
        return jsonify({"ok": True, "page_id": row["id"], "url": row["url"],
                        "title": row["title"], "domain": row["domain"],
                        "visited_at": row["visited_at"], "word_count": row["word_count"],
                        "summary": row["summary"],
                        "text": row["extracted_text"] or ""})

    @app.get("/api/pages/<page_id>/related")
    def api_page_related(page_id: str):
        return jsonify({"ok": True, "related": retrieval.related(page_id, limit=8)})

    @app.get("/api/page-by-url")
    def api_page_by_url():
        url = (request.args.get("url") or "").strip()
        if not url:
            return _err("url is required")
        out = assistant.about_this_page(url)
        return jsonify(out)

    @app.get("/api/conversations")
    def api_conversations():
        limit = min(int(_int_arg("limit", 30) or 30), 200)
        rows = db.query("SELECT id, query, response, referenced_page_ids, citations, "
                        "created_at, provider, grounded, used_web, latency_ms, mode "
                        "FROM conversations ORDER BY created_at DESC LIMIT ?", (limit,))
        out = []
        for r in rows:
            item = dict(r)
            for field in ("referenced_page_ids", "citations"):
                try:
                    item[field] = json.loads(item.get(field) or "[]")
                except (TypeError, ValueError):
                    item[field] = []
            item["created_ago"] = human_time(item.get("created_at"))
            out.append(item)
        return jsonify({"ok": True, "count": len(out), "conversations": out})

    @app.delete("/api/conversations")
    def api_conversations_clear():
        cur = db.execute("DELETE FROM conversations")
        return jsonify({"ok": True, "deleted": cur.rowcount or 0})

    # ------------------------------------------------------------- privacy --
    @app.post("/api/forget")
    def api_forget():
        payload = _body()
        reason = str(payload.get("reason") or "user request")[:120]
        if payload.get("domain"):
            removed = capture.forget_domain(str(payload["domain"]), reason=reason)
            capture.set_domain_mode(str(payload["domain"]), "off", source="forget",
                                    note=reason)
            return jsonify({"ok": True, "scope": "domain", "removed": removed,
                            "domain": payload["domain"]})
        if payload.get("url_prefix"):
            removed = capture.forget_url_prefix(str(payload["url_prefix"]), reason=reason)
            return jsonify({"ok": True, "scope": "url_prefix", "removed": removed})
        target = payload.get("page_id") or payload.get("url")
        if not target:
            return _err("page_id, url, domain or url_prefix is required")
        out = capture.forget_page(str(target), reason=reason)
        return jsonify(out)

    @app.post("/api/domains/mode")
    def api_domain_mode():
        payload = _body()
        domain = str(payload.get("domain") or "").strip().lower()
        mode = str(payload.get("mode") or "").strip().lower()
        if not domain:
            return _err("domain is required")
        if mode not in {"full", "no_ai", "off"}:
            return _err("mode must be full | no_ai | off")
        try:
            out = capture.set_domain_mode(domain, mode, source="user",
                                          note=str(payload.get("note") or "")[:120])
        except ValueError as exc:
            return _err(str(exc))
        return jsonify({"ok": True, **out, "mode_now": capture.domain_mode(domain)})

    @app.get("/api/domains")
    def api_domains():
        rows = retrieval.domains_with_memory(limit=1000)
        query = (request.args.get("q") or "").strip().lower()
        out = []
        known = {r["domain"] for r in rows}
        for r in rows:
            mode = capture.domain_mode(r["domain"])
            item = {**r, "mode": mode, "label": pretty_domain(r["domain"]),
                    "registrable": r.get("registrable_domain") or
                    registrable_domain(r["domain"]),
                    "last_seen_ago": human_time(r.get("last_visited_at")),
                    "in_memory": True}
            if query and query not in item["domain"]:
                continue
            out.append(item)
        # domains the user excluded but that have no stored rows any more
        for excl in capture.list_exclusions():
            domain = (excl.get("domain") or "").lower()
            if domain and domain not in known:
                if query and query not in domain:
                    continue
                out.append({"domain": domain, "label": pretty_domain(domain),
                            "registrable": registrable_domain(domain),
                            "mode": excl.get("mode"), "source": excl.get("source"),
                            "category": excl.get("note"), "visit_count": 0,
                            "page_count": 0, "total_dwell": 0, "last_visited_at": None,
                            "last_seen_ago": "", "in_memory": False, "ai_visible": 0})
        out.sort(key=lambda d: (-(d.get("visit_count") or 0), d.get("domain") or ""))
        return jsonify({"ok": True, "count": len(out), "domains": out,
                        "defaults": db.DEFAULT_BLOCKLIST})

    @app.get("/api/exclusions")
    def api_exclusions():
        return jsonify({"ok": True, "exclusions": capture.list_exclusions(),
                        "forgotten": [dict(r) for r in db.query(
                            "SELECT kind, value, reason, created_at FROM forgotten "
                            "WHERE kind IN ('page','domain') ORDER BY created_at DESC "
                            "LIMIT 200")]})

    @app.get("/api/export")
    def api_export():
        include_text = (request.args.get("include_text") or "1") not in ("0", "false", "no")
        dump = capture.export_all(include_text=include_text)
        if request.args.get("download"):
            body = json.dumps(dump, indent=1, default=str)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            return Response(body, mimetype="application/json", headers={
                "Content-Disposition": f'attachment; filename="twinbrain-export-{stamp}.json"'})
        return jsonify({"ok": True, **dump})

    @app.post("/api/export")
    def api_export_post():
        payload = _body()
        dump = capture.export_all(include_text=bool(payload.get("include_text", True)))
        return jsonify({"ok": True, **dump})

    @app.post("/api/import")
    def api_import():
        payload = _body()
        dump = payload.get("dump") or payload
        if not isinstance(dump, dict) or "pages" not in dump:
            return _err("expected a Twin-Brain export JSON with a 'pages' array")
        try:
            out = capture.import_dump(dump, embed=bool(payload.get("embed", True)))
        except ValueError as exc:
            return _err(str(exc))
        jobs.recompute_interests()
        return jsonify({"ok": True, **out})

    @app.post("/api/wipe")
    def api_wipe():
        payload = _body()
        confirm = str(payload.get("confirm") or "").strip()
        if confirm.upper() not in {"DELETE ALL", "WIPE", "YES DELETE EVERYTHING"}:
            return _err('refusing to wipe: send {"confirm": "DELETE ALL"}', 409)
        keep_settings = bool(payload.get("keep_settings", True))
        out = capture.wipe_all(keep_settings=keep_settings)
        return jsonify(out)

    # --------------------------------------------------------- insights etc --
    @app.get("/api/interests")
    def api_interests():
        return jsonify({"ok": True, **interests.profile()})

    @app.post("/api/interests/recompute")
    def api_interests_recompute():
        return jsonify({"ok": True, **jobs.run("interests")})

    @app.get("/api/digest")
    def api_digest():
        day = request.args.get("day") or None
        activity = digest.daily_activity(day)
        text = digest.render_digest(activity)
        stored = db.query_one("SELECT * FROM insights WHERE dedupe_key=?",
                              (f"digest:{activity['day']}",))
        return jsonify({"ok": True, "day": activity["day"], "digest": text,
                        "stored_body": (stored["body"] if stored else None),
                        "activity": {k: v for k, v in activity.items() if k != "pages"},
                        "pages": activity["pages"][:60]})

    @app.post("/api/digest/build")
    def api_digest_build():
        payload = _body()
        return jsonify({"ok": True, **digest.build_digest(payload.get("day"),
                                                          notify=bool(payload.get("notify")))})

    @app.get("/api/insights")
    def api_insights():
        limit = min(int(_int_arg("limit", 40) or 40), 200)
        unseen = request.args.get("unseen") in ("1", "true")
        return jsonify({"ok": True,
                        "insights": digest.list_insights(limit=limit, unseen_only=unseen,
                                                         day=request.args.get("day")),
                        "budgets": budgets()})

    @app.post("/api/insights/<insight_id>/seen")
    def api_insight_seen(insight_id: str):
        payload = _body()
        ok = digest.mark_seen(insight_id, dismissed=bool(payload.get("dismissed")))
        return jsonify({"ok": ok})

    @app.get("/api/notifications")
    def api_notifications():
        """Drained by the extension; the daily budget is enforced server-side."""
        items = digest.drain_notifications(limit=5)
        if not items:
            items = digest.list_insights(limit=3, unseen_only=True)
        return jsonify({"ok": True, "notifications": items,
                        "budget": digest.notification_budget()})

    @app.post("/api/enrichment/run")
    def api_enrichment_run():
        payload = _body()
        if payload.get("daily"):
            return jsonify({"ok": True, **enrichment.run_daily(force=bool(payload.get("force")))})
        candidate = None
        if payload.get("topic") or payload.get("query"):
            topic = str(payload.get("topic") or payload.get("query"))
            candidate = {"kind": "manual", "page_id": payload.get("page_id"),
                         "topic": topic, "title": topic, "url": payload.get("url"),
                         "domain": "", "query": web_search.build_query(topic, "", 12),
                         "reason": "you asked me to look this up", "score": 0}
        return jsonify({"ok": True, **enrichment.run_one(candidate,
                                                        force=bool(payload.get("force")))})

    @app.get("/api/enrichment")
    def api_enrichment_history():
        return jsonify({"ok": True, "runs": enrichment.history(limit=40),
                        "audit": enrichment.audit_outbound(limit=100),
                        "budget": digest.insight_budget(),
                        "candidates": enrichment.growth_candidates(5)})

    @app.get("/api/web")
    def api_web_search():
        query = (request.args.get("q") or "").strip()
        if not query:
            return _err("q is required")
        limit = min(int(_int_arg("limit", 6) or 6), 20)
        out = web_search.search_and_ingest(query, limit=limit, kind="answer")
        return jsonify({"ok": True, **out, "budget": web_search.usage_today()})

    @app.post("/api/web/save")
    def api_web_save():
        """Save a web result into memory, labelled as assistant-fetched."""
        payload = _body()
        url = (payload.get("url") or "").strip()
        if not url:
            return _err("url is required")
        pid = enrichment.fetch_and_store(
            {"url": url, "title": payload.get("title"), "snippet": payload.get("snippet")},
            topic=str(payload.get("topic") or "manual save"), run_id="manual")
        if not pid:
            return _err("could not fetch/store that page (blocked, unreadable or too short)",
                        422)
        return jsonify({"ok": True, "page_id": pid,
                        "page": retrieval.page_detail(pid)})

    # ------------------------------------------------------------- settings --
    def _public_settings() -> dict[str, Any]:
        settings = db.all_settings()
        settings.pop("auth_token", None)
        return settings

    @app.get("/api/settings")
    def api_settings():
        return jsonify({"ok": True, "settings": _public_settings(),
                        "defaults": db.DEFAULT_SETTINGS, "schema": sorted(SETTINGS_SCHEMA),
                        "engine": engine_info(), "budgets": budgets(),
                        "stats": db.stats()})

    @app.post("/api/settings")
    def api_settings_update():
        payload = _body()
        updates = payload.get("settings") if isinstance(payload.get("settings"), dict) \
            else payload
        applied: dict[str, Any] = {}
        rejected: list[str] = []
        for key, value in updates.items():
            if key not in SETTINGS_SCHEMA:
                rejected.append(key)
                continue
            try:
                coerced = _coerce(key, value)
            except (TypeError, ValueError):
                rejected.append(key)
                continue
            db.set_setting(key, coerced)
            applied[key] = coerced
        side_effects: dict[str, Any] = {}
        if "retention_days" in applied:
            side_effects["retention"] = capture.purge_retention()
        if "global_pause" in applied:
            side_effects["global_pause"] = applied["global_pause"]
        if {"enrichment_daily_budget", "notification_daily_budget"} & set(applied):
            side_effects["budgets"] = budgets()
        return jsonify({"ok": True, "applied": applied, "rejected": rejected,
                        "settings": _public_settings(), "side_effects": side_effects})

    @app.post("/api/llm/provider")
    def api_llm_provider():
        """Switch provider at runtime: extractive | anthropic | openai | auto."""
        payload = _body()
        choice = str(payload.get("provider") or "auto").lower()
        if choice not in {"auto", "extractive", "anthropic", "openai"}:
            return _err("provider must be auto | extractive | anthropic | openai")
        os.environ["TWINBRAIN_LLM"] = choice
        from .config import reload_config
        from .llm import reset_llm

        reload_config()
        reset_llm()
        try:
            llm = get_llm()
        except Exception as exc:
            return _err(str(exc), 500)
        return jsonify({"ok": True, "requested": choice, **describe_llm(),
                        "sample": llm.name})

    # ---------------------------------------------------------------- jobs --
    @app.get("/api/jobs")
    def api_jobs():
        return jsonify({"ok": True, "status": scheduler.status(),
                        "runs": jobs.recent_runs(limit=30),
                        "available": sorted(jobs.REGISTRY)})

    @app.post("/api/jobs/run/<name>")
    def api_jobs_run(name: str):
        if name not in jobs.REGISTRY:
            return _err(f"unknown job '{name}'", 404, available=sorted(jobs.REGISTRY))
        return jsonify({"ok": True, **jobs.run(name)})

    @app.get("/api/stats")
    def api_stats():
        return jsonify({"ok": True, "stats": db.stats(), "budgets": budgets(),
                        "engine": engine_info(), "scheduler": scheduler.status(),
                        "topics": interests.top_topics(20),
                        "sites": interests.top_sites(12)})

    # ---------------------------------------------------------- dashboard ---
    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/index.html")
    def index_alias():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/favicon.ico")
    def favicon():
        icon = STATIC_DIR / "favicon.ico"
        if icon.exists():
            return send_file(str(icon))
        png = STATIC_DIR / "icon-48.png"
        if png.exists():
            return send_file(str(png), mimetype="image/png")
        return Response(status=204)

    @app.get("/ui/<path:filename>")
    def ui_assets(filename: str):
        return send_from_directory(STATIC_DIR, filename)

    @app.get("/static/<path:filename>")
    def static_assets(filename: str):
        return send_from_directory(STATIC_DIR, filename)

    # ----------------------------------------------------------- teardown ---
    @app.teardown_appcontext
    def _teardown(_exc):  # pragma: no cover
        return None

    @app.errorhandler(404)
    def not_found(_e):
        if request.path.startswith("/api/"):
            return _err("not found", 404)
        return send_from_directory(STATIC_DIR, "index.html")

    @app.errorhandler(413)
    def too_large(_e):
        return _err("payload too large (max 64 MB)", 413)

    @app.errorhandler(500)
    def server_error(exc):
        log.exception("unhandled error: %s", exc)
        return _err(f"internal error: {exc}", 500)

    # --------------------------------------------------------- scheduler ----
    should_schedule = cfg.enable_scheduler if with_scheduler is None else with_scheduler
    if should_schedule:
        scheduler.start()

    return app


def _version() -> str:
    from . import __version__

    return __version__


def main() -> None:
    cfg = get_config()
    app = create_app()
    token = security.get_token()
    log.info("=" * 68)
    log.info("Twin-Brain backend ready")
    log.info("  dashboard : http://%s:%d/", cfg.host, cfg.port)
    log.info("  api token : %s", token)
    log.info("  token file: %s", cfg.token_path)
    log.info("  database  : %s", cfg.db_path)
    log.info("  embedder  : %s (dim=%s)", get_embedder().name, get_embedder().dim)
    log.info("  llm       : %s", get_llm().name)
    log.info("  vectors   : %s | lexical: %s", vector_store.backend_name(),
             lexical.backend())
    log.info("  web search: %s (enabled=%s)", web_search.resolve_provider(),
             db.get_setting("web_search_enabled", True))
    log.info("=" * 68)
    app.run(host=cfg.host, port=cfg.port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
