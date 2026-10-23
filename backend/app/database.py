"""SQLite schema and connection helpers for FixFlow.

This module deliberately uses Python's built-in sqlite3 module: no database
server or ORM is required for the local hackathon demo.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from backend.app.config import database_path as configured_database_path

SCHEMA_VERSION = 3

SCHEMA_SQL = r"""
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address_label TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    location TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    installed_on TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warranties (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'PENDING', 'UNKNOWN')),
    starts_on TEXT NOT NULL,
    ends_on TEXT NOT NULL,
    coverage_summary TEXT NOT NULL,
    service_fee REAL NOT NULL DEFAULT 0 CHECK (service_fee >= 0),
    claim_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    specialties_json TEXT NOT NULL DEFAULT '[]',
    reliability_score INTEGER NOT NULL CHECK (reliability_score BETWEEN 0 AND 100),
    previous_household_jobs INTEGER NOT NULL DEFAULT 0 CHECK (previous_household_jobs >= 0),
    typical_response_hours REAL NOT NULL DEFAULT 24 CHECK (typical_response_hours >= 0),
    estimated_visit_fee REAL NOT NULL DEFAULT 0 CHECK (estimated_visit_fee >= 0),
    estimated_repair_cost REAL NOT NULL DEFAULT 0 CHECK (estimated_repair_cost >= 0),
    brand_authorized INTEGER NOT NULL DEFAULT 0 CHECK (brand_authorized IN (0, 1)),
    warranty_supported INTEGER NOT NULL DEFAULT 0 CHECK (warranty_supported IN (0, 1)),
    rating REAL NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    notes TEXT NOT NULL DEFAULT '',
    is_preferred INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_blocks (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS vendor_slots (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'AVAILABLE'
        CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED', 'UNAVAILABLE')),
    price_estimate REAL NOT NULL CHECK (price_estimate >= 0),
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    original_report TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'CREATED', 'INVESTIGATING', 'VENDOR_SEARCH', 'WAITING_VENDOR',
        'OPTIONS_READY', 'WAITING_APPROVAL', 'BOOKED', 'EXPECTED_VISIT',
        'NO_SHOW', 'RESCHEDULING', 'WAITING_PART', 'IN_PROGRESS',
        'AWAITING_CONFIRMATION', 'RESOLVED', 'CLOSED'
    )),
    booking_status TEXT NOT NULL DEFAULT 'UNBOOKED' CHECK (booking_status IN (
        'UNBOOKED', 'PROPOSED', 'BOOKED', 'NO_SHOW', 'COMPLETED', 'RESOLVED', 'CLOSED'
    )),
    priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    current_vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
    current_appointment_id TEXT,
    next_action TEXT NOT NULL,
    unresolved_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    closed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL CHECK (action_type IN (
        'BOOK_APPOINTMENT', 'RESCHEDULE_APPOINTMENT', 'ACCEPT_QUOTE', 'AUTHORIZE_PAID_WORK'
    )),
    action_payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
    requested_by TEXT NOT NULL DEFAULT 'fixflow-agent',
    decided_by TEXT,
    decision_note TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
    slot_id TEXT REFERENCES vendor_slots(id) ON DELETE SET NULL,
    approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN (
        'PROPOSED', 'APPROVED', 'BOOKED', 'NO_SHOW', 'RESCHEDULED',
        'COMPLETED', 'CANCELLED'
    )),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    price_estimate REAL NOT NULL CHECK (price_estimate >= 0),
    user_approved INTEGER NOT NULL DEFAULT 0 CHECK (user_approved IN (0, 1)),
    vendor_response TEXT NOT NULL DEFAULT 'SIMULATED',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS timeline_events (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'FixFlow conversation',
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_payload_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_household_status
    ON incidents(household_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_asset
    ON incidents(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_incident_created
    ON timeline_events(incident_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_appointments_incident_created
    ON appointments(incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_incident_status
    ON approvals(incident_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_slots_vendor_start
    ON vendor_slots(vendor_id, starts_at, status);
CREATE INDEX IF NOT EXISTS idx_messages_session_created
    ON conversation_messages(session_id, created_at ASC);
"""


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    """Open a SQLite connection with foreign keys and named-row access enabled."""
    db_path = Path(path) if path is not None else configured_database_path()
    db_path = db_path.expanduser().resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=10.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


@contextmanager
def connection_scope(path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    """Yield a connection; commit on success, rollback on failure, always close."""
    connection = connect(path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _migrate_vendor_pricing_columns(connection: sqlite3.Connection) -> None:
    """Add vendor pricing/authorization fields to databases created by schema v1."""
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(vendors)").fetchall()
    }
    if "estimated_repair_cost" not in columns:
        connection.execute(
            "ALTER TABLE vendors ADD COLUMN estimated_repair_cost REAL NOT NULL DEFAULT 0 "
            "CHECK (estimated_repair_cost >= 0)"
        )
    if "brand_authorized" not in columns:
        connection.execute(
            "ALTER TABLE vendors ADD COLUMN brand_authorized INTEGER NOT NULL DEFAULT 0 "
            "CHECK (brand_authorized IN (0, 1))"
        )


def _migrate_incident_booking_status(connection: sqlite3.Connection) -> None:
    """Add a durable booking lifecycle to databases created before schema v3."""
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(incidents)").fetchall()
    }
    if "booking_status" not in columns:
        connection.execute(
            "ALTER TABLE incidents ADD COLUMN booking_status TEXT NOT NULL DEFAULT 'UNBOOKED' "
            "CHECK (booking_status IN ('UNBOOKED','PROPOSED','BOOKED','NO_SHOW','COMPLETED','RESOLVED','CLOSED'))"
        )
        # Infer existing lifecycle state from already-persisted incident state.
        # No repair history or appointment row is removed by this migration.
        connection.execute("""
            UPDATE incidents SET booking_status = CASE
                WHEN status IN ('WAITING_APPROVAL') THEN 'PROPOSED'
                WHEN status IN ('BOOKED','EXPECTED_VISIT') THEN 'BOOKED'
                WHEN status IN ('NO_SHOW','RESCHEDULING') THEN 'NO_SHOW'
                WHEN status IN ('IN_PROGRESS','AWAITING_CONFIRMATION') THEN 'COMPLETED'
                WHEN status = 'RESOLVED' THEN 'RESOLVED'
                WHEN status = 'CLOSED' THEN 'CLOSED'
                ELSE 'UNBOOKED'
            END
        """)


def initialize_schema(path: str | Path | None = None) -> Path:
    """Create or migrate the schema and record its version; safe to run repeatedly."""
    db_path = Path(path) if path is not None else configured_database_path()
    db_path = db_path.expanduser().resolve()
    with connection_scope(db_path) as connection:
        connection.executescript(SCHEMA_SQL)
        # CREATE TABLE IF NOT EXISTS does not change older tables. Apply additive
        # migrations before seed/reset inserts records using the current schema.
        _migrate_vendor_pricing_columns(connection)
        _migrate_incident_booking_status(connection)
        connection.execute(
            "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(SCHEMA_VERSION),),
        )
    return db_path


def table_counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Return counts for the core entities; useful in diagnostics and tests."""
    table_names = (
        "households", "assets", "warranties", "vendors", "calendar_blocks",
        "vendor_slots", "incidents", "approvals", "appointments", "timeline_events",
        "conversation_sessions", "conversation_messages",
    )
    return {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in table_names
    }
