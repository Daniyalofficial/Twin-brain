"""Claude (Anthropic Messages API) provider."""

from __future__ import annotations

import logging

from ..http_client import post_json
from .base import LLM

log = logging.getLogger("twinbrain.llm.anthropic")


class AnthropicLLM(LLM):
    name = "anthropic"
    local = False

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-5") -> None:
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        self.api_key = api_key
        self.model = model or "claude-sonnet-4-5"

    def complete(self, messages: list[dict], *, max_tokens: int = 700,
                 temperature: float = 0.2) -> str:
        system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
        turns = [m for m in messages if m.get("role") in ("user", "assistant")]
        if not turns:
            turns = [{"role": "user", "content": "."}]
        # the API requires strict user/assistant alternation starting with user
        normalised: list[dict] = []
        for turn in turns:
            if normalised and normalised[-1]["role"] == turn["role"]:
                normalised[-1]["content"] += "\n\n" + turn["content"]
            else:
                normalised.append({"role": turn["role"], "content": turn["content"]})
        if normalised[0]["role"] != "user":
            normalised.insert(0, {"role": "user", "content": "Continue."})

        data = post_json(
            "https://api.anthropic.com/v1/messages",
            {
                "model": self.model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "system": system,
                "messages": normalised,
            },
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout=60.0,
            retries=1,
        )
        parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
        text = "".join(parts).strip()
        if not text:
            raise RuntimeError(f"empty anthropic response: {str(data)[:200]}")
        return text
