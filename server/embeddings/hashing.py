"""Offline hashing embedder — the zero-dependency default.

Not a neural model, and it does not pretend to be. It builds a weighted
multi-resolution bag of features (content unigrams, bigrams, character
n-grams, and a small hand-written concept lexicon) and projects them into a
fixed-width space with signed feature hashing.

What that buys you in practice:
  * "recipe pasta" matches a page about "creamy garlic chicken pasta" even
    when the word "recipe" never appears (concept lexicon + char n-grams).
  * "running" matches "run", "pythonic" matches "python" (morphology via
    character n-grams).
  * Exact phrase matches still dominate (bigram features), so precision stays
    high — and `retrieval.py` fuses this with BM25, which supplies proper
    corpus-level IDF.

Everything is deterministic: the same text always produces the same vector on
any machine, with no downloads, no GPU and no network.
"""

from __future__ import annotations

import hashlib
import math
import re
from functools import lru_cache

from ..text import STOPWORDS, content_words, tokenize
from .base import Embedder

_SALT = b"twinbrain-hash-embedder-v1"
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9'+#.-]*")

# A deliberately small, transparent concept lexicon. Each concept adds a weak
# signal to every feature that belongs to it, so related vocabulary lands
# closer together without any model weights. Extend freely — it is data, not
# magic, and you can read exactly what it does.
CONCEPTS: dict[str, tuple[str, ...]] = {
    "cooking": ("recipe", "recipes", "cook", "cooking", "bake", "baking", "kitchen",
                 "ingredients", "dish", "meal", "dinner", "lunch", "breakfast", "food",
                 "cuisine", "chef", "oven", "pan", "sauce", "tasty", "delicious",
                 "servings", "tablespoon", "teaspoon", "simmer", "saute", "marinate"),
    "programming": ("code", "coding", "program", "programming", "developer", "software",
                     "engineer", "api", "function", "variable", "debug", "compiler",
                     "repository", "commit", "framework", "library", "algorithm",
                     "syntax", "runtime", "backend", "frontend", "script"),
    "python": ("python", "django", "flask", "pandas", "numpy", "pytest", "pip",
                "jupyter", "cpython", "pythonic"),
    "javascript": ("javascript", "typescript", "react", "vue", "node", "nodejs",
                    "npm", "dom", "es6", "jsx", "nextjs", "webpack", "vite"),
    "ai": ("ai", "artificial", "intelligence", "machine", "learning", "neural",
            "model", "llm", "gpt", "transformer", "embedding", "inference",
            "training", "dataset", "prompt", "agent", "rag"),
    "database": ("database", "sql", "sqlite", "postgres", "postgresql", "mysql",
                  "mongo", "mongodb", "index", "query", "schema", "table", "join",
                  "orm", "migration", "nosql"),
    "security": ("security", "vulnerability", "cve", "exploit", "malware", "phishing",
                  "encryption", "tls", "ssl", "authentication", "authorization",
                  "privacy", "breach", "firewall", "ransomware"),
    "health": ("health", "medical", "doctor", "symptom", "symptoms", "treatment",
                "disease", "therapy", "medicine", "clinical", "patient", "diagnosis",
                "nutrition", "vitamin", "exercise", "fitness", "workout"),
    "finance": ("finance", "investing", "investment", "stocks", "stock", "market",
                 "trading", "portfolio", "budget", "savings", "tax", "taxes",
                 "mortgage", "loan", "interest", "inflation", "crypto", "bitcoin"),
    "travel": ("travel", "trip", "flight", "flights", "hotel", "hotels", "airport",
                "visa", "passport", "itinerary", "destination", "tourism", "booking",
                "luggage", "airbnb"),
    "shopping": ("buy", "price", "prices", "deal", "deals", "discount", "sale",
                  "amazon", "shop", "shopping", "cart", "checkout", "order",
                  "delivery", "shipping", "review", "reviews", "best", "cheap"),
    "news": ("news", "breaking", "headline", "report", "reporter", "journalism",
              "press", "article", "update", "politics", "election", "government"),
    "design": ("design", "ui", "ux", "layout", "typography", "color", "colour",
                "figma", "css", "sketch", "wireframe", "branding", "logo"),
    "learning": ("tutorial", "course", "learn", "learning", "guide", "documentation",
                  "docs", "example", "beginner", "advanced", "lesson", "training",
                  "certification", "book", "lecture", "university", "student"),
    "work": ("job", "jobs", "career", "hiring", "interview", "resume", "cv",
              "salary", "remote", "office", "meeting", "project", "manager",
              "freelance", "contract"),
    "music": ("music", "song", "songs", "album", "artist", "band", "guitar",
               "piano", "spotify", "playlist", "concert", "audio", "track"),
    "gaming": ("game", "games", "gaming", "player", "steam", "playstation", "xbox",
                "nintendo", "gameplay", "esports", "quest", "level"),
    "science": ("science", "research", "study", "paper", "physics", "chemistry",
                 "biology", "experiment", "theory", "journal", "scientist", "nasa"),
    "home": ("home", "house", "apartment", "furniture", "garden", "diy", "repair",
              "decor", "kitchen", "bedroom", "cleaning", "renovation"),
    "auto": ("car", "cars", "vehicle", "driving", "engine", "tire", "tyre",
              "ev", "electric", "tesla", "toyota", "honda", "mechanic"),
}

_CONCEPT_OF: dict[str, list[str]] = {}
for _concept, _words in CONCEPTS.items():
    for _w in _words:
        _CONCEPT_OF.setdefault(_w, []).append(_concept)


@lru_cache(maxsize=200_000)
def _bucket(feature: str, dim: int) -> tuple[int, float]:
    digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=9, key=_SALT).digest()
    idx = int.from_bytes(digest[:8], "little") % dim
    sign = 1.0 if digest[8] & 1 else -1.0
    return idx, sign


class HashEmbedder(Embedder):
    name = "hash-v1"
    dim = 384
    local = True
    batch_size = 256
    # Measured on real query/page pairs: a clearly relevant match lands around
    # 0.15-0.30 cosine with this embedder (see tests/test_retrieval.py).
    reference_similarity = 0.18
    # Measured over unrelated query/page pairs: p95 ~0.05, worst case ~0.09.
    noise_floor = 0.06
    lexical_based = True
    # This embedder IS lexical, so BM25 is the trustworthy half of the hybrid and
    # a vector-only hit is likely a character-n-gram collision ("mode" vs "model").
    fusion = (0.45, 0.55, 0.55, 0.95)

    def __init__(self, dim: int = 384, use_concepts: bool = True,
                 use_char_ngrams: bool = True) -> None:
        self.dim = dim
        self.use_concepts = use_concepts
        self.use_char_ngrams = use_char_ngrams

    # -- feature extraction ------------------------------------------------
    def features(self, text: str) -> dict[str, float]:
        """Weighted feature map for one document."""
        if not text:
            return {}
        lowered = text.lower()
        words = _TOKEN_RE.findall(lowered)
        if not words:
            return {}
        content = [w for w in words if w not in STOPWORDS and len(w) > 1]
        feats: dict[str, float] = {}

        def add(key: str, weight: float) -> None:
            feats[key] = feats.get(key, 0.0) + weight

        # unigrams (sublinear tf)
        counts: dict[str, int] = {}
        for w in content:
            counts[w] = counts.get(w, 0) + 1
        for w, c in counts.items():
            add(f"w:{w}", 1.0 + math.log(c))

        # bigrams — the precision workhorse
        for a, b in zip(content, content[1:]):
            add(f"b:{a}_{b}", 1.35)

        # character n-grams — morphology / spelling robustness
        if self.use_char_ngrams:
            for w, c in counts.items():
                if len(w) < 4:
                    continue
                weight = 0.42 * (1.0 + math.log(c))
                for n in (3, 4):
                    if len(w) < n:
                        continue
                    grams = {w[i:i + n] for i in range(len(w) - n + 1)}
                    per = weight / (len(grams) * 2)
                    for g in grams:
                        add(f"c{n}:{g}", per)

        # concept lexicon — weak, readable topical signal
        if self.use_concepts:
            concept_hits: dict[str, float] = {}
            for w, c in counts.items():
                for concept in _CONCEPT_OF.get(w, ()):  # noqa: B007
                    concept_hits[concept] = concept_hits.get(concept, 0.0) + math.log1p(c)
            for concept, score in concept_hits.items():
                add(f"k:{concept}", 0.55 + 0.30 * math.log1p(score))

        # document length prior keeps very long pages from dominating
        norm = 1.0 / math.sqrt(math.log(2 + len(content)))
        return {k: v * norm for k, v in feats.items()}

    # -- vector construction ----------------------------------------------
    def _vector(self, feats: dict[str, float]) -> list[float]:
        vec = [0.0] * self.dim
        for feature, weight in feats.items():
            idx, sign = _bucket(feature, self.dim)
            vec[idx] += sign * weight
        # L2 normalise so cosine == dot product
        norm = math.sqrt(sum(v * v for v in vec))
        if norm <= 1e-12:
            return vec
        inv = 1.0 / norm
        return [v * inv for v in vec]

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(self.features(t)) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        # Queries are short: repeat content terms a little so their signal is
        # comparable to a long document's, and lean harder on bigrams/concepts.
        if not text:
            return [0.0] * self.dim
        words = content_words(text)
        boosted = text
        if words:
            boosted = text + " " + " ".join(words)
        feats = self.features(boosted)
        for w in set(words):
            for concept in _CONCEPT_OF.get(w, ()):
                feats[f"k:{concept}"] = feats.get(f"k:{concept}", 0.0) + 0.9
        return self._vector(feats)

    def describe(self) -> dict:
        base = super().describe()
        base.update({
            "concepts": len(CONCEPTS),
            "char_ngrams": self.use_char_ngrams,
            "note": "deterministic offline lexical embedder (no downloads)",
        })
        return base


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na <= 1e-12 or nb <= 1e-12:
        return 0.0
    return dot / (na * nb)


def tokenize_query(query: str) -> list[str]:
    return [t for t in tokenize(query) if t not in STOPWORDS and len(t) > 1]
