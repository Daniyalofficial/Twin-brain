"""Query intent classification (deterministic, inspectable rules).

Used to (a) pick the answer shape in the offline engine, (b) route meta
questions ("what are my interests?", "what did I read today?") to real data
instead of an LLM, and (c) decide whether a backend web search is worth
spending budget on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

INTENTS = (
    "meta_interests", "meta_stats", "meta_digest", "meta_timeline", "meta_domains",
    "links", "recall", "compare", "howto", "question", "greeting",
)

_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("meta_interests", re.compile(
        r"\b(my|the)\s+(top\s+)?(interests?|topics|habits?|patterns?)\b|"
        r"\bwhat\s+(do|am)\s+i\s+(like|interested|into)\b|"
        r"\bwho\s+am\s+i\b|\bprofile\s+me\b|\bunderstand\s+me\b|"
        r"\bwhat\s+kind\s+of\s+(person|programmer|developer)\b|"
        r"\bam\s+i\s+(a|an|into|like)\b|"
        r"\bdo\s+i\s+like\b|\bwhat\s+are\s+my\s+(skills|strengths)\b|"
        r"\bmy\s+(personality|persona)\b", re.I)),
    ("meta_stats", re.compile(
        r"\bhow\s+many\s+(pages|sites|links|hours|words)\b|"
        r"\b(stats|statistics|numbers|totals?)\b|"
        r"\bhow\s+much\s+time\b|\breading\s+time\b", re.I)),
    ("meta_digest", re.compile(
        r"\b(daily\s+)?(summary|digest|recap|roundup)\b|"
        r"\bwhat\s+did\s+i\s+(read|do|visit|browse|open)\b|"
        r"\btl;?dr\b|\bsummar(y|ise|ize)\s+my\s+(day|week|history|browsing)\b", re.I)),
    ("meta_timeline", re.compile(
        r"\b(show|list)\s+(me\s+)?(my\s+)?(history|timeline|activity|visits)\b|"
        r"\brecent(ly)?\s+(visited|opened|pages)\b|"
        r"\bwhat\s+did\s+i\s+open\b", re.I)),
    ("meta_domains", re.compile(
        r"\b(which|what)\s+(sites|websites|domains)\b|"
        r"\bmy\s+(sites|websites|domains)\b", re.I)),
    ("links", re.compile(
        r"\b(links?|urls?)\b|\bgive\s+me\s+the\b|\bsend\s+(me\s+)?the\s+link\b|"
        r"\bwhere\s+(did|was)\s+(it|i)\b|\bshow\s+me\s+the\s+(page|site|article)\b|"
        r"\bopen\s+(it|the\s+page)\b|\bsaved\s+(links?|pages)\b", re.I)),
    ("recall", re.compile(
        r"\bwhat\s+was\s+that\b|\bwhich\s+(page|article|video|post|site|recipe|repo)\b|"
        r"\bthat\s+(recipe|article|page|video|post|thing|site|tool|library|repo)\b|"
        r"\bi\s+(forgot|forget|can'?t\s+remember)\b|\bdo\s+you\s+remember\b|"
        r"\bfind\s+(that|the|my)\b|\bremember\s+when\b|\bwhat\s+did\s+i\s+(search|look)\b|"
        r"\bwhere\s+did\s+i\s+(read|see|find)\b|\bhave\s+i\s+(read|seen|visited)\b", re.I)),
    ("compare", re.compile(
        r"\b(compare|versus|vs\.?|difference\s+between|better\s+than)\b", re.I)),
    ("howto", re.compile(
        r"\b(how\s+(do|to|can)|steps?\s+to|tutorial|guide\s+(to|for)|explain|"
        r"\bfix\b|\berror\b|\bbug\b|install|setup|configure|debug)\b", re.I)),
]

# "about X" means the user is asking about a TOPIC, not asking for a recap of
# their whole day — that distinction decides between retrieval and the digest.
_ABOUT_TOPIC = re.compile(
    r"\b(about|on|regarding|into|for|related\s+to)\s+[a-z0-9+#][a-z0-9+# .\-]{2,}", re.I)

_GREETING = re.compile(
    r"^\s*(hi|hey|hello|yo|sup|good\s+(morning|evening|afternoon)|"
    r"what'?s\s+up|how\s+are\s+you|thanks|thank\s+you)\s*[!.?]*\s*$", re.I)

_WEB_WORTHY = re.compile(
    r"\b(latest|new|news|update[d]?|recent|today'?s|current|price|release|"
    r"version|cve|documentation|docs|error|fix|solution|how\s+to|tutorial|"
    r"compare|vs\.?|best|20\d\d)\b", re.I)


@dataclass
class Intent:
    name: str = "question"
    is_meta: bool = False
    wants_links: bool = False
    wants_web: bool = False
    time_hint: str | None = None
    topics: list[str] = field(default_factory=list)
    reason: str = ""

    def to_dict(self) -> dict:
        return {"intent": self.name, "is_meta": self.is_meta, "wants_links": self.wants_links,
                "wants_web": self.wants_web, "time_hint": self.time_hint,
                "topics": self.topics, "reason": self.reason}


def classify(query: str) -> Intent:
    q = (query or "").strip()
    if not q:
        return Intent(name="question", reason="empty")
    if len(q) <= 32 and _GREETING.match(q):
        return Intent(name="greeting", reason="greeting")

    hits: list[str] = []
    for name, pattern in _PATTERNS:
        if pattern.search(q):
            hits.append(name)

    has_topic = bool(_ABOUT_TOPIC.search(q)) and not re.search(
        r"\b(my|the)\s+(day|week|history|browsing|activity|interests?|topics)\b", q, re.I)

    name = "question"
    # meta intents win: they are answered from real data, never from an LLM.
    # ...unless the question names a topic ("what did I read ABOUT embeddings") —
    # that is a retrieval question, and answering it with a daily recap is wrong.
    meta_order = ("meta_interests", "meta_stats", "meta_domains")
    if not has_topic:
        meta_order = ("meta_interests", "meta_stats", "meta_digest", "meta_domains",
                      "meta_timeline")
    for candidate in meta_order:
        if candidate in hits:
            name = candidate
            break
    if name == "question":
        for candidate in ("recall", "links", "compare", "howto"):
            if candidate in hits:
                name = candidate
                break

    is_meta = name.startswith("meta_")
    wants_links = ("links" in hits) or name in ("links", "recall", "meta_timeline")
    wants_web = bool(_WEB_WORTHY.search(q)) and not is_meta
    reason = ",".join(hits) or "default"
    if has_topic:
        reason += "+topic"
    return Intent(name=name, is_meta=is_meta, wants_links=wants_links, wants_web=wants_web,
                  topics=[], reason=reason)


def is_question_about_memory(query: str) -> bool:
    """True when the answer should come from the user's own history."""
    intent = classify(query)
    return not intent.is_meta
