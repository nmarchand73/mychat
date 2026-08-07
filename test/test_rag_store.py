"""Unit + live tests for memory.rag_store."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from memory import rag_store  # noqa: E402


class RagStoreUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        self.store_path = self.data / "chunks.json"
        self._patchers = [
            mock.patch.object(rag_store, "DATA_DIR", self.data),
            mock.patch.object(rag_store, "STORE_PATH", self.store_path),
        ]
        for p in self._patchers:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self._patchers):
            p.stop()
        self._tmp.cleanup()

    def test_chunk_text_splits_long_input(self) -> None:
        text = ("word " * 500).strip()
        parts = rag_store.chunk_text(text, size=100, overlap=20)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(p) <= 100 for p in parts))

    def test_ingest_and_query_with_fake_embeddings(self) -> None:
        def fake_embed(text: str, model: str = rag_store.EMBED_MODEL) -> list[float]:
            # Deterministic tiny embedding from char histogram
            vec = [0.0] * 8
            for i, ch in enumerate(text.lower()[:64]):
                vec[i % 8] += (ord(ch) % 13) / 13.0
            return vec

        with mock.patch.object(rag_store, "_ollama_embed", side_effect=fake_embed):
            added = rag_store.ingest(
                "Silo is an Apple TV science-fiction series set in a vault.",
                source="unit",
            )
            self.assertTrue(added["ok"])
            self.assertEqual(added["added"], 1)

            hits = rag_store.query("science fiction vault series", top_k=3)
            self.assertGreaterEqual(len(hits["hits"]), 1)
            self.assertIn("Silo", hits["hits"][0]["text"])

            listed = rag_store.list_chunks()
            self.assertEqual(listed["count"], 1)
            cid = listed["chunks"][0]["id"]
            deleted = rag_store.delete(cid)
            self.assertTrue(deleted["ok"])
            self.assertEqual(rag_store.list_chunks()["count"], 0)

    def test_query_empty_store(self) -> None:
        with mock.patch.object(rag_store, "_ollama_embed", return_value=[1.0, 0.0, 0.0]):
            out = rag_store.query("anything")
            self.assertEqual(out["hits"], [])


@unittest.skipUnless(
    rag_store.health().get("embed_ready"),
    "nomic-embed-text not available in Ollama",
)
class RagStoreLiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        self.store_path = self.data / "chunks.json"
        self._patchers = [
            mock.patch.object(rag_store, "DATA_DIR", self.data),
            mock.patch.object(rag_store, "STORE_PATH", self.store_path),
        ]
        for p in self._patchers:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self._patchers):
            p.stop()
        self._tmp.cleanup()

    def test_live_embed_roundtrip(self) -> None:
        rag_store.ingest(
            "MyChat local RAG stores notes with nomic-embed-text embeddings.",
            source="live-test",
        )
        hits = rag_store.query("embeddings for notes", top_k=2)
        self.assertTrue(hits["hits"], msg=json.dumps(hits))
        self.assertIn("nomic-embed-text", hits["hits"][0]["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
