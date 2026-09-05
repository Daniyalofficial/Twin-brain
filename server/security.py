"""Auth, CORS and CSRF for a local-first service.

Threat model: the server usually binds to 127.0.0.1, but *any* website the user
visits can try to POST to localhost. So:

* every mutating call needs the shared token (header, cookie, or `?token=` for
  EventSource, which cannot set headers)
* cross-origin POST/DELETE additionally needs `X-Requested-With: TwinBrain`;
  a browser cannot add that header cross-origin without a CORS preflight, and
  we refuse preflights from origins we do not allow
* cookies are SameSite=Strict + HttpOnly
* CORS is echoed only for `chrome-extension://` origins and explicitly
  configured dashboard origins — never `*` with credentials
"""

from __future__ import annotations

import logging
import os
import secrets
import stat
from typing import Any

from flask import Request, Response, g, jsonify, request

from . import db
from .config import get_config

log = logging.getLogger("twinbrain.security")

COOKIE_NAME = "tb_session"
HEADER_NAME = "X-TwinBrain-Token"
CUSTOM_HEADER = "X-Requested-With"
CUSTOM_HEADER_VALUE = "TwinBrain"

# Endpoints reachable without a token. Kept tiny and secret-free.
OPEN_PATHS = {"/api/health", "/health", "/", "/pair", "/favicon.ico", "/index.html"}
OPEN_PREFIXES = ("/static/", "/ui/")


# ---------------------------------------------------------------------------
# token
# ---------------------------------------------------------------------------


def get_token(*, create: bool = True) -> str:
    cfg = get_config()
    if cfg.token:
        return cfg.token
    stored = db.get_setting("auth_token")
    if isinstance(stored, str) and stored:
        return stored
    path = cfg.token_path
    if path.exists():
        try:
            value = path.read_text(encoding="utf-8").strip()
            if value:
                db.set_setting("auth_token", value)
                return value
        except OSError:
            pass
    if not create:
        return ""
    value = secrets.token_urlsafe(24)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value + "\n", encoding="utf-8")
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)   # 0600
    except OSError as exc:
        log.warning("could not write %s (%s); keeping the token in the DB only", path, exc)
    db.set_setting("auth_token", value)
    log.info("generated a new API token (%s)", path)
    return value


def rotate_token() -> str:
    cfg = get_config()
    if cfg.token:
        raise RuntimeError("TWINBRAIN_TOKEN is set in the environment; change it there")
    value = secrets.token_urlsafe(24)
    try:
        cfg.token_path.write_text(value + "\n", encoding="utf-8")
        os.chmod(cfg.token_path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    db.set_setting("auth_token", value)
    return value


def constant_time_equals(a: str, b: str) -> bool:
    return secrets.compare_digest((a or "").encode(), (b or "").encode())


# ---------------------------------------------------------------------------
# origin handling
# ---------------------------------------------------------------------------


def request_origin() -> str:
    return (request.headers.get("Origin") or "").strip()


def origin_allowed(origin: str) -> bool:
    if not origin:
        return True                      # non-browser client (curl, python, extension SW)
    if origin.startswith("chrome-extension://") or origin.startswith("moz-extension://"):
        return True
    if origin.startswith("extension://"):
        return True
    cfg = get_config()
    allowed = set(cfg.allowed_origins)
    host = request.host or ""
    allowed.add(f"http://{host}")
    allowed.add(f"https://{host}")
    allowed.add(f"http://{host.split(':')[0]}:{cfg.port}")
    allowed.add(f"http://127.0.0.1:{cfg.port}")
    allowed.add(f"http://localhost:{cfg.port}")
    return origin.rstrip("/") in {a.rstrip("/") for a in allowed}


def apply_cors(response: Response) -> Response:
    origin = request_origin()
    if origin and origin_allowed(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers.add("Vary", "Origin")
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, X-TwinBrain-Token, X-Requested-With, X-TwinBrain-Client")
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Max-Age"] = "600"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


# ---------------------------------------------------------------------------
# request gate
# ---------------------------------------------------------------------------


def token_from_request() -> str:
    value = request.headers.get(HEADER_NAME) or ""
    if value:
        return value.strip()
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    cookie = request.cookies.get(COOKIE_NAME) or ""
    if cookie:
        return cookie.strip()
    query = request.args.get("token") or ""
    if query:
        return query.strip()
    return ""


def is_open_path(path: str) -> bool:
    if path in OPEN_PATHS:
        return True
    return any(path.startswith(p) for p in OPEN_PREFIXES)


def check_request() -> tuple[bool, str]:
    """-> (allowed, reason)."""
    path = request.path or "/"
    method = request.method.upper()

    if method == "OPTIONS":
        # preflight: only answer it for origins we would actually allow
        if origin_allowed(request_origin()):
            return True, "preflight"
        return False, "origin not allowed"

    token = get_token()
    supplied = token_from_request()
    authorised = bool(supplied) and constant_time_equals(supplied, token)

    if is_open_path(path):
        if path in ("/pair", "/") and method == "GET" and get_config().auto_pair and token:
            g.pair_cookie = token       # app.py sets the cookie from this
        return True, "open path"

    if not authorised:
        return False, "missing or invalid token"

    # CSRF: browsers must prove this is not a drive-by cross-site form post
    origin = request_origin()
    if method in ("POST", "PUT", "DELETE", "PATCH"):
        if origin and not origin.startswith(("chrome-extension://", "moz-extension://")):
            if request.headers.get(CUSTOM_HEADER) != CUSTOM_HEADER_VALUE:
                if not (supplied and request.args.get("token")):
                    return False, f"missing {CUSTOM_HEADER} header for cross-origin write"
        if not origin_allowed(origin):
            return False, "origin not allowed"

    return True, "ok"


def unauthorized(reason: str) -> Response:
    response = jsonify({"ok": False, "error": "unauthorized", "detail": reason,
                        "hint": "Open the dashboard once (auto-pair) or paste the token "
                                "from data/token.txt into the extension's options page."})
    response.status_code = 401
    return apply_cors(response)


def install(app: Any) -> None:
    """Wire the gate into a Flask app."""

    @app.before_request
    def _gate():  # pragma: no cover - thin wrapper
        allowed, reason = check_request()
        if not allowed:
            log.info("blocked %s %s (%s)", request.method, request.path, reason)
            return unauthorized(reason)
        return None

    @app.after_request
    def _cors(response: Response):  # pragma: no cover - thin wrapper
        cookie = getattr(g, "pair_cookie", None)
        if cookie:
            response.set_cookie(COOKIE_NAME, cookie, max_age=60 * 60 * 24 * 365,
                                httponly=True, samesite="Strict",
                                secure=request.is_secure)
            g.pair_cookie = None
        return apply_cors(response)
