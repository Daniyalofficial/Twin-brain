"""Shared test scaffolding: an isolated data dir + a scheduler-less Flask app."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Must happen before any server module reads config.
DATA_DIR = Path(tempfile.mkdtemp(prefix="twinbrain-tests-"))
os.environ["TWINBRAIN_DATA_DIR"] = str(DATA_DIR)
os.environ["TWINBRAIN_ENABLE_SCHEDULER"] = "false"
os.environ["TWINBRAIN_WEBSEARCH"] = "none"             # tests never touch the network
os.environ["TWINBRAIN_EMBEDDER"] = "hash"
os.environ["TWINBRAIN_LLM"] = "extractive"

from server import app as app_module          # noqa: E402
from server import capture, db, security      # noqa: E402


def make_client():
    flask_app = app_module.create_app(with_scheduler=False)
    flask_app.config["TESTING"] = True
    return flask_app.test_client()


def auth_headers():
    return {"Authorization": f"Bearer {security.get_token()}",
            "X-Requested-With": "TwinBrain",
            "Content-Type": "application/json"}


def seed_page(client, url, title, text, domain=None, dwell=240, visited_at=None):
    payload = {
        "url": url, "title": title, "text": text,
        "dwell_seconds": dwell, "scroll_depth": 0.8,
        "visited_at": visited_at,
        "meta": {"site_name": domain or ""},
    }
    response = client.post("/api/capture", json=payload, headers=auth_headers())
    assert response.status_code == 200, response.get_data(as_text=True)
    return response.get_json()


class TwinBrainTestCase(unittest.TestCase):
    """Fresh, empty memory for every test method."""

    @classmethod
    def setUpClass(cls):
        cls.client = make_client()

    def setUp(self):
        capture.wipe_all(keep_settings=True)
        db.set_setting("web_search_enabled", False)
        db.set_setting("enrichment_enabled", False)
        db.set_setting("notifications_enabled", False)

    # -- small helpers -----------------------------------------------------
    def api(self, method, path, **kwargs):
        headers = kwargs.pop("headers", {})
        merged = dict(auth_headers())
        merged.update(headers)
        return getattr(self.client, method)(path, headers=merged, **kwargs)

    def assertGrounded(self, payload):                       # noqa: N802
        self.assertTrue(payload.get("grounded"),
                        f"expected a grounded answer, got: {payload.get('answer')!r}")

    def assertHonest(self, payload):                         # noqa: N802
        self.assertFalse(payload.get("grounded"),
                         "expected an honest 'I don't know', got a grounded answer")
        text = (payload.get("answer") or "").lower().replace("’", "'")
        self.assertTrue(any(marker in text for marker in
                            ("don't know", "do not know", "nothing in your",
                             "don't have anything", "no memory", "haven't",
                             "have not", "can't find", "empty right now")),
                        f"refusal wording missing: {payload.get('answer')!r}")


if __name__ == "__main__":
    unittest.main()
