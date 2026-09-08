"""Text pipeline units: cleaning, chunking, sentence selection, URL hygiene."""
from __future__ import annotations

import unittest

from tests.base import ROOT  # noqa: F401  (ensures sys.path)

from server import text as T


class CleanTextTests(unittest.TestCase):

    def test_hard_wraps_are_rejoined(self):
        raw = ("Hybrid retrieval combines BM25 with vector similarity and\n"
               "reciprocal rank fusion, because each signal covers the other.\n\n"
               "A new paragraph stays a paragraph.\n")
        cleaned = T.clean_text(raw)
        self.assertIn("vector similarity and reciprocal rank fusion", cleaned)
        self.assertIn("\n\n", cleaned, "paragraph breaks must survive")

    def test_lists_are_preserved(self):
        raw = "Steps:\n- feed the starter\n- bulk ferment\n- shape and retard\n"
        cleaned = T.clean_text(raw)
        self.assertIn("- feed the starter", cleaned)
        self.assertIn("- shape and retard", cleaned)

    def test_html_is_stripped_by_the_html_extractor(self):
        from server import html_extract
        raw = ("<html><body><p>Hello <b>world</b>, this is a test of the extractor "
               "with enough words to be considered content by the scorer.</p></body></html>")
        self.assertNotIn("<b>", html_extract.extract_text(raw))
        self.assertIn("Hello", html_extract.extract_text(raw))


class ChunkingTests(unittest.TestCase):

    def test_chunk_text_covers_everything(self):
        sentences = [f"Sentence number {i} about databases and indexes." for i in range(60)]
        chunks = T.chunk_text(" ".join(sentences))
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(isinstance(c, dict) and c.get("text") for c in chunks))
        joined = " ".join(c["text"] for c in chunks)
        self.assertIn("Sentence number 0", joined)
        self.assertIn("Sentence number 59", joined)


class SentenceTests(unittest.TestCase):

    def test_best_sentences_pick_on_topic_lines(self):
        doc = ("The sky is blue. "
               "SQLite FTS5 provides BM25 ranking over an inverted index. "
               "Cats sleep a lot. "
               "Vector similarity adds paraphrase tolerance to BM25 lexical matching. "
               "Bread rises in the oven.")
        best = T.best_sentences(doc, "BM25 vector similarity lexical matching", n=2)
        self.assertTrue(best)
        self.assertTrue(any("BM25" in s for s in best))
        self.assertFalse(any("Cats sleep" in s for s in best))


class QueryMatchingTests(unittest.TestCase):

    def test_request_words_are_filtered_from_matching(self):
        cleaned = T.clean_query_for_matching("what did I read about embeddings last week")
        for stopper in ("what", "did", "read", "last", "week", "about"):
            self.assertNotIn(stopper, cleaned.split())
        self.assertIn("embeddings", cleaned)

    def test_time_window_from_query(self):
        since, until, label = T.time_window_from_query("what did I read yesterday")
        self.assertTrue(since or until, "yesterday must produce a window")
        self.assertTrue(label)
        none_since, none_until, none_label = T.time_window_from_query("sqlite vectors")
        self.assertFalse(none_since or none_until or none_label)


class UrlTests(unittest.TestCase):

    def test_tracking_params_are_stripped(self):
        normalized = T.normalize_url(
            "https://Example.com/path?utm_source=x&fbclid=y&id=7#section")
        self.assertNotIn("utm_source", normalized)
        self.assertNotIn("fbclid", normalized)
        self.assertIn("id=7", normalized, "meaningful params stay")
        self.assertIn("example.com", normalized, "host is lowercased")

    def test_url_hash_is_stable(self):
        a = T.url_hash("https://example.com/a")
        b = T.url_hash("https://example.com/a")
        c = T.url_hash("https://example.com/b")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)


if __name__ == "__main__":
    unittest.main()
