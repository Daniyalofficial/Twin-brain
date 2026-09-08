"""The "at most 5 times a whole day" rule, digests and interest profiling."""
from __future__ import annotations

from tests.base import TwinBrainTestCase, seed_page

from server import db, digest, enrichment, interests


class BudgetTests(TwinBrainTestCase):

    def test_notification_budget_is_capped(self):
        db.set_setting("notification_daily_budget", 5)
        budget = digest.notification_budget()
        self.assertEqual(budget["budget"], 5)
        self.assertEqual(budget["used"], 0)
        self.assertEqual(budget["remaining"], 5)

    def test_notifications_stop_after_budget(self):
        db.set_setting("notification_daily_budget", 2)
        db.set_setting("notifications_enabled", True)
        made = 0
        for i in range(6):
            insight = digest.save_insight(kind="test", title=f"note {i}", body="body",
                                          dedupe_key=f"test:{i}")
            if digest.push_notification(insight):
                made += 1
        self.assertEqual(made, 2, "no more than the daily budget may notify")
        self.assertEqual(digest.notification_budget()["remaining"], 0)

    def test_enrichment_budget_defaults_to_five(self):
        budget = digest.insight_budget()
        self.assertEqual(budget["budget"], 5)

    def test_digest_summarises_the_day(self):
        seed_page(self.client, "https://example.com/one", "One",
                  "First page of reading about databases and indexes. " * 10, dwell=600)
        seed_page(self.client, "https://example.com/two", "Two",
                  "Second page about cooking sourdough bread at home. " * 10, dwell=300)
        activity = digest.daily_activity()
        self.assertEqual(activity["page_count"], 2)
        self.assertGreater(activity["dwell_seconds"], 0)
        text = digest.render_digest(activity)
        self.assertIn("2 pages", text)

    def test_digest_build_records_an_insight_once(self):
        seed_page(self.client, "https://example.com/three", "Three",
                  "Reading about vector databases and sqlite extensions. " * 10, dwell=400)
        first = digest.build_digest(notify=False)
        second = digest.build_digest(notify=False)
        self.assertTrue(first.get("digest"))
        rows = db.query("SELECT COUNT(*) AS c FROM insights WHERE kind='digest'")
        self.assertEqual(int(rows[0]["c"]), 1, "same-day digest must dedupe")
        self.assertTrue(second)


class InterestTests(TwinBrainTestCase):

    def test_profile_is_evidence_based(self):
        for i in range(4):
            seed_page(self.client, f"https://dev.example/sqlite-{i}", f"SQLite post {i}",
                      "sqlite vector index extension BM25 retrieval embedding " * 12,
                      dwell=500)
        seed_page(self.client, "https://food.example/bread", "Bread",
                  "sourdough starter crumb oven baking bread " * 12, dwell=200)
        interests.recompute()
        profile = interests.profile()
        labels = [t["label"] for t in profile["topics"]]
        self.assertTrue(any("sqlite" in label for label in labels), labels)
        sqlite_topic = next(t for t in profile["topics"] if "sqlite" in t["label"])
        self.assertTrue(sqlite_topic["evidence"], "every interest must carry evidence")
        self.assertGreaterEqual(sqlite_topic["pages"], 3)

    def test_habits_are_derived(self):
        seed_page(self.client, "https://example.com/h1", "H1", "reading habits text " * 12,
                  dwell=900)
        habits = interests.profile()["habits"]
        self.assertGreaterEqual(habits["visits_analysed"], 1)
        self.assertIn("peak_hour_label", habits)

    def test_enrichment_candidates_reference_only_your_pages(self):
        seed_page(self.client, "https://example.com/e1", "Vector databases in sqlite",
                  "sqlite vector search extension embedding cosine similarity " * 14,
                  dwell=1200)
        candidates = enrichment.growth_candidates(5)
        self.assertTrue(candidates)
        for candidate in candidates:
            self.assertTrue(candidate.get("page_id") or candidate.get("url"),
                            "a growth candidate must point at something you actually read")
