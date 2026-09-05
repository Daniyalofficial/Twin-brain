"""The grounded LLM layer.

`get_llm()` resolves a provider once:

    auto       -> anthropic (if ANTHROPIC_API_KEY)
               -> openai-compatible (if OPENAI_API_KEY / local server)
               -> extractive (built-in, offline, cannot hallucinate)
    extractive -> forced offline grounded engine
    anthropic  -> Claude Messages API
    openai     -> any /chat/completions endpoint (OpenAI, Ollama, LM Studio…)

Every provider receives the *same* system prompt and the *same* small,
retrieval-limited context, so switching providers changes fluency, not
trustworthiness.
"""

from .base import LLMResponse, get_llm, reset_llm, describe_llm

__all__ = ["LLMResponse", "get_llm", "reset_llm", "describe_llm"]
