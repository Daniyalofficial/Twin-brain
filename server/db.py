"""SQLite storage layer: schema, migrations, thread-safe connections.

Design notes
------------
* One connection per thread (SQLite objects are not shareable across threads),
  WAL mode so the background scheduler can write while the API reads.
* `sqlite-vec` is loaded when available (real ANN/KNN index). When it is not,
  `vector_store.py` transparently falls back to an exact cosine scan over the
  BLOBs stored in `chunks.embedding`.
* FTS5 provides BM25 lexical retrieval; if a Python build lacks FTS5 we fall
  back to an in-process inverted index (`lexicon.py`).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .config import get_config

SCHEMA_VERSION = 5

_local = threading.local()
_init_lock = threading.Lock()
_initialised = False
_capabilities: dict[str, Any] = {}
# Set when a migration invalidates the FTS index; app startup rebuilds it.
PENDING_FTS_REBUILD = False

# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
-- The memory itself. One row per distinct URL (deduped), spec-compatible.
CREATE TABLE IF NOT EXISTS pages (
    id                 TEXT PRIMARY KEY,      -- hash of URL
    url                TEXT NOT NULL,
    canonical_url      TEXT,
    title              TEXT,
    domain             TEXT,
    registrable_domain TEXT,
    extracted_text     TEXT,                  -- cleaned via the extractor
    excerpt            TEXT,                  -- first ~400 chars, for prompts
    summary            TEXT,                  -- optional short summary
    topics             TEXT,                  -- JSON [{topic,weight}]
    word_count         INTEGER DEFAULT 0,
    lang               TEXT,
    visited_at         TIMESTAMP,             -- last visit (spec column)
    first_visited_at   TIMESTAMP,
    last_visited_at    TIMESTAMP,
    visit_count        INTEGER DEFAULT 1,
    dwell_seconds      INTEGER DEFAULT 0,     -- last visit dwell (spec column)
    total_dwell_seconds INTEGER DEFAULT 0,
    scroll_depth       REAL DEFAULT 0,        -- last visit (spec column)
    max_scroll_depth   REAL DEFAULT 0,
    avg_scroll_depth   REAL DEFAULT 0,
    content_hash       TEXT,
    status             TEXT DEFAULT 'ok',     -- ok|no_content|error|imported
    source             TEXT DEFAULT 'extension',
    ai_visible         INTEGER DEFAULT 1,     -- 0 = logged but hidden from the AI
    embedding          BLOB,                  -- page-level centroid vector
    embedding_model    TEXT,
    captured_at        TIMESTAMP,
    updated_at         TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pages_domain      ON pages(domain);
CREATE INDEX IF NOT EXISTS idx_pages_reg_domain  ON pages(registrable_domain);
CREATE INDEX IF NOT EXISTS idx_pages_visited_at  ON pages(visited_at);
CREATE INDEX IF NOT EXISTS idx_pages_last_visit  ON pages(last_visited_at);
CREATE INDEX IF NOT EXISTS idx_pages_ai_visible  ON pages(ai_visible);
CREATE INDEX IF NOT EXISTS idx_pages_title       ON pages(title);

-- Every single page link the user opens, including repeat visits and pages
-- whose content could not be extracted. "Never forget the link."
CREATE TABLE IF NOT EXISTS page_visits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id       TEXT,
    url           TEXT NOT NULL,
    title         TEXT,
    domain        TEXT,
    visited_at    TIMESTAMP,
    dwell_seconds INTEGER DEFAULT 0,
    scroll_depth  REAL DEFAULT 0,
    referrer      TEXT,
    source        TEXT DEFAULT 'extension',
    ai_visible    INTEGER DEFAULT 1,
    content_captured INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON page_visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_visits_page       ON page_visits(page_id);
CREATE INDEX IF NOT EXISTS idx_visits_domain     ON page_visits(domain);

-- Retrieval units. A page is split into overlapping chunks; each has a vector.
CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id     TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    text        TEXT NOT NULL,
    heading     TEXT,
    char_start  INTEGER,
    char_end    INTEGER,
    token_count INTEGER DEFAULT 0,
    embedding   BLOB,
    created_at  TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);

-- Durable tombstones: a forgotten page/domain must never be re-captured.
CREATE TABLE IF NOT EXISTS forgotten (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,          -- page | domain | url_prefix
    value      TEXT NOT NULL,
    reason     TEXT,
    created_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_forgotten_kind ON forgotten(kind, value);

-- Per-domain privacy mode: full | no_ai | off  (+ default blocklist entries)
CREATE TABLE IF NOT EXISTS exclusions (
    id         TEXT PRIMARY KEY,
    domain     TEXT,
    url_prefix TEXT,
    mode       TEXT DEFAULT 'off',     -- off = never capture; no_ai = capture, hide from AI
    source     TEXT DEFAULT 'user',    -- user | default | forget
    note       TEXT,
    created_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_excl_domain ON exclusions(domain) WHERE domain IS NOT NULL;

-- Aggregate per-domain stats (drives the settings checkbox list).
CREATE TABLE IF NOT EXISTS domains (
    domain            TEXT PRIMARY KEY,
    registrable_domain TEXT,
    visit_count       INTEGER DEFAULT 0,
    page_count        INTEGER DEFAULT 0,
    total_dwell       INTEGER DEFAULT 0,
    first_seen        TIMESTAMP,
    last_visited_at   TIMESTAMP,
    mode              TEXT DEFAULT 'full',
    ai_visible        INTEGER DEFAULT 1,
    category          TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id                  TEXT PRIMARY KEY,
    query               TEXT,
    response            TEXT,
    referenced_page_ids TEXT,          -- JSON array (spec column)
    citations           TEXT,          -- JSON array of rich citations
    created_at          TIMESTAMP,
    provider            TEXT,
    grounded            INTEGER DEFAULT 1,
    used_web            INTEGER DEFAULT 0,
    web_results         TEXT,
    latency_ms          INTEGER,
    retrieval_ms        INTEGER,
    mode                TEXT DEFAULT 'memory'
);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Derived, transparent interest profile (evidence-backed, never invented).
CREATE TABLE IF NOT EXISTS interests (
    topic      TEXT PRIMARY KEY,
    weight     REAL DEFAULT 0,
    hits       INTEGER DEFAULT 0,
    pages      INTEGER DEFAULT 0,
    first_seen TIMESTAMP,
    last_seen  TIMESTAMP,
    source     TEXT DEFAULT 'derived',
    evidence   TEXT                    -- JSON [{page_id,title,domain}]
);

-- Things the twin noticed (daily digest, new-info notifications).
CREATE TABLE IF NOT EXISTS insights (
    id          TEXT PRIMARY KEY,
    day         TEXT,
    kind        TEXT,                  -- digest | enrichment | new_info | revisit
    title       TEXT,
    body        TEXT,
    url         TEXT,
    page_ids    TEXT,                  -- JSON
    score       REAL DEFAULT 0,
    dedupe_key  TEXT,
    created_at  TIMESTAMP,
    notified    INTEGER DEFAULT 0,
    seen        INTEGER DEFAULT 0,
    dismissed   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_insights_day    ON insights(day);
CREATE INDEX IF NOT EXISTS idx_insights_dedupe ON insights(dedupe_key);

-- Backend web searches performed to grow knowledge about the user's topics.
CREATE TABLE IF NOT EXISTS enrichment_runs (
    id         TEXT PRIMARY KEY,
    day        TEXT,
    kind       TEXT,                   -- interest | page_update | question
    query      TEXT,
    provider   TEXT,
    status     TEXT,                   -- ok | empty | error | skipped
    results    TEXT,                   -- JSON
    insight_id TEXT,
    latency_ms INTEGER,
    created_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_enrich_day ON enrichment_runs(day);

CREATE TABLE IF NOT EXISTS web_cache (
    key        TEXT PRIMARY KEY,
    query      TEXT,
    provider   TEXT,
    results    TEXT,
    created_at TIMESTAMP,
    expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS web_usage (
    day   TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    started_at  TIMESTAMP,
    finished_at TIMESTAMP,
    status      TEXT,
    detail      TEXT
);
"""

# Two columns: the page title is a strong relevance signal ("that recipe page"
# often matches only the title), and it must not be mixed into body term
# frequencies — lexical.py scores the columns separately with a title boost.
FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
    title,
    text,
    content='',
    tokenize='porter unicode61 remove_diacritics 2'
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    # capture
    "capture_enabled": True,
    "capture_content": True,
    "min_dwell_seconds": 5,
    "capture_uploads": False,
    # privacy
    "global_pause": False,
    "retention_days": 0,          # 0 = keep forever ("never forget")
    "respect_default_blocklist": True,
    # retrieval / answers
    "top_k": 8,
    "candidate_k": 15,
    "similarity_weight": 0.7,
    "recency_weight": 0.3,
    "min_grounding_score": 0.20,
    "recency_halflife_days": 30.0,
    "answer_style": "concise",
    "always_offer_links": True,
    # backend web search (knowledge growth)
    "web_search_enabled": True,
    "web_search_for_answers": True,     # augment when local memory is thin
    "web_search_daily_budget": 40,
    # enrichment / notifications
    "enrichment_enabled": True,
    "enrichment_daily_budget": 5,       # "only 5 times in a whole day"
    "notification_daily_budget": 5,
    "notifications_enabled": True,
    "digest_enabled": True,
    "digest_hour": 20,
    # interests
    "interest_learning_enabled": True,
    "interest_max_topics": 40,
}

# Domains that are blocked out of the box. The extension enforces these BEFORE
# any content script runs, so this content never touches disk even transiently.
DEFAULT_BLOCKLIST: dict[str, str] = {
    # banking / money
    "chase.com": "banking", "bankofamerica.com": "banking", "wellsfargo.com": "banking",
    "citi.com": "banking", "capitalone.com": "banking", "amex.com": "banking",
    "usbank.com": "banking", "hsbc.com": "banking", "hsbc.co.uk": "banking",
    "barclays.co.uk": "banking", "monzo.com": "banking",
    "lloydsbank.co.uk": "banking", "natwest.com": "banking", "santander.co.uk": "banking",
    "paypal.com": "payments", "stripe.com": "payments", "wise.com": "payments",
    "revolut.com": "banking", "coinbase.com": "crypto", "binance.com": "crypto",
    "kraken.com": "crypto", "metamask.io": "crypto",
    # healthcare
    "cvs.com": "health", "walgreens.com": "health", "webmd.com": "health",
    "mychart.com": "health", "kaiserpermanente.org": "health", "nhs.uk": "health",
    "medlineplus.gov": "health", "doctolib.fr": "health", "practo.com": "health",
    "1mg.com": "health", "netmums.com": "health", "patient.info": "health",
    "zocdoc.com": "health",
    # government / official login portals
    "irs.gov": "government", "usa.gov": "government", "gov.uk": "government",
    "service.gov.uk": "government", "login.gov": "government", "dslogon.va.gov": "government",
    "my.gov.au": "government", "canada.ca": "government", "india.gov.in": "government",
    "uidai.gov.in": "government", "europa.eu": "government",
    # password managers / identity
    "1password.com": "identity", "lastpass.com": "identity", "bitwarden.com": "identity",
    "dashlane.com": "identity", "okta.com": "identity", "auth0.com": "identity",
    "duo.com": "identity", "myauthenticator.com": "identity",
    # email / private messaging (content is personal by nature)
    "mail.google.com": "email", "outlook.live.com": "email", "outlook.office.com": "email",
    "mail.yahoo.com": "email", "proton.me": "email", "protonmail.com": "email",
    "web.whatsapp.com": "messaging", "web.telegram.org": "messaging",
    "messages.google.com": "messaging", "discord.com": "messaging",
    # adult
    "pornhub.com": "adult", "xvideos.com": "adult", "xhamster.com": "adult",
}

# URL substrings that are never captured regardless of domain.
SENSITIVE_URL_MARKERS = (
    "/login", "/signin", "/sign-in", "/logout", "/account/password",
    "/checkout", "/payment", "/billing", "/banking", "/transfer",
    "password_reset", "reset_password", "/otp", "/2fa", "/mfa",
    "session=", "token=", "access_token=", "auth", "/sso/",
)


# ---------------------------------------------------------------------------
# connection handling
# ---------------------------------------------------------------------------


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-32000")   # 32 MB page cache
    return conn


def _try_load_vec(conn: sqlite3.Connection) -> bool:
    try:
        import sqlite_vec  # type: ignore

        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return True
    except Exception:
        try:
            conn.enable_load_extension(False)
        except Exception:
            pass
        return False


def _try_fts(conn: sqlite3.Connection) -> bool:
    try:
        existing = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='chunk_fts'").fetchone()
        if existing and existing["sql"] and "title" not in existing["sql"]:
            # older single-column index -> rebuild with the title column
            conn.execute("DROP TABLE IF EXISTS chunk_fts")
        conn.executescript(FTS_SQL)
        return True
    except sqlite3.Error:
        return False


def get_conn() -> sqlite3.Connection:
    """Thread-local connection, creating the schema on first use."""
    global _initialised
    conn = getattr(_local, "conn", None)
    cfg = get_config()
    db_path = cfg.db_path

    if conn is not None and getattr(_local, "path", None) == str(db_path):
        return conn

    conn = _connect(db_path)
    has_vec = _try_load_vec(conn)
    has_fts = _try_fts(conn)

    _local.conn = conn
    _local.path = str(db_path)
    _local.has_vec = has_vec
    _local.has_fts = has_fts

    with _init_lock:
        _capabilities["sqlite_vec"] = has_vec or _capabilities.get("sqlite_vec", False)
        _capabilities["fts5"] = has_fts or _capabilities.get("fts5", False)
        if not _initialised or _capabilities.get("db_path") != str(db_path):
            conn.executescript(SCHEMA_SQL)
            _capabilities["db_path"] = str(db_path)
            _seed_defaults(conn)
            _migrate(conn)
            _initialised = True
    return conn


def capabilities() -> dict[str, Any]:
    get_conn()
    return dict(_capabilities)


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    return get_conn().execute(sql, tuple(params)).fetchall()


def query_one(sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
    return get_conn().execute(sql, tuple(params)).fetchone()


def execute(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    return get_conn().execute(sql, tuple(params))


def close_thread_conn() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        finally:
            _local.conn = None


# ---------------------------------------------------------------------------
# settings helpers
# ---------------------------------------------------------------------------


def get_setting(key: str, default: Any = None) -> Any:
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    if row is None:
        return DEFAULT_SETTINGS.get(key, default)
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return row["value"]


def set_setting(key: str, value: Any) -> None:
    execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )


def all_settings() -> dict[str, Any]:
    out = dict(DEFAULT_SETTINGS)
    for row in query("SELECT key, value FROM settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except (TypeError, ValueError):
            out[row["key"]] = row["value"]
    return out


def _seed_defaults(conn: sqlite3.Connection) -> None:
    now = _now()
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
            (key, json.dumps(value)),
        )
    # env overrides act as *defaults* only when the user has not set them
    cfg = get_config()
    env_defaults = {
        "min_dwell_seconds": cfg.min_dwell_seconds,
        "top_k": cfg.top_k,
        "candidate_k": cfg.candidate_k,
        "similarity_weight": cfg.similarity_weight,
        "recency_weight": cfg.recency_weight,
        "min_grounding_score": cfg.min_grounding_score,
        "retention_days": cfg.retention_days,
        "digest_hour": cfg.digest_hour,
        "enrichment_daily_budget": cfg.enrichment_daily_budget,
        "notification_daily_budget": cfg.enrichment_daily_budget,
        "web_search_daily_budget": cfg.websearch_daily_budget,
    }
    for key, value in env_defaults.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
            (key, json.dumps(value)),
        )
    for domain, category in DEFAULT_BLOCKLIST.items():
        conn.execute(
            "INSERT OR IGNORE INTO exclusions(id, domain, mode, source, note, created_at) "
            "VALUES(?, ?, 'off', 'default', ?, ?)",
            (f"dom:{domain}", domain, category, now),
        )
    conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('installed_at', ?)",
                 (json.dumps(now),))


def _migrate(conn: sqlite3.Connection) -> None:
    """Lightweight forward migrations (idempotent)."""
    row = conn.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
    version = 0
    if row:
        try:
            version = int(json.loads(row["value"]))
        except (TypeError, ValueError):
            version = 0
    global PENDING_FTS_REBUILD
    if version < 5:
        # v5: chunk_fts gained a `title` column -> the old index is useless
        existing = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name='chunk_fts'").fetchone()
        if existing and existing["sql"] and "title" not in existing["sql"]:
            conn.execute("DROP TABLE IF EXISTS chunk_fts")
            try:
                conn.executescript(FTS_SQL)
                PENDING_FTS_REBUILD = True
            except sqlite3.Error:
                pass
    if version < SCHEMA_VERSION:
        # v4: page_visits.content_captured + domains.category
        _ensure_column(conn, "page_visits", "content_captured", "INTEGER DEFAULT 0")
        _ensure_column(conn, "domains", "category", "TEXT")
        _ensure_column(conn, "pages", "avg_scroll_depth", "REAL DEFAULT 0")
        _ensure_column(conn, "pages", "registrable_domain", "TEXT")
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(SCHEMA_VERSION),),
        )


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        except sqlite3.Error:
            pass


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


def now_iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts if ts is not None else time.time()))


def today_str() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def stats() -> dict[str, Any]:
    def scalar(sql: str, params: tuple = ()) -> Any:
        row = query_one(sql, params)
        return list(row)[0] if row else 0

    return {
        "pages": scalar("SELECT COUNT(*) FROM pages"),
        "pages_with_text": scalar("SELECT COUNT(*) FROM pages WHERE word_count > 0"),
        "visits": scalar("SELECT COUNT(*) FROM page_visits"),
        "chunks": scalar("SELECT COUNT(*) FROM chunks"),
        "embedded_chunks": scalar("SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL"),
        "conversations": scalar("SELECT COUNT(*) FROM conversations"),
        "domains": scalar("SELECT COUNT(*) FROM domains"),
        "excluded_domains": scalar("SELECT COUNT(*) FROM exclusions WHERE mode='off'"),
        "hidden_from_ai": scalar("SELECT COUNT(*) FROM exclusions WHERE mode='no_ai'"),
        "insights": scalar("SELECT COUNT(*) FROM insights WHERE dismissed=0"),
        "forgotten": scalar("SELECT COUNT(*) FROM forgotten"),
        "total_words": scalar("SELECT COALESCE(SUM(word_count),0) FROM pages"),
        "total_dwell_seconds": scalar("SELECT COALESCE(SUM(total_dwell_seconds),0) FROM pages"),
        "db_bytes": (get_config().db_path.stat().st_size if get_config().db_path.exists() else 0),
    }
