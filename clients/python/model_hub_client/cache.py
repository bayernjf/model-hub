"""On-disk catalog cache with 0600 permissions (contains plaintext keys)."""

from __future__ import annotations

import json
import os
from typing import Any


def read_cache(path: str) -> dict[str, Any] | None:
    """Return the cached catalog, or None when absent or unreadable."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data.get("models"), list):
            return None
        return data
    except (OSError, ValueError):
        return None


def write_cache(path: str, data: dict[str, Any]) -> None:
    """Write the catalog cache with 0600 permissions."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    # Create/truncate with restrictive permissions.
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except Exception:
        os.close(fd)
        raise
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
