"""Embedder interface."""

from __future__ import annotations

from abc import ABC, abstractmethod


class Embedder(ABC):
    """Maps text -> L2-normalised float32 vector."""

    name: str = "base"
    dim: int = 384
    local: bool = True
    batch_size: int = 64
    # Typical cosine similarity for a *genuinely relevant* query/page pair with
    # this model. Bag-of-feature embedders spread their mass over many more
    # dimensions than neural ones, so their raw cosines are systematically
    # smaller. Retrieval divides by this to put every embedder on one scale —
    # otherwise the grounding threshold would have to change per model.
    reference_similarity: float = 0.5
    # Highest cosine typically seen between a query and a page it has NOTHING to
    # do with (measured, not guessed). Retrieval refuses to call a match
    # "grounded" on vector evidence alone below `vector_gate`, because a cosine
    # that small is indistinguishable from hashing/model noise.
    noise_floor: float = 0.08
    # True when the "vector" is really a hashed bag-of-features. Then a match with
    # zero lexical coverage is almost certainly noise, and retrieval caps it.
    lexical_based: bool = False
    # (vector_weight, lexical_weight, solo_vector_factor, solo_lexical_factor)
    fusion: tuple[float, float, float, float] = (0.70, 0.30, 0.95, 0.85)

    @property
    def vector_gate(self) -> float:
        """Minimum raw cosine that counts as real vector evidence."""
        return round(self.noise_floor * 2.2, 4)

    def calibrate(self, raw_similarity: float) -> float:
        """Map a raw cosine onto ~[0,1] where 1.0 means 'clearly relevant'."""
        ref = self.reference_similarity or 0.5
        value = float(raw_similarity) / ref
        return max(0.0, min(1.0, value))

    @abstractmethod
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of documents."""

    def embed_query(self, text: str) -> list[float]:
        """Embed a search query. Symmetric by default."""
        return self.embed_texts([text])[0]

    def describe(self) -> dict:
        return {"name": self.name, "dim": self.dim, "local": self.local,
                "reference_similarity": self.reference_similarity,
                "noise_floor": self.noise_floor, "vector_gate": self.vector_gate}
