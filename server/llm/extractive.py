"""The built-in grounded answer engine.

This is the default when no LLM API key is configured, and the safety net every
other provider falls back to on error. It cannot hallucinate a memory by
construction: every sentence it emits is either

  * a sentence that literally exists on a page the user visited, or
  * a statement about that page's own metadata (title, site, date, dwell, URL), or
  * an explicit "I don't have anything in your history matching that."

It is less fluent than a neural LLM. It is never less honest.
"""

from __future__ import annotations

import re
import time
from typing import Any

from ..text import format_dwell, human_time, pretty_domain, truncate
from .base import LLM, LLMResponse, _citations, _confidence
from .intent import classify

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _first_sentence(text: str, max_chars: int = 300) -> str:
    if not text:
        return ""
    parts = [p.strip() for p in _SENT_SPLIT.split(text.strip()) if p.strip()]
    out = parts[0] if parts else text.strip()
    return truncate(out, max_chars)


def _clean_sentence(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    return text.rstrip(" ,;:-")


class ExtractiveLLM(LLM):
    name = "extractive"
    model = "grounded-extractive-v1"
    local = True

    # -- raw completion API (kept for interface compatibility) -------------
    def complete(self, messages: list[dict], *, max_tokens: int = 700,
                 temperature: float = 0.2) -> str:
        """Best-effort extractive completion from an already-built prompt."""
        system = next((m["content"] for m in messages if m.get("role") == "system"), "")
        query = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        block = ""
        if "RETRIEVED MEMORIES:" in system:
            block = system.split("RETRIEVED MEMORIES:", 1)[1].split("USER QUERY:", 1)[0]
        if "(no matching memories" in block or not block.strip():
            return "I don't have anything in your history matching that."
        lines = [ln.strip() for ln in block.splitlines() if ln.strip().startswith("excerpt:")]
        text = " ".join(_clean_sentence(ln.split("excerpt:", 1)[1]) for ln in lines[:2])
        return truncate(text or "I found matching pages but no readable excerpt.", 900)

    # -- the real entry point ---------------------------------------------
    def answer(self, query: str, result: Any, *, web_results: list[dict] | None = None,
               history: list[dict] | None = None, style: str = "concise",
               near_miss: Any = None) -> LLMResponse:
        started = time.perf_counter()
        intent = classify(query)
        citations = _citations(result) if result is not None else []
        grounded = bool(result is not None and result.grounded and result.matches)

        if intent.name == "greeting":
            text = self._greeting()
        elif grounded:
            text = self._compose(query, result, intent, style)
        else:
            text = self._no_match(query, result, near_miss, web_results)

        used_web = bool(web_results)
        if used_web:
            text += "\n\n" + self._web_section(web_results)

        return LLMResponse(
            text=text.strip(), provider=self.name, model=self.model, grounded=grounded,
            citations=citations if grounded else [], used_web=used_web,
            web_results=web_results or [],
            latency_ms=int((time.perf_counter() - started) * 1000),
            confidence=_confidence(result) if grounded else "none",
            intent=intent.name)

    # -- pieces ------------------------------------------------------------
    def _greeting(self) -> str:
        from .. import db

        s = db.stats()
        if not s["pages"]:
            return ("Hi — I'm your Twin-Brain, but my memory is still empty. Load the "
                    "extension, browse normally for a few minutes, then ask me something "
                    "like \u201cwhat did I read about sqlite today?\u201d")
        return (f"Hi — I'm your Twin-Brain. I'm holding {s['pages']:,} pages from "
                f"{s['domains']:,} sites ({s['total_words']:,} words of your actual "
                f"reading). Ask me what you read, when, or for the link back.\n\n"
                f"Try: \u201cwhat did I read yesterday?\u201d \u00b7 \u201cfind that pasta recipe\u201d \u00b7 "
                f"\u201cwhat are my top interests?\u201d")

    def _no_match(self, query: str, result: Any, near_miss: Any,
                  web_results: list[dict] | None) -> str:
        from .. import db

        parts = ["I don't have anything in your history matching that."]
        if result is not None and getattr(result, "time_label", None):
            parts[0] = (f"I don't have anything in your history matching that "
                        f"(I only looked at {result.time_label}).")
        total = db.query_one("SELECT COUNT(*) AS c FROM pages")
        if not total or not total["c"]:
            parts.append("My memory is empty right now — capture may be paused, or the "
                         "extension hasn't sent anything yet. Check the toolbar icon.")
            return " ".join(parts)

        if near_miss is not None and getattr(near_miss, "matches", None):
            m = near_miss.matches[0]
            parts.append(
                f"Outside that window, the closest page I have is \u201c{m.title}\u201d on "
                f"{pretty_domain(m.domain)}, visited {human_time(m.visited_at)} — "
                f"{m.url}"
            )
        else:
            top = db.query(
                "SELECT title, domain, url, COALESCE(last_visited_at, visited_at) AS v "
                "FROM pages WHERE ai_visible=1 ORDER BY v DESC LIMIT 3")
            if top:
                recent = "; ".join(f"\u201c{truncate(r['title'] or r['url'], 60)}\u201d "
                                   f"({pretty_domain(r['domain'] or '')}, {human_time(r['v'])})"
                                   for r in top)
                parts.append(f"My most recent memories are: {recent}.")
        parts.append("Want me to widen the time range, or search the web instead?")
        return " ".join(parts)

    def _compose(self, query: str, result: Any, intent: Any, style: str) -> str:
        matches = result.matches
        best = matches[0]
        when = human_time(best.visited_at)
        site = pretty_domain(best.domain)
        title = truncate(best.title or best.url, 110)

        # -- explicit link/lookup intents --------------------------------
        if intent.name in ("links", "recall") or intent.wants_links:
            no_text = best.word_count <= 0
            head = (f"You looked at \u201c{title}\u201d on {site}, {when}"
                    f" ({(best.visited_at or '')[:10]}).")
            if best.dwell_seconds:
                head += f" You spent {format_dwell(best.dwell_seconds)} on it"
                if best.visit_count > 1:
                    head += f", across {best.visit_count} visits"
            head += "."
            if no_text:
                head += " I saved the link but couldn't read the page content."
            else:
                quote_source = list(getattr(best, "sentences", None) or [])
                quote = quote_source[0] if quote_source else (best.excerpt or "")
                line = _clean_sentence(_first_sentence(quote, 260))
                if line:
                    head += f" It says: \u201c{line}\u201d"
            lines = [head, "", f"Link: {best.url}"]
            others = [m for m in matches[1:] if m.relevance >= best.relevance * 0.72][:3]
            if others:
                lines.append("")
                lines.append("Also in your history:")
                for m in others:
                    lines.append(f"  \u2022 \u201c{truncate(m.title or m.url, 80)}\u201d — "
                                 f"{pretty_domain(m.domain)}, {human_time(m.visited_at)} — {m.url}")
            return "\n".join(lines)

        # -- substantive question ----------------------------------------
        lead = (f"From your own history, the strongest match is \u201c{title}\u201d on {site}, "
                f"visited {when}.")
        body_lines: list[str] = []
        seen_keys: list[str] = []
        per_page = 3 if style == "detailed" else 2
        max_lines = 5 if style == "detailed" else 3
        # A page may only be QUOTED if it is genuinely relevant to the question.
        # Everything else is still offered as a link, but never paraphrased into
        # the answer — quoting a weak match is how an answer starts looking made up.
        quote_floor = max(0.50, best.relevance * 0.62)
        quoted: list[Any] = []
        listed: list[Any] = []
        for m in matches[:5]:
            (quoted if m.relevance >= quote_floor else listed).append(m)
        used = 0
        for i, m in enumerate(quoted[:4 if style == "detailed" else 3], start=1):
            if m.word_count <= 0:
                continue
            # Prefer whole sentences taken from the page; fall back to slicing the
            # retrieved chunk when the page text is not available.
            source = list(getattr(m, "sentences", None) or [])
            if not source:
                source = _sentences(m.excerpt, m.snippets, query, limit=per_page)
            for sent in source[:per_page]:
                text = _clean_sentence(sent)
                if len(text) < 40:
                    continue
                key = _norm(text)
                if any(key in existing or existing in key for existing in seen_keys):
                    continue
                seen_keys.append(key)
                body_lines.append(f"{text} [{i}]")
                used += 1
                if used >= max_lines:
                    break
            if used >= max_lines:
                break

        parts = [lead]
        if body_lines:
            parts.append("")
            parts.append("What your pages actually say:")
            parts.extend(f"  \u2022 {line}" for line in body_lines)
        else:
            parts.append("I have those pages saved but not enough readable text from them "
                         "to answer the question itself.")

        if best.relevance < 0.34:
            parts.append("")
            parts.append("That's a weak match — treat it as a lead, not an answer.")

        others = [m for m in listed if m.page_id != best.page_id][:3]
        if not others:
            others = [m for m in quoted[1:] if m.page_id != best.page_id][:3]
        if others and (style == "detailed" or intent.name in ("compare",) or listed):
            parts.append("")
            parts.append("Related pages you visited (not quoted above):" if listed
                         else "Related pages you visited:")
            for m in others:
                parts.append(f"  \u2022 \u201c{truncate(m.title or m.url, 70)}\u201d — "
                             f"{pretty_domain(m.domain)}, {human_time(m.visited_at)} — {m.url}")
        elif matches and result.matches[0].url:
            parts.append("")
            parts.append(f"Link: {best.url}")
        return "\n".join(parts)

    def _web_section(self, web_results: list[dict]) -> str:
        lines = ["From the web (searched just now — this is NOT from your history):"]
        for i, r in enumerate(web_results[:4], start=1):
            title = truncate(r.get("title") or r.get("url") or "", 90)
            snippet = _clean_sentence(truncate(r.get("snippet") or "", 200))
            source = pretty_domain(_domain_of(r.get("url") or "")) or r.get("source") or "web"
            lines.append(f"  [W{i}] {title} — {source}" + (f": {snippet}" if snippet else ""))
            if r.get("url"):
                lines.append(f"       {r['url']}")
        lines.append("Say the word and I'll save any of these into your memory.")
        return "\n".join(lines)


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (text or "").lower()).strip()


def _sentences(excerpt: str, snippets: list[str], query: str, limit: int = 3) -> list[str]:
    """Distinct sentences from a page, most relevant first, in document order.

    The excerpt and the chunk snippets overlap heavily (the excerpt is often a
    slice of a snippet), so containment de-duplication matters more than exact
    matching here — otherwise the same sentence appears twice in one answer.
    """
    pool: list[str] = []
    norms: list[str] = []
    for src in [excerpt, *(snippets or [])]:
        if not src:
            continue
        for sent in _SENT_SPLIT.split(re.sub(r"\s+", " ", src).strip()):
            sent = sent.strip()
            if len(sent) < 40:
                continue
            key = _norm(sent)
            if not key:
                continue
            if any(key in existing or existing in key for existing in norms):
                continue
            pool.append(sent)
            norms.append(key)
    if not pool:
        return []
    from ..text import content_words

    q = set(content_words(query))
    if q:
        ranked = sorted(range(len(pool)),
                        key=lambda i: -len(q & set(content_words(pool[i]))))
        picks = sorted(ranked[:limit])          # back to document order
    else:
        picks = list(range(min(limit, len(pool))))
    return [pool[i] for i in picks]


def _domain_of(url: str) -> str:
    from ..text import domain_of

    return domain_of(url or "")


def compose_fallback(query: str, result: Any, *, web_results: list[dict] | None = None,
                     near_miss: Any = None, style: str = "concise") -> LLMResponse:
    """Used by API providers when their call fails — same guarantees."""
    engine = ExtractiveLLM()
    resp = engine.answer(query, result, web_results=web_results, style=style,
                         near_miss=near_miss)
    resp.provider = "extractive(fallback)"
    return resp


__all__ = ["ExtractiveLLM", "compose_fallback"]
