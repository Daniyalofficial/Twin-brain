"""Text utilities: URL normalisation, cleaning, chunking, keywords, summaries.

Everything here is deterministic and dependency-free — the same functions are
used by the capture pipeline, the retrieval engine and the offline answer
composer, so what gets indexed is exactly what gets quoted.
"""

from __future__ import annotations

import hashlib
import math
import re
import time
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# ---------------------------------------------------------------------------
# URLs & domains
# ---------------------------------------------------------------------------

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "utm_id", "fbclid", "gclid", "dclid", "msclkid", "igshid", "mc_cid",
    "mc_eid", "yclid", "twclid", "ttclid", "vero_id", "mkt_tok", "ref",
    "ref_src", "referrer", "source", "pk_campaign", "pk_kwd", "s_cid",
    "spm", "scm", "share_token", "si", "feature", "app", "ncid",
}

# Common second-level public suffixes (enough for a registrable-domain guess
# without shipping the full PSL; used only for grouping in the UI).
MULTI_PART_SUFFIXES = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
    "com.au", "net.au", "org.au", "gov.au", "edu.au", "asn.au", "id.au",
    "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in", "firm.in",
    "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
    "co.za", "org.za", "web.za", "gov.za", "net.za",
    "com.br", "net.br", "org.br", "gov.br", "edu.br",
    "com.mx", "org.mx", "gob.mx", "edu.mx", "net.mx",
    "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
    "com.tr", "org.tr", "gov.tr", "net.tr", "edu.tr",
    "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
    "com.hk", "org.hk", "gov.hk", "edu.hk",
    "co.kr", "or.kr", "go.kr", "ne.kr",
    "com.ar", "net.ar", "org.ar", "gob.ar",
    "com.pk", "net.pk", "org.pk", "gov.pk", "edu.pk",
    "com.ua", "org.ua", "net.ua", "gov.ua", "edu.ua",
    "com.pl", "net.pl", "org.pl", "gov.pl",
    "com.ru", "net.ru", "org.ru",
    "com.sa", "org.sa", "gov.sa", "net.sa",
    "com.eg", "org.eg", "gov.eg", "edu.eg",
    "co.id", "web.id", "or.id", "go.id", "ac.id",
    "com.ph", "net.ph", "org.ph", "gov.ph", "edu.ph",
    "com.ng", "org.ng", "gov.ng", "edu.ng",
    "com.bd", "org.bd", "net.bd", "gov.bd", "edu.bd",
}


def normalize_url(url: str) -> str:
    """Canonicalise a URL for dedup: drop fragments + tracking params."""
    if not url:
        return ""
    url = url.strip()
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.scheme:
        try:
            parts = urlsplit("https://" + url)
        except ValueError:
            return url
    scheme = "https" if parts.scheme in ("http", "https") else parts.scheme
    host = (parts.hostname or "").lower()
    port = parts.port
    netloc = host
    if port and not (scheme == "https" and port == 443) and not (scheme == "http" and port == 80):
        netloc = f"{host}:{port}"
    path = parts.path or "/"
    path = re.sub(r"/{2,}", "/", path)
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    # drop tracking params, keep meaningful ones, stable order
    try:
        pairs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if k.lower() not in TRACKING_PARAMS and not k.startswith("utm_")]
    except ValueError:
        pairs = []
    pairs.sort()
    query = urlencode(pairs)
    return urlunsplit((scheme, netloc, path, query, ""))


def url_hash(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode("utf-8", "replace")).hexdigest()[:20]


def domain_of(url: str) -> str:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""
    return host.lstrip(".")


def registrable_domain(host: str) -> str:
    host = (host or "").lower().lstrip(".")
    if not host or re.fullmatch(r"[\d.]+", host):
        return host
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if ".".join(labels[-2:]) in MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def is_private_url(url: str) -> bool:
    """Local / non-web URLs that carry no public knowledge."""
    host = domain_of(url)
    if not host:
        return True
    scheme = (urlsplit(url).scheme or "").lower()
    if scheme in {"chrome", "chrome-extension", "about", "edge", "moz-extension",
                  "devtools", "file", "view-source", "data", "blob", "javascript"}:
        return True
    return host in {"localhost", "127.0.0.1", "0.0.0.0", "::1", "newtab", ""} or host.endswith(".local")


def pretty_domain(domain: str) -> str:
    return (domain or "").replace("www.", "")


# ---------------------------------------------------------------------------
# cleaning
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"[ \t\r\f\v]+")
_BLANK_RE = re.compile(r"\n{3,}")
_NOISE_LINE_RE = re.compile(
    r"^\s*(subscribe|sign up|log ?in|newsletter|advertisement|sponsored|"
    r"share this|follow us|related (posts|articles|stories)|leave a (comment|reply)|"
    r"cookie (policy|notice)|terms of (use|service)|privacy policy|"
    r"(read|views?):?\s*\d|\d+\s*(views|shares|comments)|"
    r"copyright|all rights reserved|skip to (content|main)|"
    r"table of contents|continue reading|show more)\b[\s!:.|]*$",
    re.IGNORECASE,
)


def clean_text(raw: str, max_chars: int = 200_000) -> str:
    """Normalise extracted page text into tidy paragraphs."""
    if not raw:
        return ""
    text = unicodedata.normalize("NFKC", raw)
    text = text.replace("\u00a0", " ").replace("\u200b", "").replace("\ufeff", "")
    text = re.sub(r"[‘’ʼ]", "'", text)
    text = re.sub(r"[“”]", '"', text)
    text = re.sub(r"[–—]", "-", text)
    text = re.sub(r"…", "...", text)
    lines_out: list[str] = []
    for line in text.split("\n"):
        line = _WS_RE.sub(" ", line).strip()
        if not line:
            lines_out.append("")
            continue
        if _NOISE_LINE_RE.match(line):
            continue
        lines_out.append(line)
    text = "\n".join(lines_out)
    text = _unwrap_hard_wraps(text)
    text = _BLANK_RE.sub("\n\n", text).strip()
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0]
    return text


_LIST_START_RE = re.compile(r'^\s*(?:[-*\u2022\u25aa\u25cf\u00b7]|\d{1,3}[.)]|[ivxIVX]{1,5}[.)]|#{1,6}\s)')
_SENTENCE_END_RE = re.compile(r'''[.!?:;\"\u2019\u201d')\]]\s*$''')


def _unwrap_hard_wraps(text: str) -> str:
    """Rejoin lines that were wrapped mid-sentence.

    Extracted page text (and any pasted/imported text) often arrives hard-wrapped
    at ~80 columns. Without this, every line break looks like a sentence
    boundary and summaries come out as fragments like "...load them into numpy
    and compute cosine".

    Only merges on the classic hard-wrap signature: previous line ends with a
    lowercase letter or comma, next line starts lowercase, and neither is a list
    item or heading.
    """
    out: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            out.append("")
            continue
        if out and out[-1]:
            prev = out[-1]
            prev_tail = prev[-1]
            starts_lower = stripped[0].islower()
            ends_wrapped = (prev_tail.islower() and prev_tail.isalpha()) or prev_tail in ",;-"
            is_listish = bool(_LIST_START_RE.match(stripped)) or bool(_LIST_START_RE.match(prev))
            if ends_wrapped and starts_lower and not is_listish and not _SENTENCE_END_RE.search(prev[-1:]):
                out[-1] = prev + " " + stripped
                continue
        out.append(stripped)
    return "\n".join(out)


STOPWORDS = frozenset("""
a about above after again against all am an and any are aren as at be because been before being
below between both but by can cannot could couldn did didn do does doesn doing don down during
each few for from further had hadn has hasn have haven having he her here hers herself him himself
his how i if in into is isn it its itself just let like made make many may me might mine more most
must my myself never no nor not now of off on once only or other ought our ours ourselves out over
own said same shan she should shouldn so some such than that the their theirs them themselves then
there these they this those through to too under until up upon us use used using very was wasn we
were weren what when where which while who whom why will with within won would wouldn you your
yours yourself yourselves also get got one two three new via per etc will can't dont isn't aren't
it's that's there's i'm you're we're they're he's she's let's oh hey hi vs etc across around behind
beside among along toward towards upon whether whatever whoever whenever wherever whichever
""".split())

# Words that describe the REQUEST rather than the TOPIC. Letting these drive
# matching is how "what did I read about embeddings last week" ends up citing a
# page just because it happens to contain the word "last". They stay in the
# documents (so real content is never hidden), but they are stripped from the
# query before lexical scoring and embedding.
REQUEST_WORDS = frozenset("""
read reads reading readed looked look looking looks find finds found give gives gave
show shows showed tell tells told know knows knew remember remembered forget forgot
page pages link links url urls article articles site sites website websites post posts
video videos thing things stuff best good great nice top open opened visit visited
visits browse browsed browsing search searched searches history memory memories
yesterday today tonight tomorrow morning afternoon evening night week weeks weekend
month months year years day days hour hours minute minutes second seconds last recent
recently lately ago new old something anything everything info information details
detail summary summaries summarise summarize explain explained please help way ways
kind sorts sort type types list listed many much lot lots few couple one two three
first second third also another other others mine my your you me us them they it its
that this these those was were is are am be been do does did have has had can could
should would will shall may might must about into onto over under between among with
without from for and or but if then than so such very really actually just only even
still yet again once ever never always sometimes often usually probably maybe perhaps
certainly sure surely wanted want need needed using used use uses make made get got
go goes went come came see saw seen put take took
""".split())

MATCH_STOPWORDS = STOPWORDS | REQUEST_WORDS

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9'+#.-]*", re.UNICODE)
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9])|(?<=\n)")


def tokenize(text: str) -> list[str]:
    if not text:
        return []
    return _TOKEN_RE.findall(text.lower())


def content_words(text: str) -> list[str]:
    return [t for t in tokenize(text)
            if t not in STOPWORDS and len(t) > 2 and not t.isdigit()]


def topic_words(query: str) -> list[str]:
    """The words in a query that actually describe the topic being asked about."""
    out: list[str] = []
    for tok in tokenize(query or ""):
        if tok in MATCH_STOPWORDS or len(tok) < 3 or tok.isdigit():
            continue
        if tok not in out:
            out.append(tok)
    return out


def clean_query_for_matching(query: str) -> str:
    """Query text used for embedding / lexical matching (request words removed).

    Falls back to the original when stripping leaves nothing, so a query that is
    only request words still gets a chance instead of embedding the empty string.
    """
    words = topic_words(query)
    return " ".join(words) if words else (query or "").strip()


def word_count(text: str) -> int:
    return len(text.split()) if text else 0


# ---------------------------------------------------------------------------
# chunking
# ---------------------------------------------------------------------------


def split_sentences(text: str) -> list[str]:
    if not text:
        return []
    parts = [s.strip() for s in _SENT_SPLIT_RE.split(text) if s and s.strip()]
    out: list[str] = []
    for part in parts:
        # keep chunks bounded even if a "sentence" is a whole paragraph
        while len(part) > 1200:
            cut = part.rfind(" ", 0, 1200)
            cut = cut if cut > 400 else 1200
            out.append(part[:cut].strip())
            part = part[cut:].strip()
        if part:
            out.append(part)
    return out


def chunk_text(text: str, target_chars: int = 900, overlap_chars: int = 120,
               max_chunks: int = 60) -> list[dict]:
    """Sentence-aware chunks with a small overlap so context survives the cut."""
    if not text:
        return []
    sentences = split_sentences(text)
    if not sentences:
        return [{"text": text[:target_chars], "idx": 0, "char_start": 0, "char_end": len(text)}]

    chunks: list[dict] = []
    buf: list[str] = []
    buf_len = 0
    start = 0
    cursor = 0
    for sent in sentences:
        slen = len(sent) + 1
        if buf and buf_len + slen > target_chars:
            body = " ".join(buf).strip()
            chunks.append({"text": body, "idx": len(chunks), "char_start": start,
                           "char_end": min(len(text), cursor)})
            if len(chunks) >= max_chunks:
                break
            # overlap: carry the tail of the previous chunk
            tail = body[-overlap_chars:]
            cut = tail.find(" ")
            tail = tail[cut + 1:] if cut > 0 else tail
            buf = [tail] if tail else []
            buf_len = len(tail)
            start = max(0, cursor - len(tail))
        buf.append(sent)
        buf_len += slen
        cursor += slen
    if buf and len(chunks) < max_chunks:
        body = " ".join(buf).strip()
        if body:
            chunks.append({"text": body, "idx": len(chunks), "char_start": start,
                           "char_end": min(len(text), cursor)})
    return [c for c in chunks if len(c["text"].strip()) >= 40]


def excerpt(text: str, max_chars: int = 400) -> str:
    if not text:
        return ""
    text = text.strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    sp = cut.rfind(" ")
    if sp > max_chars * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:-") + "..."


# ---------------------------------------------------------------------------
# keywords / topics
# ---------------------------------------------------------------------------


def term_freq(words: list[str]) -> dict[str, int]:
    freq: dict[str, int] = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1
    return freq


def keywords(text: str, top_n: int = 12, title: str = "") -> list[tuple[str, float]]:
    """Sublinear-TF keyword scores, boosted by appearance in the title."""
    words = content_words(text)
    if not words:
        return []
    freq = term_freq(words)
    total = len(words)
    title_words = set(content_words(title))
    scored: list[tuple[str, float]] = []
    for term, count in freq.items():
        if count < 2 and term not in title_words:
            continue
        score = (1 + math.log(count)) * math.log(1 + total / (count + 1)) ** 0.15
        if term in title_words:
            score *= 1.8
        scored.append((term, score))
    scored.sort(key=lambda kv: (-kv[1], kv[0]))
    # drop near-duplicates (one term contained in another with similar score)
    out: list[tuple[str, float]] = []
    for term, score in scored:
        if any((term in o or o in term) and abs(score - s) / max(score, 1e-6) < 0.35
               for o, s in out):
            continue
        out.append((term, score))
        if len(out) >= top_n:
            break
    return out


def bigrams(text: str, top_n: int = 8, min_count: int = 2) -> list[str]:
    words = [w for w in tokenize(text) if w not in STOPWORDS and len(w) > 2]
    counts: dict[str, int] = {}
    for a, b in zip(words, words[1:]):
        key = f"{a} {b}"
        counts[key] = counts.get(key, 0) + 1
    ranked = sorted(((c, k) for k, c in counts.items() if c >= min_count), reverse=True)
    return [k for _, k in ranked[:top_n]]


# ---------------------------------------------------------------------------
# extractive summarisation (used for page summaries + offline answers)
# ---------------------------------------------------------------------------


def _sentence_scores(sentences: list[str], query_terms: set[str] | None = None) -> list[float]:
    docs = [set(content_words(s)) for s in sentences]
    df: dict[str, int] = {}
    for d in docs:
        for w in d:
            df[w] = df.get(w, 0) + 1
    n = max(1, len(docs))
    scores: list[float] = []
    for i, d in enumerate(docs):
        if not d:
            scores.append(0.0)
            continue
        s = 0.0
        for w in d:
            idf = math.log((n + 1) / (df.get(w, 0) + 0.5))
            s += max(0.0, idf)
            if query_terms and w in query_terms:
                s += 2.5 * max(0.4, idf)
        # prefer mid-length sentences, and earlier ones slightly (lead bias)
        length = len(sentences[i].split())
        length_penalty = 1.0 if 6 <= length <= 45 else 0.55
        lead = 1.0 + 0.35 * math.exp(-i / 6.0)
        scores.append(s / math.sqrt(len(d)) * length_penalty * lead)
    return scores


def extractive_summary(text: str, sentences: int = 3, query: str = "", max_chars: int = 600) -> str:
    """A short, faithful summary made only of sentences that exist in the page."""
    if not text:
        return ""
    sents = split_sentences(text)
    if not sents:
        return excerpt(text, max_chars)
    if len(sents) <= sentences:
        return excerpt(" ".join(sents), max_chars)
    qterms = set(content_words(query)) if query else None
    scores = _sentence_scores(sents, qterms)
    order = sorted(range(len(sents)), key=lambda i: -scores[i])[:sentences * 2]
    picked = sorted(order[:sentences])
    out = " ".join(sents[i].strip() for i in picked)
    return excerpt(out, max_chars)


def best_sentences(text: str, query: str, n: int = 3, max_chars: int = 700) -> list[str]:
    """The sentences from `text` most relevant to `query` (for grounded answers)."""
    sents = split_sentences(text)
    if not sents:
        return []
    if len(sents) <= n:
        return sents[:n]
    qterms = set(content_words(query))
    if not qterms:
        return sents[:n]
    scores = _sentence_scores(sents, qterms)
    ranked = sorted(range(len(sents)), key=lambda i: -scores[i])
    picked = sorted(ranked[:n])
    out: list[str] = []
    used = 0
    for i in picked:
        s = sents[i].strip()
        if used + len(s) > max_chars and out:
            break
        out.append(s)
        used += len(s)
    return out


def overlap_score(text: str, query: str) -> float:
    """Cheap lexical relevance in [0,1] — used to sanity-check embeddings."""
    q = set(content_words(query))
    if not q:
        return 0.0
    t = set(content_words(text))
    if not t:
        return 0.0
    hit = len(q & t)
    return hit / math.sqrt(len(q)) * 0.7 + (hit / len(q)) * 0.3


# ---------------------------------------------------------------------------
# language + time phrases
# ---------------------------------------------------------------------------


def detect_lang(text: str) -> str:
    sample = (text or "")[:2000].lower()
    if not sample:
        return "unknown"
    markers = {
        "en": (" the ", " and ", " of ", " to "),
        "es": (" el ", " la ", " los ", " de ", " que ", " un "),
        "fr": (" le ", " la ", " des ", " est ", " une "),
        "de": (" der ", " die ", " das ", " und ", " ist "),
        "pt": (" o ", " os ", " uma ", " com ", " não "),
        "it": (" il ", " la ", " che ", " di "),
        "hi": (" का ", " की ", " है "),
        "ur": (" کا ", " کی ", " ہے "),
        "ar": (" من ", " في ", " على "),
    }
    best, best_score = "en", -1.0
    padded = " " + sample + " "
    for lang, toks in markers.items():
        score = sum(padded.count(t) for t in toks)
        if score > best_score:
            best, best_score = lang, score
    return best if best_score > 0 else "en"


TIME_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(yesterday|last night)\b", re.I), "yesterday"),
    (re.compile(r"\btoday\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b", re.I), "today"),
    (re.compile(r"\btonight\b", re.I), "today"),
    (re.compile(r"\b(last|this past)\s+(week|7 days)\b", re.I), "week"),
    (re.compile(r"\b(this week)\b", re.I), "week"),
    (re.compile(r"\b(last|this past)\s+(month|30 days)\b", re.I), "month"),
    (re.compile(r"\b(this month)\b", re.I), "month"),
    (re.compile(r"\b(last|this)\s+(year)\b", re.I), "year"),
    (re.compile(r"\b(\d{1,3})\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago\b", re.I), "n_ago"),
    (re.compile(r"\b(recently|lately)\b", re.I), "month"),
]


def time_window_from_query(query: str) -> tuple[float | None, float | None, str | None]:
    """Map natural time phrases to a (start, end) epoch window.

    Returns (None, None, None) when the query has no time constraint.
    """
    if not query:
        return None, None, None
    now = time.time()
    day = 86400.0

    m = re.search(r"\b(\d{1,3})\s+(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago\b",
                  query, re.I)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        mult = {"minute": 60, "minutes": 60, "min": 60, "mins": 60,
                "hour": 3600, "hours": 3600, "hr": 3600, "hrs": 3600,
                "day": day, "days": day, "week": 7 * day, "weeks": 7 * day,
                "month": 30 * day, "months": 30 * day}.get(unit, day)
        span = max(3600.0, n * mult)
        return now - span, None, f"last {n} {unit}"

    local = time.localtime(now)
    midnight = time.mktime((local.tm_year, local.tm_mon, local.tm_mday, 0, 0, 0, 0, 0, -1))

    for pattern, label in TIME_PATTERNS:
        if not pattern.search(query):
            continue
        if label == "yesterday":
            return midnight - day, midnight, "yesterday"
        if label == "today":
            return midnight, None, "today"
        if label == "week":
            return now - 7 * day, None, "last 7 days"
        if label == "month":
            return now - 30 * day, None, "last 30 days"
        if label == "year":
            return now - 365 * day, None, "last year"
    return None, None, None


# ---------------------------------------------------------------------------
# formatting helpers shared by the API / LLM / UI
# ---------------------------------------------------------------------------


def human_time(iso_or_epoch) -> str:
    if not iso_or_epoch:
        return ""
    try:
        if isinstance(iso_or_epoch, (int, float)):
            ts = float(iso_or_epoch)
        else:
            ts = time.mktime(time.strptime(str(iso_or_epoch)[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (ValueError, OverflowError):
        return str(iso_or_epoch)
    delta = time.time() - ts
    if delta < 60:
        return "just now"
    if delta < 3600:
        return f"{int(delta // 60)} min ago"
    if delta < day_secs():
        return f"{int(delta // 3600)} h ago"
    if delta < 7 * day_secs():
        return f"{int(delta // day_secs())} d ago"
    return time.strftime("%b %d, %Y", time.localtime(ts))


def day_secs() -> float:
    return 86400.0


def format_dwell(seconds: float | int | None) -> str:
    s = int(seconds or 0)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s" if s % 60 else f"{s // 60}m"
    return f"{s // 3600}h {(s % 3600) // 60}m"


def truncate(text: str, n: int) -> str:
    """Cut to ~n chars on a word boundary (never mid-word)."""
    text = text or ""
    if len(text) <= n:
        return text
    cut = text[:n]
    space = cut.rfind(" ")
    if space > n * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,;:.-(\u201c'") + "..."


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8", "replace")).hexdigest()[:24]
