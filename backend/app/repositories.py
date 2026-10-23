"""Small, explicit SQLite read helpers used by later application layers."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from backend.app.database import connection_scope


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def _decode_json_fields(record: dict[str, Any] | None, fields: tuple[str, ...]) -> dict[str, Any] | None:
    if record is None:
        return None
    for field in fields:
        if field in record and record[field] is not None:
            try:
                record[field.removesuffix("_json")] = json.loads(record[field])
            except (json.JSONDecodeError, TypeError):
                record[field.removesuffix("_json")] = {}
            del record[field]
    return record


def get_incident(incident_id: str, path: str | None = None) -> dict[str, Any] | None:
    """Fetch one incident with its household, asset and current repair-partner labels."""
    query = """
        SELECT i.*, h.name AS household_name, h.address_label AS household_location,
               a.name AS asset_name, a.asset_type, a.brand AS asset_brand,
               a.model AS asset_model, a.location AS asset_location,
               v.name AS current_vendor_name, v.name AS current_service_provider_name
        FROM incidents AS i
        JOIN households AS h ON h.id = i.household_id
        JOIN assets AS a ON a.id = i.asset_id
        LEFT JOIN vendors AS v ON v.id = i.current_vendor_id
        WHERE i.id = ?
    """
    with connection_scope(path) as connection:
        row = connection.execute(query, (incident_id,)).fetchone()
    return _row_to_dict(row)


def list_incidents(
    *, household_id: str = "home-main", active_only: bool = False, path: str | None = None
) -> list[dict[str, Any]]:
    """List incidents with useful display fields, newest updates first."""
    query = """
        SELECT i.*, a.name AS asset_name, a.location AS asset_location,
               v.name AS current_vendor_name, v.name AS current_service_provider_name
        FROM incidents AS i
        JOIN assets AS a ON a.id = i.asset_id
        LEFT JOIN vendors AS v ON v.id = i.current_vendor_id
        WHERE i.household_id = ?
    """
    params: list[Any] = [household_id]
    if active_only:
        query += " AND i.status <> 'CLOSED'"
    query += " ORDER BY i.updated_at DESC, i.created_at DESC"
    with connection_scope(path) as connection:
        rows = connection.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def get_incident_history(incident_id: str, path: str | None = None) -> list[dict[str, Any]]:
    """Return the chronological timeline for a single incident."""
    with connection_scope(path) as connection:
        rows = connection.execute(
            "SELECT * FROM timeline_events WHERE incident_id = ? ORDER BY created_at ASC, rowid ASC",
            (incident_id,),
        ).fetchall()
    return [_decode_json_fields(dict(row), ("details_json",)) or {} for row in rows]


def get_asset_warranty(asset_id: str, path: str | None = None) -> dict[str, Any] | None:
    """Return the most recently ending warranty record for an asset."""
    with connection_scope(path) as connection:
        row = connection.execute(
            "SELECT * FROM warranties WHERE asset_id = ? ORDER BY ends_on DESC LIMIT 1",
            (asset_id,),
        ).fetchone()
    return _row_to_dict(row)


def list_vendors(path: str | None = None) -> list[dict[str, Any]]:
    """Return simulated vendor records with decoded specialties."""
    with connection_scope(path) as connection:
        rows = connection.execute(
            "SELECT * FROM vendors ORDER BY is_preferred DESC, reliability_score DESC, name ASC"
        ).fetchall()
    return [_decode_json_fields(dict(row), ("specialties_json",)) or {} for row in rows]
