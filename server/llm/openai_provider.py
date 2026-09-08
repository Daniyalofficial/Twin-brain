"""Any OpenAI-compatible /chat/completions provider.

Covers OpenAI, OpenRouter, Groq, Together, DeepInfra, Azure-style gateways and
— most useful for a private twin — local servers such as Ollama
(http://localhost:11434/v1) and LM Studio (http://localhost:1234/v1).
"""

from __future__ import annotations

import logging

from ..http_client import post_json
from .base import LLM

log = logging.getLogger("twinbrain.llm.openai")


class OpenAICompatLLM(LLM):
    name = "openai"
    local = False

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1",
                 model: str = "gpt-4o-mini") -> None:
        self.api_key = api_key or "not-needed"
        self.base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        self.model = model or "gpt-4o-mini"
        if "localhost" in self.base_url or "127.0.0.1" in self.base_url:
            self.local = True
            self.name = "local-openai-compat"

    def complete(self, messages: list[dict], *, max_tokens: int = 700,
                 temperature: float = 0.2) -> str:
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        data = post_json(f"{self.base_url}/chat/completions", payload, headers=headers,
                         timeout=90.0, retries=1)
        try:
            text = (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"unexpected chat response shape: {str(data)[:200]}") from exc
        if not text:
            raise RuntimeError("empty completion")
        return text
