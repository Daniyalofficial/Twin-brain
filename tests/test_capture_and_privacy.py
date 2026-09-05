"""Privacy guarantees: exclusions filter BEFORE storage, forget is durable."""
from __future__ import annotations

from tests.base import TwinBrainTestCase, seed_page

from server import capture, db


class CapturePrivacyTests(TwinBrainTestCase):

    def test_capture_roundtrip_stores_text_and_visit(self):
        out = seed_page(self.client, "https://example.com/a", "Page A",
                        "Words about sqlite vector search and BM25 hybrid retrieval. " * 8)
        self.assertTrue(out.get("stored"))
        stats = db.stats()
        self.assertEqual(stats["pages"], 1)
        self.assertGreaterEqual(stats["chunks"], 1)
        self.assertEqual(stats["visits"], 1)

    def test_repeat_visit_is_logged_not_duplicated(self):
        seed_page(self.client, "https://example.com/a", "Page A", "Some reading text here. " * 10)
        seed_page(self.client, "https://example.com/a", "Page A", "Some reading text here. " * 10)
        stats = db.stats()
        self.assertEqual(stats["pages"], 1, "same URL must not create two pages")
        self.assertEqual(stats["visits"], 2, "every visit is logged (never forget)")

    def test_off_mode_never_stores_anything(self):
        capture.set_domain_mode("secret.example", "off")
        response = self.api("post", "/api/capture", json={
            "url": "https://secret.example/private", "title": "Private",
            "text": "This must never be written to disk. " * 10})
        body = response.get_json()
        self.assertFalse(body.get("stored"))
        self.assertEqual(db.stats()["pages"], 0, "excluded content must not touch storage")

    def test_no_ai_stores_link_but_hides_content_from_retrieval(self):
        capture.set_domain_mode("journal.example", "no_ai")
        seed_page(self.client, "https://journal.example/entry", "Therapy notes",
                  "Deeply personal notes about my health and family. " * 12)
        stats = db.stats()
        self.assertEqual(stats["pages"], 1, "the link is kept so it can be found")
        self.assertEqual(stats["hidden_from_ai"], 1)
        from server import retrieval
        result = retrieval.retrieve("personal notes about my health and family")
        self.assertFalse(any(m.domain == "journal.example" for m in result.matches),
                         "no_ai content must never reach retrieval")

    def test_forget_deletes_and_tombstones(self):
        seed_page(self.client, "https://example.com/b", "Page B", "Forget me please. " * 10)
        self.assertEqual(db.stats()["pages"], 1)
        response = self.api("post", "/api/forget", json={"url": "https://example.com/b"})
        self.assertTrue(response.get_json().get("ok"))
        self.assertEqual(db.stats()["pages"], 0)
        # re-capturing the same URL must be refused by the tombstone
        again = self.api("post", "/api/capture", json={
            "url": "https://example.com/b", "title": "Page B", "text": "Back again. " * 10})
        self.assertFalse(again.get_json().get("stored"),
                         "forgotten URLs must stay forgotten")

    def test_sensitive_url_markers_refused(self):
        for url in ("https://shop.example/checkout?step=2",
                    "https://bank.example/login",
                    "https://app.example/account/password?token=abc"):
            response = self.api("post", "/api/capture", json={
                "url": url, "title": "x", "text": "sensitive " * 20})
            self.assertFalse(response.get_json().get("stored"), url)
        self.assertEqual(db.stats()["pages"], 0)

    def test_default_blocklist_is_enforced(self):
        response = self.api("post", "/api/capture", json={
            "url": "https://www.hsbc.co.uk/personal", "title": "Bank", "text": "money " * 20})
        self.assertFalse(response.get_json().get("stored"))

    def test_capture_disabled_setting(self):
        db.set_setting("capture_enabled", False)
        response = self.api("post", "/api/capture", json={
            "url": "https://example.com/c", "title": "C", "text": "text " * 20})
        self.assertFalse(response.get_json().get("stored"))
        db.set_setting("capture_enabled", True)

    def test_heartbeat_mirrors_extension_domain_modes(self):
        seed_page(self.client, "https://mirror.example/x", "Mirror",
                  "A page whose domain the extension will mark hidden. " * 10)
        # the extension's list form
        response = self.api("post", "/api/heartbeat", json={
            "version": "1.0.0-test", "client_id": "unit",
            "counts": {"captured": 1},
            "domain_modes": [{"domain": "mirror.example", "mode": "no_ai"}]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(capture.domain_mode("mirror.example"), "no_ai")
        # and the equivalent mapping form, so no client shape can 500 the sync
        response = self.api("post", "/api/heartbeat", json={
            "domain_modes": {"mirror.example": "full"}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(capture.domain_mode("mirror.example"), "full")
        body = response.get_json()
        for key in ("settings", "notifications", "budgets", "stats", "suggestions"):
            self.assertIn(key, body)

    def test_export_and_import_roundtrip(self):
        seed_page(self.client, "https://example.com/d", "Page D", "Exportable content. " * 10)
        dump = self.api("get", "/api/export?include_text=1").get_json()
        self.assertEqual(len(dump["pages"]), 1)
        capture.wipe_all(keep_settings=True)
        self.assertEqual(db.stats()["pages"], 0)
        out = self.api("post", "/api/import", json={"dump": dump}).get_json()
        self.assertTrue(out.get("ok"))
        self.assertGreaterEqual(db.stats()["pages"], 1)
