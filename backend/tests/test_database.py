"""Batch 1 tests for schema creation, persistence and deterministic seed data."""

from __future__ import annotations

from pathlib import Path
import sqlite3

from backend.app.database import SCHEMA_SQL, connection_scope, initialize_schema, table_counts
from backend.app.repositories import get_asset_warranty, get_incident, get_incident_history, list_incidents
from backend.app.seed import seed_demo_data


def test_initialize_and_seed_creates_demo_entities(tmp_path: Path) -> None:
    db_path = tmp_path / "fixflow-test.db"
    initialize_schema(db_path)
    counts = seed_demo_data(db_path)

    assert counts["households"] == 1
    assert counts["assets"] == 2
    assert counts["warranties"] == 2
    assert counts["vendors"] == 3
    assert counts["incidents"] == 3
    assert counts["appointments"] == 1
    assert counts["timeline_events"] >= 7

    incident = get_incident("repair-washer-2026-001", str(db_path))
    assert incident is not None
    assert incident["status"] == "BOOKED"
    assert incident["asset_name"] == "Washing machine"
    assert incident["current_vendor_name"] == "BrightFix Appliance Care"


def test_data_survives_connection_reopen(tmp_path: Path) -> None:
    db_path = tmp_path / "persistent.db"
    seed_demo_data(db_path)

    with connection_scope(db_path) as connection:
        first_count = connection.execute("SELECT COUNT(*) FROM incidents").fetchone()[0]
    with connection_scope(db_path) as connection:
        second_count = connection.execute("SELECT COUNT(*) FROM incidents").fetchone()[0]

    assert first_count == 3
    assert second_count == first_count
    assert get_incident("repair-washer-2026-001", str(db_path)) is not None


def test_reseeding_without_reset_does_not_duplicate_rows(tmp_path: Path) -> None:
    db_path = tmp_path / "idempotent.db"
    first = seed_demo_data(db_path)
    second = seed_demo_data(db_path)
    assert first == second


def test_reset_replaces_data_with_one_known_scenario(tmp_path: Path) -> None:
    db_path = tmp_path / "reset.db"
    seed_demo_data(db_path)
    with connection_scope(db_path) as connection:
        connection.execute(
            "INSERT INTO timeline_events(id, incident_id, event_type, title, description, details_json, created_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?)",
            ("event-extra-test", "repair-washer-2026-001", "TEST", "Extra", "Should be removed", "{}", "2099-01-01T00:00:00+00:00"),
        )

    reset_counts = seed_demo_data(db_path, reset=True)
    history = get_incident_history("repair-washer-2026-001", str(db_path))
    assert "event-extra-test" not in {event["id"] for event in history}
    assert reset_counts["incidents"] == 3
    assert reset_counts["appointments"] == 1


def test_history_and_warranty_queries_are_available(tmp_path: Path) -> None:
    db_path = tmp_path / "queries.db"
    seed_demo_data(db_path)

    history = get_incident_history("repair-washer-2026-001", str(db_path))
    warranty = get_asset_warranty("asset-washer-01", str(db_path))
    active = list_incidents(active_only=True, path=str(db_path))

    assert history
    assert history == sorted(history, key=lambda event: event["created_at"])
    assert warranty is not None and warranty["status"] == "ACTIVE"
    assert len(active) == 1
    assert active[0]["id"] == "repair-washer-2026-001"


def test_schema_enforces_foreign_keys_and_nonnegative_estimates(tmp_path: Path) -> None:
    db_path = tmp_path / "constraints.db"
    seed_demo_data(db_path)

    with connection_scope(db_path) as connection:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'"
        ).fetchone()[0]
        counts = table_counts(connection)

    assert version == "3"
    assert counts["vendors"] == 3


def test_schema_v1_database_migrates_vendor_pricing_fields(tmp_path: Path) -> None:
    """An existing schema-v1 SQLite file gains the new vendor columns in place."""
    db_path = tmp_path / "legacy-v1.db"
    old_schema = SCHEMA_SQL.replace(
        "    estimated_repair_cost REAL NOT NULL DEFAULT 0 CHECK (estimated_repair_cost >= 0),\n",
        "",
    ).replace(
        "    brand_authorized INTEGER NOT NULL DEFAULT 0 CHECK (brand_authorized IN (0, 1)),\n",
        "",
    )
    assert "estimated_repair_cost" not in old_schema
    assert "brand_authorized" not in old_schema

    with sqlite3.connect(db_path) as connection:
        connection.executescript(old_schema)
        connection.execute(
            "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1')"
        )

    initialize_schema(db_path)
    with connection_scope(db_path) as connection:
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(vendors)")}
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]

    assert {"estimated_repair_cost", "brand_authorized"} <= columns
    assert version == "3"
