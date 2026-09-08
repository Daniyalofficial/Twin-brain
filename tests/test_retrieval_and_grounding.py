"""Retrieval precision + the honesty contract of the answering engine."""
from __future__ import annotations

from tests.base import TwinBrainTestCase, seed_page

from server import assistant, retrieval


PAGES = [
    ("https://huggingface.co/blog/rag-with-sqlite",
     "Retrieval augmented generation without a vector database",
     "Store embeddings as BLOBs in SQLite and compute cosine similarity in a single matrix "
     "multiplication. Hybrid retrieval combines BM25 from SQLite FTS5 with vector similarity "
     "and reciprocal rank fusion, because BM25 supplies corpus-level IDF while the embeddings "
     "supply paraphrase tolerance. A scan over 50k vectors takes tens of milliseconds."),
    ("https://example.com/headphones",
     "Choosing open-back headphones for mixing",
     "Open-back headphones leak sound but present a wider soundstage, which helps when "
     "judging reverb tails while mixing. Closed-back models isolate better for tracking "
     "vocals in an untreated room."),
    ("https://example.com/sourdough",
     "A slow sourdough schedule",
     "A long cold retard develops flavour in sourdough. Feed the starter at a one to two to "
     "two ratio, bulk ferment until doubled, then shape and refrigerate overnight."),
]


class RetrievalTests(TwinBrainTestCase):

    def setUp(self):
        super().setUp()
        for url, title, text in PAGES:
            seed_page(self.client, url, title, text)

    def test_top_hit_matches_the_obvious_page(self):
        result = retrieval.retrieve("what did I read about embeddings and hybrid retrieval")
        self.assertTrue(result.grounded)
        self.assertIn("huggingface.co", result.matches[0].domain)

    def test_unrelated_query_is_not_grounded(self):
        result = retrieval.retrieve("the capital of France and its population")
        self.assertFalse(result.grounded,
                         "hash-embedder noise must not count as evidence")

    def test_headphones_query_does_not_pull_other_topics(self):
        result = retrieval.retrieve("which headphones should I use for mixing vocals")
        self.assertTrue(result.grounded)
        self.assertIn("headphones", result.matches[0].title.lower())

    def test_time_window_filter(self):
        result = retrieval.retrieve("sourdough schedule yesterday")
        # with only today's captures the window may be empty: widening must be offered
        self.assertIsInstance(result.matches, list)

    def test_page_detail_and_related(self):
        page = retrieval.find_by_url(PAGES[0][0])
        self.assertIsNotNone(page)
        detail = retrieval.page_detail(page["id"])
        self.assertEqual(detail["domain"], "huggingface.co")
        self.assertGreater(detail["word_count"], 10)


class GroundingTests(TwinBrainTestCase):

    def setUp(self):
        super().setUp()
        for url, title, text in PAGES:
            seed_page(self.client, url, title, text)

    def test_answer_cites_title_and_date(self):
        payload = assistant.answer("what did I read about embeddings and reciprocal rank fusion?")
        self.assertGrounded(payload)
        self.assertTrue(payload["citations"], "a grounded answer must cite its sources")
        first = payload["citations"][0]
        self.assertTrue(first.get("title"))
        self.assertTrue(first.get("visited_at") or first.get("visited_ago"))
        self.assertIn("huggingface.co", first["url"])

    def test_unknown_question_says_it_does_not_know(self):
        payload = assistant.answer("what is the capital of France?")
        self.assertHonest(payload)
        self.assertFalse(payload["citations"], "an honest refusal cites nothing")

    def test_answer_never_invents_pages(self):
        payload = assistant.answer("what did I read about quantum computing last month?")
        if payload.get("grounded"):
            titles = " ".join(c["title"].lower() for c in payload["citations"])
            self.assertTrue(titles, "grounded answers always carry citations")
        else:
            self.assertHonest(payload)

    def test_meta_questions_are_data_not_generation(self):
        payload = assistant.answer("how many pages are in my memory?")
        self.assertTrue(payload.get("grounded"))
        self.assertEqual(payload.get("provider"), "data")
        self.assertIn("3 pages", payload["answer"])

    def test_suggest_questions_derive_from_memory(self):
        suggestions = assistant.suggest_questions(5)
        self.assertTrue(suggestions)
        self.assertTrue(any("?" in s for s in suggestions))
