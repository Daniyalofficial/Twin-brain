"""Dependency-free HTML -> readable text (server side).

The extension uses its own JS extractor on the live DOM (much better: computed
styles, lazy content, reader-mode heuristics). This Python version is used by
the backend when it fetches a web page during enrichment, so the knowledge it
grows lands in the same clean shape as everything else in memory.
"""

from __future__ import annotations

import html as html_lib
import re
from urllib.parse import urljoin, urlsplit

from .text import clean_text

_SCRIPT_STYLE = re.compile(
    r"<(script|style|noscript|template|svg|iframe|form|nav|footer|header|aside|"
    r"button|select|option)\b[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL)
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_BLOCK_END = re.compile(r"</(p|div|li|h[1-6]|section|article|tr|blockquote|pre|figcaption)>",
                        re.IGNORECASE)
_BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_META_DESC = re.compile(
    r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"'](.*?)[\"']", re.IGNORECASE)
_META_DESC2 = re.compile(
    r"<meta[^>]+content=[\"'](.*?)[\"'][^>]+name=[\"']description[\"']", re.IGNORECASE)
_OG_TITLE = re.compile(
    r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"'](.*?)[\"']", re.IGNORECASE)
_CANONICAL = re.compile(r"<link[^>]+rel=[\"']canonical[\"'][^>]+href=[\"'](.*?)[\"']",
                        re.IGNORECASE)
_ARTICLE = re.compile(r"<article\b[^>]*>(.*?)</article>", re.IGNORECASE | re.DOTALL)
_MAIN = re.compile(r"<main\b[^>]*>(.*?)</main>", re.IGNORECASE | re.DOTALL)
_H1 = re.compile(r"<h1\b[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_HEADING = re.compile(r"<h([1-6])\b[^>]*>(.*?)</h\1>", re.IGNORECASE | re.DOTALL)
_LINKISH = re.compile(r"<a\b[^>]*>", re.IGNORECASE)
_TIME = re.compile(r"<time\b[^>]*datetime=[\"']([^\"']+)[\"']", re.IGNORECASE)
_PARA = re.compile(r"<p\b[^>]*>(.*?)</p>", re.IGNORECASE | re.DOTALL)


def _strip_tags(fragment: str) -> str:
    text = _BR.sub("\n", fragment)
    text = _BLOCK_END.sub("\n", text)
    text = _TAG.sub(" ", text)
    return html_lib.unescape(text)


def extract_title(markup: str, url: str = "") -> str:
    for pattern in (_OG_TITLE, _TITLE):
        m = pattern.search(markup or "")
        if m:
            title = clean_text(_strip_tags(m.group(1)), max_chars=300).strip()
            if title:
                # drop the common " | Site Name" tail
                title = re.split(r"\s+[|\u2013\u2014-]\s+[A-Za-z0-9 .&']{2,40}$", title)[0]
                return title.strip(" -|")
    if url:
        slug = urlsplit(url).path.rstrip("/").split("/")[-1]
        if slug:
            return slug.replace("-", " ").replace("_", " ").replace("%20", " ").title()
    return ""


def extract_meta(markup: str, url: str = "") -> dict:
    out: dict[str, str] = {}
    m = _META_DESC.search(markup or "") or _META_DESC2.search(markup or "")
    if m:
        out["description"] = clean_text(_strip_tags(m.group(1)), 400)
    c = _CANONICAL.search(markup or "")
    if c:
        out["canonical"] = urljoin(url, html_lib.unescape(c.group(1).strip()))
    t = _TIME.search(markup or "")
    if t:
        out["published"] = t.group(1).strip()
    return out


def extract_text(markup: str, url: str = "", max_chars: int = 120_000) -> str:
    """Readability-style main-content extraction with no dependencies."""
    if not markup:
        return ""
    body = markup
    m = re.search(r"<body\b[^>]*>(.*)</body>", markup, re.IGNORECASE | re.DOTALL)
    if m:
        body = m.group(1)
    body = _COMMENT.sub(" ", body)
    body = _SCRIPT_STYLE.sub(" ", body)
    body = re.sub(r"<(header|footer|nav|aside)\b[^>]*>.*?</\1>", " ", body,
                  flags=re.IGNORECASE | re.DOTALL)

    # Prefer the semantic main region when it carries most of the text.
    candidates: list[str] = []
    for pattern in (_ARTICLE, _MAIN):
        for match in pattern.findall(body):
            text = clean_text(_strip_tags(match), max_chars)
            if len(text) > 300:
                candidates.append(text)
    if candidates:
        best = max(candidates, key=len)
        full = clean_text(_strip_tags(body), max_chars)
        # only trust the region when it is a substantial share of the page
        if len(best) >= 0.35 * len(full):
            return best

    # Otherwise: keep paragraphs + list items, which is where prose lives.
    pieces: list[str] = []
    for match in _PARA.finditer(body):
        text = clean_text(_strip_tags(match.group(1)), 6000).strip()
        if len(text) >= 60:
            pieces.append(text)
    if pieces:
        joined = "\n\n".join(pieces)
        if len(joined) >= 400:
            return clean_text(joined, max_chars)

    # Last resort: headings preserved inline, everything else stripped.
    with_headings = _HEADING.sub(lambda m: f"\n\n{clean_text(_strip_tags(m.group(2)), 300)}\n",
                                 body)
    return clean_text(_strip_tags(with_headings), max_chars)


def extract_headings(markup: str, limit: int = 12) -> list[str]:
    out: list[str] = []
    for _, inner in _HEADING.findall(markup or "")[:limit * 2]:
        text = clean_text(_strip_tags(inner), 200).strip()
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def extract_links(markup: str, base_url: str = "", limit: int = 60) -> list[dict]:
    links: list[dict] = []
    seen: set[str] = set()
    for m in re.finditer(r"<a\b[^>]*href=[\"']([^\"'#]+)[\"'][^>]*>(.*?)</a>",
                         markup or "", re.IGNORECASE | re.DOTALL):
        href = html_lib.unescape(m.group(1)).strip()
        if href.startswith(("javascript:", "mailto:", "tel:", "data:")):
            continue
        absolute = urljoin(base_url, href) if base_url else href
        if absolute in seen or not absolute.startswith("http"):
            continue
        text = clean_text(_strip_tags(m.group(2)), 160).strip()
        seen.add(absolute)
        links.append({"url": absolute, "text": text})
        if len(links) >= limit:
            break
    return links


def extract_page(markup: str, url: str = "") -> dict:
    """One call -> everything the capture pipeline needs."""
    meta = extract_meta(markup, url)
    title = extract_title(markup, url)
    text = extract_text(markup, url)
    return {
        "url": meta.get("canonical") or url,
        "title": title,
        "text": text,
        "description": meta.get("description", ""),
        "published": meta.get("published", ""),
        "headings": extract_headings(markup),
        "bytes": len(markup or ""),
    }


def looks_like_html(text: str) -> bool:
    head = (text or "")[:1200].lower()
    return "<html" in head or "<!doctype html" in head or "<body" in head
