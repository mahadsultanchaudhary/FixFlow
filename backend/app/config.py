"""Small, dependency-free configuration helpers for local development."""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE_PATH = PROJECT_ROOT / "backend" / "fixflow.db"


def database_path() -> Path:
    """Return the configured SQLite path, resolved relative to the project root."""
    configured = os.getenv("DATABASE_PATH", str(DEFAULT_DATABASE_PATH)).strip()
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()


def frontend_origin() -> str:
    """Return the single local frontend origin allowed by the dev CORS config."""
    return os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").strip().rstrip("/")
