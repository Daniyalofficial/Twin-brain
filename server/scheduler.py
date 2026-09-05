"""Background scheduler.

One daemon thread, a 20 s tick, and a small table of "when is this job due"
rules. No cron, no celery, no extra processes — it starts with the Flask app
and stops with it.

Budgets (enrichment runs, notifications, web searches) are enforced by the job
modules themselves, so a missed tick can never cause a burst.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from . import db, jobs
from .config import get_config

log = logging.getLogger("twinbrain.scheduler")

TICK_SECONDS = 20

_thread: threading.Thread | None = None
_stop = threading.Event()
_started_at: float | None = None
# RLock, not Lock: status() takes the lock and then calls is_running(), which
# takes it again. A plain Lock deadlocked the /api/jobs + /api/stats endpoints.
_lock = threading.RLock()
_stats: dict[str, Any] = {"ticks": 0, "runs": [], "errors": []}


def _last_run(name: str) -> float:
    value = db.get_setting(f"job_last_run:{name}")
    if not value:
        return 0.0
    try:
        return time.mktime(time.strptime(str(value)[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (ValueError, OverflowError):
        return 0.0


def _last_day(name: str) -> str:
    return str(db.get_setting(f"job_last_day:{name}") or "")


def _mark_day(name: str, day: str) -> None:
    db.set_setting(f"job_last_day:{name}", day)


def _run(name: str, fn) -> None:
    try:
        out = jobs._log_job(name, fn)
        with _lock:
            _stats["runs"].append({"job": name, "at": db.now_iso(),
                                   "status": out.get("status"),
                                   "took_ms": out.get("took_ms")})
            _stats["runs"] = _stats["runs"][-50:]
        log.info("job %s -> %s (%sms)", name, out.get("status"), out.get("took_ms"))
    except Exception as exc:  # pragma: no cover
        log.exception("job %s crashed", name)
        with _lock:
            _stats["errors"].append({"job": name, "error": str(exc)[:200],
                                     "at": db.now_iso()})
            _stats["errors"] = _stats["errors"][-20:]


def _tick() -> None:
    now = time.time()
    today = db.today_str()
    cfg = get_config()

    # 1) pending embeddings (capture may have skipped embedding for speed)
    if now - _last_run("embed_pending") > 300:
        pending = db.query_one("SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NULL")
        if pending and int(pending["c"] or 0) > 0:
            _run("embed_pending", lambda: jobs.embed_pending(limit=200))
        else:
            db.set_setting("job_last_run:embed_pending", db.now_iso())

    # 2) interest profile: refresh a few times a day, and after big imports
    if now - _last_run("interests") > 3 * 3600:
        _run("interests", jobs.recompute_interests)

    # 3) daily digest at the configured local hour
    digest_hour = int(db.get_setting("digest_hour", cfg.digest_hour))
    local = time.localtime(now)
    target = time.mktime((local.tm_year, local.tm_mon, local.tm_mday,
                          max(0, min(23, digest_hour)), 0, 0, 0, 0, -1))
    if now >= target and _last_day("digest") != today and \
            bool(db.get_setting("digest_enabled", True)):
        _run("digest", lambda: jobs.build_digest(notify=True))
        _mark_day("digest", today)

    # 4) enrichment sweep, 15 min after the digest window (budget: 5/day)
    if now >= target + 900 and _last_day("enrichment") != today and \
            bool(db.get_setting("enrichment_enabled", True)):
        _run("enrichment", jobs.run_enrichment)
        _mark_day("enrichment", today)

    # 5) retention purge (0 days = keep forever)
    if _last_day("retention") != today:
        retention = int(db.get_setting("retention_days", cfg.retention_days) or 0)
        if retention > 0:
            _run("retention", jobs.purge_retention)
        _mark_day("retention", today)

    # 6) weekly housekeeping
    if now - _last_run("prune_cache") > 7 * 24 * 3600:
        _run("prune_cache", jobs.prune_cache)


def _loop() -> None:
    log.info("scheduler started (tick=%ss)", TICK_SECONDS)
    # startup work
    try:
        _run("ensure_embedding_model", jobs.ensure_embedding_model)
    except Exception:  # pragma: no cover
        log.exception("startup embedding check failed")
    try:
        _run("interests", jobs.recompute_interests)
    except Exception:  # pragma: no cover
        log.exception("startup interest recompute failed")

    while not _stop.is_set():
        try:
            with _lock:
                _stats["ticks"] += 1
            _tick()
        except Exception as exc:  # pragma: no cover
            log.exception("scheduler tick failed: %s", exc)
            with _lock:
                _stats["errors"].append({"job": "tick", "error": str(exc)[:200],
                                         "at": db.now_iso()})
        _stop.wait(TICK_SECONDS)
    db.close_thread_conn()
    log.info("scheduler stopped")


def start() -> bool:
    global _thread, _started_at
    cfg = get_config()
    if not cfg.enable_scheduler:
        log.info("scheduler disabled by config")
        return False
    with _lock:
        if _thread is not None and _thread.is_alive():
            return True
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="twinbrain-scheduler", daemon=True)
        _started_at = time.time()
        _thread.start()
    return True


def stop() -> None:
    global _thread
    _stop.set()
    with _lock:
        thread = _thread
        _thread = None
    if thread is not None:
        thread.join(timeout=5)      # outside the lock: the tick takes it too


def is_running() -> bool:
    with _lock:
        return bool(_thread is not None and _thread.is_alive())


def status() -> dict[str, Any]:
    with _lock:
        return {
            "running": is_running(),
            "started_at": db.now_iso(_started_at) if _started_at else None,
            "tick_seconds": TICK_SECONDS,
            "ticks": _stats["ticks"],
            "recent_runs": _stats["runs"][-12:],
            "errors": _stats["errors"][-6:],
            "jobs": jobs.status(),
            "digest_hour": int(db.get_setting("digest_hour", get_config().digest_hour)),
        }
