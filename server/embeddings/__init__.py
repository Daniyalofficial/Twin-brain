"""Embedding backends.

`get_embedder()` picks the best available backend once and caches it:

    auto -> sentence-transformers (local neural, best quality)
         -> OpenAI-compatible embeddings API (if key configured)
         -> built-in offline hashing embedder (always available, zero deps)

The active model name + dimension are persisted in `settings`; if they change
(e.g. you install sentence-transformers later) the vector index is rebuilt
automatically by `jobs.reindex_all()`.
"""

from .base import Embedder
from .registry import get_embedder, reset_embedder, describe_embedder

__all__ = ["Embedder", "get_embedder", "reset_embedder", "describe_embedder"]
