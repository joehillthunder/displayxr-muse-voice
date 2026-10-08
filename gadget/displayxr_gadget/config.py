"""Settings from the environment, with an optional .env file (values already set win)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_BRIDGE_URL = "ws://localhost:8791/ws"


def load_env_file(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Settings:
    bridge_url: str
    bridge_secret: str
    catalog_path: Path | None


def settings(env_file: Path | None = None) -> Settings:
    """Read BRIDGE_URL, BRIDGE_SECRET and DXR_CATALOG.

    The .env is looked for at DXR_ENV_FILE, then the given path, then the repo root next to
    this package (a source checkout).
    """
    candidates = [os.environ.get("DXR_ENV_FILE"), env_file,
                  Path(__file__).resolve().parents[2] / ".env"]
    for c in candidates:
        if c:
            load_env_file(Path(c))
    catalog = os.environ.get("DXR_CATALOG")
    if not catalog:
        guess = Path(__file__).resolve().parents[2] / "assets" / "catalog.json"
        catalog = str(guess) if guess.is_file() else ""
    return Settings(
        bridge_url=os.environ.get("BRIDGE_URL") or DEFAULT_BRIDGE_URL,
        bridge_secret=os.environ.get("BRIDGE_SECRET", ""),
        catalog_path=Path(catalog) if catalog else None,
    )


def catalog_names(path: Path | None) -> dict[str, list[str]]:
    """{"models": [...], "splats": [...]} from assets/catalog.json, or empty lists."""
    names: dict[str, list[str]] = {"models": [], "splats": []}
    if not path:
        return names
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return names
    for kind in names:
        table = data.get(kind)
        if isinstance(table, dict):
            names[kind] = sorted(table)
    return names
