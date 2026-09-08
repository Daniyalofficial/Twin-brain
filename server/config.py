"""Configuration loading.

Reads `.env` (if present) then the real environment.  Every knob has a safe
default so the system runs with zero configuration.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# RLock, not Lock: get_config() holds it while Config.__init__ -> _load_dotenv()
# takes it again on the same thread.
_lock = threading.RLock()
_loaded = False


def _load_dotenv() -> None:
    """Minimal .env parser (no python-dotenv dependency)."""
    global _loaded
    with _lock:
        if _loaded:
            return
        _loaded = True
        env_file = REPO_ROOT / ".env"
        if not env_file.exists():
            return
        try:
            for raw in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                # real environment always wins over .env
                os.environ.setdefault(key, value)
        except OSError:
            pass


def _bool(name: str, default: bool = False) -> bool:
    _load_dotenv()
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "y"}


def _int(name: str, default: int) -> int:
    _load_dotenv()
    raw = os.environ.get(name)
    try:
        return int(str(raw).strip()) if raw not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    _load_dotenv()
    raw = os.environ.get(name)
    try:
        return float(str(raw).strip()) if raw not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _str(name: str, default: str = "") -> str:
    _load_dotenv()
    raw = os.environ.get(name)
    return raw.strip() if raw not in (None, "") else default


def _list(name: str) -> list[str]:
    return [p.strip() for p in _str(name).split(",") if p.strip()]


class Config:
    """Resolved runtime configuration."""

    def __init__(self) -> None:
        _load_dotenv()

        # --- network ---
        self.host: str = _str("TWINBRAIN_HOST", "127.0.0.1")
        self.port: int = _int("TWINBRAIN_PORT", 8765)
        self.allowed_origins: list[str] = _list("TWINBRAIN_ALLOWED_ORIGINS")

        # --- storage ---
        data_dir = _str("TWINBRAIN_DATA_DIR")
        self.data_dir: Path = Path(data_dir).expanduser().resolve() if data_dir else REPO_ROOT / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path: Path = self.data_dir / "twinbrain.db"
        self.token_path: Path = self.data_dir / "token.txt"

        # --- auth ---
        self.token: str = _str("TWINBRAIN_TOKEN")
        self.auto_pair: bool = _bool("TWINBRAIN_AUTO_PAIR", True)

        # --- embeddings ---
        self.embedder: str = _str("TWINBRAIN_EMBEDDER", "auto").lower()
        self.st_model: str = _str("TWINBRAIN_ST_MODEL", "all-MiniLM-L6-v2")
        self.embed_model: str = _str("TWINBRAIN_EMBED_MODEL", "text-embedding-3-small")

        # --- llm ---
        self.llm: str = _str("TWINBRAIN_LLM", "auto").lower()
        self.anthropic_key: str = _str("ANTHROPIC_API_KEY")
        self.anthropic_model: str = _str("ANTHROPIC_MODEL", "claude-sonnet-4-5")
        self.openai_key: str = _str("OPENAI_API_KEY")
        self.openai_base_url: str = _str("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.openai_chat_model: str = _str("OPENAI_CHAT_MODEL", "gpt-4o-mini")
        self.local_model: str = _str("TWINBRAIN_LOCAL_MODEL")

        # --- web search ---
        self.websearch: str = _str("TWINBRAIN_WEBSEARCH", "auto").lower()
        self.brave_key: str = _str("BRAVE_API_KEY")
        self.tavily_key: str = _str("TAVILY_API_KEY")
        self.serper_key: str = _str("SERPER_API_KEY")
        self.websearch_daily_budget: int = _int("TWINBRAIN_WEBSEARCH_DAILY_BUDGET", 40)
        self.enrichment_daily_budget: int = _int("TWINBRAIN_ENRICHMENT_DAILY_BUDGET", 5)

        # --- capture / retrieval ---
        self.min_dwell_seconds: int = _int("TWINBRAIN_MIN_DWELL_SECONDS", 5)
        self.top_k: int = _int("TWINBRAIN_RETRIEVAL_TOP_K", 8)
        self.candidate_k: int = _int("TWINBRAIN_CANDIDATE_K", 15)
        self.similarity_weight: float = _float("TWINBRAIN_SIMILARITY_WEIGHT", 0.7)
        self.recency_weight: float = _float("TWINBRAIN_RECENCY_WEIGHT", 0.3)
        self.min_grounding_score: float = _float("TWINBRAIN_MIN_GROUNDING_SCORE", 0.20)

        # --- jobs ---
        self.enable_scheduler: bool = _bool("TWINBRAIN_ENABLE_SCHEDULER", True)
        self.digest_hour: int = _int("TWINBRAIN_DIGEST_HOUR", 20)
        self.retention_days: int = _int("TWINBRAIN_RETENTION_DAYS", 0)

        self.debug: bool = _bool("TWINBRAIN_DEBUG", False)

    # convenience -------------------------------------------------------
    @property
    def has_anthropic(self) -> bool:
        return bool(self.anthropic_key)

    @property
    def has_openai(self) -> bool:
        return bool(self.openai_key)

    def public_dict(self) -> dict:
        """Safe subset for /api/health — never includes secrets."""
        return {
            "host": self.host,
            "port": self.port,
            "data_dir": str(self.data_dir),
            "db_path": str(self.db_path),
            "embedder_pref": self.embedder,
            "llm_pref": self.llm,
            "websearch_pref": self.websearch,
            "min_dwell_seconds": self.min_dwell_seconds,
            "top_k": self.top_k,
            "candidate_k": self.candidate_k,
            "similarity_weight": self.similarity_weight,
            "recency_weight": self.recency_weight,
            "min_grounding_score": self.min_grounding_score,
            "retention_days": self.retention_days,
            "digest_hour": self.digest_hour,
            "enrichment_daily_budget": self.enrichment_daily_budget,
            "websearch_daily_budget": self.websearch_daily_budget,
            "scheduler_enabled": self.enable_scheduler,
            "auto_pair": self.auto_pair,
            "keys_present": {
                "anthropic": self.has_anthropic,
                "openai": self.has_openai,
                "brave": bool(self.brave_key),
                "tavily": bool(self.tavily_key),
                "serper": bool(self.serper_key),
            },
        }


_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        with _lock:
            if _config is None:
                _config = Config()
    return _config


def reload_config() -> Config:
    """Drop the cached config (used after env changes / tests)."""
    global _config, _loaded
    with _lock:
        _config = None
        _loaded = False
    return get_config()
