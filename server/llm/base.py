"""LLM provider interface + resolution."""

from __future__ import annotations

import logging
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("twinbrain.llm")

_lock = threading.Lock()
_llm: "LLM | None" = None
_selection: dict[str, str] = {}


@dataclass
class LLMResponse:
    text: str
    provider: str = "extractive"
    model: str = "grounded-extractive-v1"
    grounded: bool = True
    citations: list[dict[str, Any]] = field(default_factory=list)
    used_web: bool = False
    web_results: list[dict[str, Any]] = field(default_factory=list)
    latency_ms: int = 0
    confidence: str = "medium"
    error: str | None = None
    intent: str = "question"

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "provider": self.provider,
            "model": self.model,
            "grounded": self.grounded,
            "confidence": self.confidence,
            "citations": self.citations,
            "used_web": self.used_web,
            "web_results": self.web_results,
            "latency_ms": self.latency_ms,
            "error": self.error,
            "intent": self.intent,
        }


class LLM(ABC):
    """Answers a query *given* retrieved memories. Never retrieves on its own."""

    name = "base"
    model = "base"
    local = True

    @abstractmethod
    def complete(self, messages: list[dict], *, max_tokens: int = 700,
                 temperature: float = 0.2) -> str:
        """Raw chat completion against already-built messages."""

    def answer(self, query: str, result: Any, *, web_results: list[dict] | None = None,
               history: list[dict] | None = None, style: str = "concise",
               near_miss: Any = None) -> LLMResponse:
        """Default implementation: build the spec prompt, then post-process."""
        from .extractive import compose_fallback
        from .prompts import build_messages

        started = time.perf_counter()
        context = result.context_block() if result is not None else "(no matching memories)"
        web_block = _format_web(web_results) if web_results else ""
        messages = build_messages(query, context, web_block, style=style, history=history)
        try:
            text = self.complete(messages)
        except Exception as exc:
            log.warning("%s completion failed (%s); using offline grounded composer",
                        self.name, exc)
            resp = compose_fallback(query, result, web_results=web_results,
                                    near_miss=near_miss, style=style)
            resp.provider = f"{self.name}->extractive"
            resp.error = str(exc)[:300]
            resp.latency_ms = int((time.perf_counter() - started) * 1000)
            return resp

        grounded = bool(result is not None and result.grounded)
        citations = _citations(result) if result is not None else []
        text = (text or "").strip()
        if not text:
            resp = compose_fallback(query, result, web_results=web_results,
                                    near_miss=near_miss, style=style)
            resp.provider = f"{self.name}->extractive"
            resp.error = "empty completion"
            return resp
        if not grounded and citations:
            text += "\n\n(Closest pages in your history — none of them clearly answer this.)"
        text = _append_sources(text, citations, web_results)
        return LLMResponse(
            text=text, provider=self.name, model=self.model, grounded=grounded,
            citations=citations, used_web=bool(web_results),
            web_results=web_results or [],
            latency_ms=int((time.perf_counter() - started) * 1000),
            confidence=_confidence(result),
            intent=getattr(result, "intent", "question") if result else "question")


def _confidence(result: Any) -> str:
    if result is None or not result.matches:
        return "none"
    best = getattr(result, "best_relevance", 0.0) or 0.0
    if best >= 0.55:
        return "high"
    if best >= 0.32:
        return "medium"
    return "low"


def _citations(result: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, m in enumerate(getattr(result, "matches", []) or [], start=1):
        out.append({
            "index": i,
            "page_id": m.page_id,
            "title": m.title,
            "url": m.url,
            "domain": m.domain,
            "visited_at": m.visited_at,
            "visited_ago": _ago(m.visited_at),
            "dwell_seconds": m.dwell_seconds,
            "excerpt": m.excerpt,
            "relevance": round(m.relevance, 4),
            "score": round(m.score, 4),
        })
    return out


def _ago(iso: str | None) -> str:
    from ..text import human_time

    return human_time(iso)


def _format_web(web_results: list[dict] | None, limit: int = 5) -> str:
    if not web_results:
        return ""
    lines = []
    for i, r in enumerate(web_results[:limit], start=1):
        lines.append(f"[W{i}] {r.get('title','(untitled)')}\n"
                     f"     source: {r.get('source','')} | {r.get('url','')}\n"
                     f"     snippet: {str(r.get('snippet',''))[:300]}")
    return "\n".join(lines)


def _append_sources(text: str, citations: list[dict], web_results: list[dict] | None) -> str:
    """Guarantee a verifiable source list even if the model forgot to cite."""
    if not citations and not web_results:
        return text
    low = text.lower()
    has_http = "http://" in low or "https://" in low
    if has_http:
        return text
    parts = [text.rstrip()]
    if citations:
        parts.append("\nSources in your history:")
        for c in citations[:6]:
            parts.append(f"  [{c['index']}] {c['title']} — {c['domain'] or 'unknown site'}"
                         f" ({c['visited_ago']}) {c['url']}")
    if web_results:
        parts.append("\nFrom the web (not your history):")
        for i, r in enumerate(web_results[:4], start=1):
            parts.append(f"  [W{i}] {r.get('title','')} — {r.get('source','')} {r.get('url','')}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# provider resolution
# ---------------------------------------------------------------------------


def _build(provider: str) -> LLM:
    cfg = _cfg()
    provider = (provider or "auto").lower()

    if provider == "extractive":
        from .extractive import ExtractiveLLM

        return ExtractiveLLM()

    if provider == "anthropic":
        from .anthropic_provider import AnthropicLLM

        if not cfg.anthropic_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        return AnthropicLLM(cfg.anthropic_key, cfg.anthropic_model)

    if provider == "openai":
        from .openai_provider import OpenAICompatLLM

        model = cfg.local_model or cfg.openai_chat_model
        if not cfg.openai_key and "localhost" not in cfg.openai_base_url \
                and "127.0.0.1" not in cfg.openai_base_url:
            raise RuntimeError("OPENAI_API_KEY not set")
        return OpenAICompatLLM(api_key=cfg.openai_key or "not-needed",
                               base_url=cfg.openai_base_url, model=model)

    # auto
    if cfg.anthropic_key:
        try:
            return _build("anthropic")
        except Exception as exc:
            _selection["anthropic_error"] = str(exc)[:200]
    if cfg.openai_key or cfg.local_model or "localhost" in cfg.openai_base_url:
        try:
            return _build("openai")
        except Exception as exc:
            _selection["openai_error"] = str(exc)[:200]
    from .extractive import ExtractiveLLM

    return ExtractiveLLM()


def _cfg():
    from ..config import get_config

    return get_config()


def get_llm() -> LLM:
    global _llm
    if _llm is not None:
        return _llm
    with _lock:
        if _llm is None:
            cfg = _cfg()
            _selection["requested"] = cfg.llm
            try:
                _llm = _build(cfg.llm)
            except Exception as exc:
                log.error("LLM provider '%s' failed (%s); using offline grounded engine",
                          cfg.llm, exc)
                _selection["error"] = str(exc)[:300]
                from .extractive import ExtractiveLLM

                _llm = ExtractiveLLM()
            _selection["chosen"] = _llm.name
            log.info("llm: %s (model=%s, local=%s)", _llm.name, _llm.model, _llm.local)
    return _llm


def reset_llm() -> None:
    global _llm
    with _lock:
        _llm = None
        _selection.clear()


def describe_llm() -> dict:
    llm = get_llm()
    return {"name": llm.name, "model": llm.model, "local": llm.local,
            "selection": dict(_selection)}
