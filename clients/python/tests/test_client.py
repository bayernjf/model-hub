"""Tests for the model-hub Python client, using the shared contract fixture."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from urllib import error, request

from model_hub_client import ModelHubClient, ResolutionError

ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
)
FIXTURE = os.path.join(
    ROOT,
    "contracts",
    "fixtures",
    "models-response.example.json",
)

with open(FIXTURE, "r", encoding="utf-8") as fh:
    CATALOG = json.load(fh)


class FakeResponse:
    def __init__(self, body: dict):
        self._body = body

    def read(self) -> bytes:
        return json.dumps(self._body).encode("utf-8")


def make_opener(catalog=None, status=200, exc=None, etag_304=False):
    def opener(req: request.Request):
        if exc is not None:
            raise exc
        sent = {k.lower() for k, _ in req.header_items()}
        if etag_304 and "if-none-match" in sent:
            raise error.HTTPError(
                req.full_url, 304, "Not Modified", {}, None
            )
        return FakeResponse(catalog if catalog is not None else {})

    return opener


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_path = os.path.join(self.tmp.name, "cache.json")

    def tearDown(self):
        self.tmp.cleanup()

    def make_client(self, **kwargs):
        return ModelHubClient(
            hub_url="https://hub.local",
            token="tok",
            cache_path=self.cache_path,
            **kwargs,
        )

    def test_pull_and_list(self):
        client = self.make_client(
            opener=make_opener(catalog=CATALOG)
        )
        client.pull()
        self.assertEqual(len(client.list()), 3)
        self.assertEqual(len(client.list("text")), 2)
        self.assertEqual(client.revision, 42)

    def test_304_keeps_cached(self):
        client = self.make_client(
            opener=make_opener(catalog=CATALOG)
        )
        client.pull()
        # Second pull with the same revision gets 304.
        client2 = self.make_client(
            opener=make_opener(etag_304=True)
        )
        client2.pull()
        self.assertEqual(len(client2.list()), 3)

    def test_cache_fallback_when_unreachable(self):
        # Pre-populate the cache.
        client = self.make_client(
            opener=make_opener(catalog=CATALOG)
        )
        client.pull()
        # A new client that cannot reach the hub still uses the cache.
        client2 = self.make_client(
            opener=make_opener(exc=OSError("network down"))
        )
        client2.pull()
        self.assertEqual(len(client2.list()), 3)

    def test_resolve_alias(self):
        client = self.make_client(
            opener=make_opener(catalog=CATALOG)
        )
        client.pull()
        model = client.resolve("noul")
        self.assertEqual(model["model"], "ark-code-latest")

    def test_primary_modality(self):
        client = self.make_client(
            opener=make_opener(catalog=CATALOG)
        )
        client.pull()
        model = client.primary("image")
        self.assertEqual(model["model"], "doubao-seedream-4-0-250828")

    def test_resolve_fails_closed_without_source(self):
        client = self.make_client(
            opener=make_opener(exc=OSError("network down"))
        )
        client.pull()
        with self.assertRaises(ResolutionError):
            client.resolve("noul")


if __name__ == "__main__":
    unittest.main()
