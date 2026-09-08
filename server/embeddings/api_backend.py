"""Hosted embeddings via any OpenAI-compatible /v1/embeddings endpoint.

Works with OpenAI, OpenRouter, Groq, Together, Azure-compatible gateways and
local servers (Ollama at http://localhost:11434/v1, LM Studio, vLLM) — so you
can have real neural embeddings with zero local compute.

NOTE: with a hosted provider your page text leaves the machine. The default
`hash` / local `st` embedders never do. Choose deliberately.
"""

from __future__ import annotations

import logging

from ..http_client import HttpError, post_json
from .base import Embedder

log = logging.getLogger("twinbrain.embeddings.api")


class ApiEmbedder(Embedder):
    name = "api"
    local = False
    batch_size = 64
    reference_similarity = 0.35      # text-embedding-3-small: relevant ~0.3-0.6
    noise_floor = 0.10
    lexical_based = False
    fusion = (0.70, 0.30, 0.92, 0.85)

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1",
                 model: str = "text-embedding-3-small", dim: int = 1536) -> None:
        if not api_key:
            raise RuntimeError("no API key for hosted embedder")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.dim = dim
        self.name = f"api:{model}"
        # verify + discover the real dimension with a single tiny call
        probe = self._call(["twinbrain dimension probe"])
        if probe:
            self.dim = len(probe[0])

    def _call(self, texts: list[str]) -> list[list[float]]:
        payload = {"model": self.model, "input": texts}
        data = post_json(
            f"{self.base_url}/embeddings",
            payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=45.0,
            retries=1,
        )
        items = sorted(data.get("data", []), key=lambda d: d.get("index", 0))
        return [item["embedding"] for item in items if "embedding" in item]

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        texts = [t[:8000] if t and t.strip() else " " for t in texts]
        out: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i:i + self.batch_size]
            try:
                out.extend(self._call(batch))
            except HttpError as exc:
                log.warning("embedding batch failed (%s); zero-filling %d vectors", exc, len(batch))
                out.extend([[0.0] * self.dim for _ in batch])
        while len(out) < len(texts):
            out.append([0.0] * self.dim)
        return out

    def describe(self) -> dict:
        base = super().describe()
        base.update({"model": self.model, "endpoint": self.base_url})
        return base
