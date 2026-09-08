"""Tiny stdlib HTTP client (no `requests` dependency).

Used by the optional embedders, LLM providers and the web-search layer.
Every call is time-bounded and raises `HttpError` with a readable message so
callers can degrade gracefully instead of hanging the server.
"""

from __future__ import annotations

import gzip
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 TwinBrain/1.0")


class HttpError(Exception):
    def __init__(self, message: str, status: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _open(req: urllib.request.Request, timeout: float) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                try:
                    data = gzip.decompress(data)
                except OSError:
                    pass
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.status, data, charset
    except urllib.error.HTTPError as exc:  # noqa: PERF203
        body = b""
        try:
            body = exc.read()[:4000]
        except Exception:
            pass
        raise HttpError(f"HTTP {exc.code} for {req.full_url}: {exc.reason}",
                        status=exc.code, body=body.decode("utf-8", "replace")) from exc
    except urllib.error.URLError as exc:
        raise HttpError(f"network error for {req.full_url}: {exc.reason}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise HttpError(f"timeout for {req.full_url}") from exc
    except OSError as exc:
        raise HttpError(f"network error for {req.full_url}: {exc}") from exc


def request(url: str, *, method: str = "GET", headers: dict[str, str] | None = None,
            data: bytes | None = None, json_body: Any = None, timeout: float = 15.0,
            retries: int = 0, backoff: float = 0.6) -> tuple[int, bytes, str]:
    hdrs = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip",
            "Accept": "application/json, text/html;q=0.9, */*;q=0.5"}
    if headers:
        hdrs.update(headers)
    payload = data
    if json_body is not None:
        payload = json.dumps(json_body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    attempt = 0
    while True:
        req = urllib.request.Request(url, data=payload, headers=hdrs, method=method.upper())
        try:
            return _open(req, timeout)
        except HttpError as exc:
            retryable = exc.status in (None, 408, 425, 429, 500, 502, 503, 504)
            if attempt < retries and retryable:
                attempt += 1
                time.sleep(backoff * attempt)
                continue
            raise


def get_json(url: str, *, headers: dict[str, str] | None = None, params: dict | None = None,
             timeout: float = 15.0, retries: int = 1) -> Any:
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    status, body, charset = request(url, headers=headers, timeout=timeout, retries=retries)
    try:
        return json.loads(body.decode(charset, "replace"))
    except (ValueError, LookupError) as exc:
        raise HttpError(f"invalid JSON from {url} (HTTP {status})", status=status,
                        body=body[:500].decode(charset, "replace")) from exc


def post_json(url: str, payload: Any, *, headers: dict[str, str] | None = None,
              timeout: float = 30.0, retries: int = 1) -> Any:
    status, body, charset = request(url, method="POST", headers=headers, json_body=payload,
                                    timeout=timeout, retries=retries)
    try:
        return json.loads(body.decode(charset, "replace"))
    except (ValueError, LookupError) as exc:
        raise HttpError(f"invalid JSON from {url} (HTTP {status})", status=status,
                        body=body[:500].decode(charset, "replace")) from exc


def get_text(url: str, *, headers: dict[str, str] | None = None, params: dict | None = None,
             timeout: float = 15.0, max_bytes: int = 2_000_000) -> str:
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    _, body, charset = request(url, headers=headers, timeout=timeout)
    return body[:max_bytes].decode(charset or "utf-8", "replace")
