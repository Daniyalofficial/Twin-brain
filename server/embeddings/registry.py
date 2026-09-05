"""Embedder selection + caching.

The chosen model is recorded in the DB (`embedding_model`, `embedding_dim`).
`jobs.ensure_embedding_model()` compares it against the live embedder and
triggers a full re-embed when they differ — that is what lets you start on the
offline embedder today and upgrade to sentence-transformers next week without
losing anything.
"""

from __future__ import annotations

import logging
import threading

from ..config import get_config
from .base import Embedder
from .hashing import HashEmbedder

log = logging.getLogger("twinbrain.embeddings")

_lock = threading.Lock()
_embedder: Embedder | None = None
_selection: dict[str, str] = {}


def _build_st(model_name: str) -> Embedder | None:
    from .st_backend import AVAILABLE, SentenceTransformerEmbedder

    if not AVAILABLE:
        _selection["st_error"] = "package not installed"
        return None
    try:
        return SentenceTransformerEmbedder(model_name)
    except Exception as exc:
        log.warning("sentence-transformers unavailable (%s) — falling back", exc)
        _selection["st_error"] = str(exc)[:300]
        return None


def _build_api() -> Embedder | None:
    cfg = get_config()
    if not cfg.openai_key:
        _selection["api_error"] = "OPENAI_API_KEY not set"
        return None
    from .api_backend import ApiEmbedder

    try:
        return ApiEmbedder(cfg.openai_key, cfg.openai_base_url, cfg.embed_model)
    except Exception as exc:
        log.warning("hosted embedder unavailable (%s) — falling back", exc)
        _selection["api_error"] = str(exc)[:300]
        return None


def _select() -> Embedder:
    cfg = get_config()
    pref = (cfg.embedder or "auto").lower()

    if pref in ("st", "sentence-transformers"):
        emb = _build_st(cfg.st_model)
        if emb:
            _selection["requested"] = pref
            _selection["chosen"] = emb.name
            return emb
        if pref == "st":
            raise RuntimeError(
                "TWINBRAIN_EMBEDDER=st but sentence-transformers could not load: "
                + _selection.get("st_error", "unknown"))

    if pref == "openai":
        emb = _build_api()
        if emb:
            _selection.update({"requested": pref, "chosen": emb.name})
            return emb
        raise RuntimeError("TWINBRAIN_EMBEDDER=openai but the embeddings API failed: "
                           + _selection.get("api_error", "unknown"))

    if pref == "hash":
        emb = HashEmbedder()
        _selection.update({"requested": pref, "chosen": emb.name})
        return emb

    # auto: neural local > hosted > offline
    for builder in (lambda: _build_st(cfg.st_model), _build_api):
        try:
            emb = builder()
        except Exception as exc:  # pragma: no cover
            log.debug("embedder probe failed: %s", exc)
            emb = None
        if emb is not None:
            _selection.update({"requested": "auto", "chosen": emb.name})
            return emb
    emb = HashEmbedder()
    _selection.update({"requested": "auto", "chosen": emb.name})
    return emb


def get_embedder() -> Embedder:
    """Return the process-wide embedder, building it on first use."""
    global _embedder
    if _embedder is not None:
        return _embedder
    with _lock:
        if _embedder is None:
            try:
                _embedder = _select()
            except Exception as exc:
                log.error("embedder selection failed (%s); using offline hash embedder", exc)
                _selection["error"] = str(exc)[:300]
                _embedder = HashEmbedder()
            log.info("embedder: %s (dim=%s, local=%s)", _embedder.name, _embedder.dim,
                     _embedder.local)
    return _embedder


def reset_embedder() -> None:
    global _embedder
    with _lock:
        _embedder = None
        _selection.clear()


def describe_embedder() -> dict:
    emb = get_embedder()
    info = emb.describe()
    info["selection"] = dict(_selection)
    return info
