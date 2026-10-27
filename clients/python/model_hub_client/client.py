"""Project-side client for model-hub (pull, cache, resolve)."""

from __future__ import annotations

import json
from typing import Any, Callable
from urllib import error, request

from . import cache

# A callable that opens a urllib request (tests inject a fake).
Opener = Callable[[request.Request], Any]


class ModelHubError(Exception):
    """Raised for unrecoverable client errors."""


class ResolutionError(Exception):
    """Raised when no model can be resolved for an alias/modality."""


class ModelHubClient:
    def __init__(
        self,
        hub_url: str,
        token: str,
        cache_path: str,
        opener: Opener | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.hub_url = hub_url.rstrip("/")
        self.token = token
        self.cache_path = cache_path
        self.timeout = timeout
        self._opener = opener
        self._catalog: dict[str, Any] | None = cache.read_cache(cache_path)

    def _open(self, req: request.Request) -> Any:
        if self._opener is not None:
            return self._opener(req)
        return request.urlopen(req, timeout=self.timeout)

    def pull(self) -> None:
        """Pull the catalog; honors ETag/304 and falls back to cache."""
        headers = {"Authorization": f"Bearer {self.token}"}
        revision = self._catalog.get("revision") if self._catalog else None
        if revision is not None:
            headers["If-None-Match"] = f'"{revision}"'

        req = request.Request(
            f"{self.hub_url}/pub/v1/models",
            headers=headers,
            method="GET",
        )
        try:
            resp = self._open(req)
            data = json.loads(resp.read().decode("utf-8"))
            self._catalog = data
            cache.write_cache(self.cache_path, data)
        except error.HTTPError as exc:
            exc.close()
            if exc.code == 304:
                return
            # Other HTTP errors: keep the existing cache.
        except OSError:
            # Network errors: keep the existing cache.
            pass

    def list(self, modality: str | None = None) -> list[dict[str, Any]]:
        models = (
            list(self._catalog.get("models", [])) if self._catalog else []
        )
        if modality is not None:
            models = [
                m for m in models if modality in m.get("modalities", [])
            ]
        return models

    def resolve(self, alias: str) -> dict[str, Any]:
        for model in self.list():
            if model.get("alias") == alias:
                return model
        raise ResolutionError(
            f"no model resolved for alias {alias!r} "
            "(hub catalog unavailable)"
        )

    def primary(self, modality: str) -> dict[str, Any]:
        candidates = self.list(modality)
        for model in candidates:
            if model.get("role") == "primary":
                return model
        if candidates:
            return candidates[0]
        raise ResolutionError(
            f"no primary model for modality {modality!r}"
        )

    @property
    def revision(self) -> int | None:
        return self._catalog.get("revision") if self._catalog else None
