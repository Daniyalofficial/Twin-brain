"""Local neural embeddings via sentence-transformers (optional upgrade).

Install with:  pip install sentence-transformers
First run downloads all-MiniLM-L6-v2 (~90 MB) once; after that it is fully
offline and private — nothing leaves your machine.
"""

from __future__ import annotations

import logging

from .base import Embedder

log = logging.getLogger("twinbrain.embeddings.st")

AVAILABLE = False
IMPORT_ERROR = ""
try:  # pragma: no cover - depends on the host machine
    from sentence_transformers import SentenceTransformer  # type: ignore

    AVAILABLE = True
except Exception as exc:  # pragma: no cover
    IMPORT_ERROR = str(exc)
    SentenceTransformer = None  # type: ignore


class SentenceTransformerEmbedder(Embedder):
    name = "sentence-transformers"
    local = True
    batch_size = 32
    reference_similarity = 0.45      # MiniLM: relevant pairs typically 0.4-0.7
    noise_floor = 0.12               # unrelated pairs sit around 0.05-0.15
    lexical_based = False
    fusion = (0.72, 0.28, 0.95, 0.85)

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        if not AVAILABLE:
            raise RuntimeError(f"sentence-transformers unavailable: {IMPORT_ERROR}")
        self.model_name = model_name
        log.info("loading sentence-transformers model %s ...", model_name)
        self.model = SentenceTransformer(model_name)
        self.name = f"st:{model_name}"
        self.dim = int(self.model.get_sentence_embedding_dimension())
        log.info("model ready: dim=%s", self.dim)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        texts = [t if t and t.strip() else " " for t in texts]
        vectors = self.model.encode(
            texts,
            batch_size=self.batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return [list(map(float, v)) for v in vectors]

    def describe(self) -> dict:
        base = super().describe()
        base["model"] = self.model_name
        return base
