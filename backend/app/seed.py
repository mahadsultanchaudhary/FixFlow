"""Deterministic, resettable local demo data for FixFlow."""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from backend.app.config import database_path as configured_database_path
from backend.app.database import connection_scope, initialize_schema, table_counts


def _now() -> datetime:
    return datetime.now().astimezone().replace(microsecond=0)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _clear_demo_data(connection: sqlite3.Connection) -> None:
    """Delete demo entities in dependency order while keeping the schema."""
    for table in (
        "conversation_messages", "conversation_sessions", "timeline_events",
        "appointments", "approvals", "incidents", "vendor_slots", "calendar_blocks",
        "vendors", "warranties", "assets", "households",
    ):
        connection.execute(f"DELETE FROM {table}")


def _insert_many(connection: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    columns = tuple(rows[0].keys())
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    connection.executemany(sql, [tuple(row[column] for column in columns) for row in rows])


def seed_demo_data(path: str | Path | None = None, *, reset: bool = False) -> dict[str, int]:
    """Initialize schema and seed demo records; repeated calls do not duplicate rows.

    With reset=True all FixFlow domain records are replaced with a fresh scenario.
    The demo is simulated only. Date/time slots are based on the local clock so
    the first appointment remains in the future when the demo is reset.
    """
    db_path = Path(path) if path is not None else configured_database_path()
    db_path = initialize_schema(db_path)
    now = _now()

    with connection_scope(db_path) as connection:
        existing = connection.execute("SELECT COUNT(*) FROM households").fetchone()[0]
        if existing and not reset:
            return table_counts(connection)
        _clear_demo_data(connection)

        # A reproducible relative schedule: the first booked appointment is two
        # days after reset, and alternatives are available over the following days.
        first_day = (now + timedelta(days=2)).replace(hour=10, minute=0, second=0, microsecond=0)
        conflict_start = first_day + timedelta(days=1, hours=0, minutes=30)
        conflict_end = conflict_start + timedelta(hours=1)
        booked_start = first_day
        booked_end = booked_start + timedelta(hours=2)
        rapid_start = (first_day + timedelta(days=1)).replace(hour=14, minute=0)
        rapid_end = rapid_start + timedelta(hours=2)
        northstar_start = (first_day + timedelta(days=2)).replace(hour=9, minute=0)
        northstar_end = northstar_start + timedelta(hours=2)
        bright_alternate_start = (first_day + timedelta(days=2)).replace(hour=13, minute=0)
        bright_alternate_end = bright_alternate_start + timedelta(hours=2)
        created = _iso(now)

        _insert_many(connection, "households", [{
            "id": "home-main", "name": "The Chaudhary Household",
            "address_label": "Home · Laundry room", "timezone": "Asia/Karachi", "created_at": created,
        }])
        _insert_many(connection, "assets", [{
            "id": "asset-washer-01", "household_id": "home-main", "name": "Washing machine",
            "asset_type": "WASHING_MACHINE", "brand": "WhirlPro", "model": "WashMate 800",
            "location": "Laundry room", "serial_number": "DEMO-WM-800-0142",
            "installed_on": "2023-04-12", "created_at": created,
        }, {
            "id": "asset-dryer-01", "household_id": "home-main", "name": "Clothes dryer",
            "asset_type": "DRYER", "brand": "HomeSpin", "model": "DryCare 500",
            "location": "Laundry room", "serial_number": "DEMO-DR-500-0008",
            "installed_on": "2022-09-02", "created_at": created,
        }])
        _insert_many(connection, "warranties", [{
            "id": "warranty-washer-01", "asset_id": "asset-washer-01",
            "provider": "HomeShield (simulated)", "plan_name": "Appliance Care Plus",
            "status": "ACTIVE", "starts_on": "2025-01-01", "ends_on": "2027-12-31",
            "coverage_summary": "Leak diagnosis and eligible hose/seal parts; final coverage is subject to a simulated claim review.",
            "service_fee": 25.0, "claim_notes": "Demo warranty only; no real claim is submitted.", "created_at": created,
        }, {
            "id": "warranty-dryer-01", "asset_id": "asset-dryer-01",
            "provider": "HomeShield (simulated)", "plan_name": "Standard Appliance Cover",
            "status": "EXPIRED", "starts_on": "2022-09-02", "ends_on": "2024-09-01",
            "coverage_summary": "Historical demo warranty record; coverage has expired.",
            "service_fee": 0.0, "claim_notes": "Seeded history only.", "created_at": created,
        }])
        _insert_many(connection, "vendors", [{
            "id": "vendor-brightfix", "name": "BrightFix Appliance Care",
            "specialties_json": _json(["washing machines", "leaks", "hoses", "seals"]),
            "reliability_score": 92, "previous_household_jobs": 3, "typical_response_hours": 5.0,
            "estimated_visit_fee": 25.0, "estimated_repair_cost": 220.0, "brand_authorized": 1,
            "warranty_supported": 1, "rating": 4.8,
            "notes": "Preferred repair partner in this simulated household. High reliability; current appointment will be used to demonstrate no-show recovery.",
            "is_preferred": 1, "created_at": created,
        }, {
            "id": "vendor-rapidhome", "name": "RapidHome Repairs",
            "specialties_json": _json(["washing machines", "same-week visits", "leaks"]),
            "reliability_score": 86, "previous_household_jobs": 1, "typical_response_hours": 9.0,
            "estimated_visit_fee": 35.0, "estimated_repair_cost": 325.0, "brand_authorized": 1,
            "warranty_supported": 0, "rating": 4.5,
            "notes": "Faster alternative; warranty reimbursement is not guaranteed.",
            "is_preferred": 0, "created_at": created,
        }, {
            "id": "vendor-northstar", "name": "Northstar Appliance Service",
            "specialties_json": _json(["washing machines", "diagnostics", "replacement parts"]),
            "reliability_score": 89, "previous_household_jobs": 2, "typical_response_hours": 12.0,
            "estimated_visit_fee": 30.0, "estimated_repair_cost": 180.0, "brand_authorized": 0,
            "warranty_supported": 1, "rating": 4.7,
            "notes": "Warranty-compatible simulated option with parts diagnostics.",
            "is_preferred": 0, "created_at": created,
        }])
        _insert_many(connection, "calendar_blocks", [{
            "id": "calendar-work-block-01", "household_id": "home-main",
            "title": "Work call", "starts_at": _iso(conflict_start), "ends_at": _iso(conflict_end),
            "notes": "Simulated calendar conflict. This block is not from a real calendar account.",
        }])
        _insert_many(connection, "vendor_slots", [{
            "id": "slot-brightfix-booked", "vendor_id": "vendor-brightfix",
            "starts_at": _iso(booked_start), "ends_at": _iso(booked_end),
            "label": "Preferred repair partner · morning visit", "status": "BOOKED", "price_estimate": 25.0,
            "details": "Seeded appointment used for the no-show recovery story.", "created_at": created,
        }, {
            "id": "slot-brightfix-conflict", "vendor_id": "vendor-brightfix",
            "starts_at": _iso(first_day + timedelta(days=1)), "ends_at": _iso(first_day + timedelta(days=1, hours=2)),
            "label": "Preferred repair partner · morning visit", "status": "AVAILABLE", "price_estimate": 25.0,
            "details": "Overlaps the household's simulated work-call block.", "created_at": created,
        }, {
            "id": "slot-rapidhome-alt", "vendor_id": "vendor-rapidhome",
            "starts_at": _iso(rapid_start), "ends_at": _iso(rapid_end),
            "label": "RapidHome · afternoon visit", "status": "AVAILABLE", "price_estimate": 35.0,
            "details": "Alternative appointment with no seeded household calendar conflict.", "created_at": created,
        }, {
            "id": "slot-northstar-alt", "vendor_id": "vendor-northstar",
            "starts_at": _iso(northstar_start), "ends_at": _iso(northstar_end),
            "label": "Northstar · morning visit", "status": "AVAILABLE", "price_estimate": 30.0,
            "details": "Warranty-compatible alternative appointment.", "created_at": created,
        }, {
            "id": "slot-brightfix-alt", "vendor_id": "vendor-brightfix",
            "starts_at": _iso(bright_alternate_start), "ends_at": _iso(bright_alternate_end),
            "label": "BrightFix · afternoon visit", "status": "AVAILABLE", "price_estimate": 25.0,
            "details": "Later preferred repair-partner alternative.", "created_at": created,
        }])

        active_id = "repair-washer-2026-001"
        old_id = "repair-washer-2025-004"
        old_created = _iso(now - timedelta(days=238))
        _insert_many(connection, "incidents", [{
            "id": active_id, "household_id": "home-main", "asset_id": "asset-washer-01",
            "title": "Washing machine leak", "description": "Water is collecting under the washer after a cycle.",
            "original_report": "My washing machine is leaking again.", "status": "BOOKED", "priority": "HIGH",
            "current_vendor_id": "vendor-brightfix", "current_appointment_id": "appointment-washer-booked",
            "next_action": "Wait for the scheduled visit; if the repair partner misses it, record the missed visit and find alternatives.",
            "unresolved_reason": "The leak has not been confirmed fixed.", "created_at": created,
            "updated_at": created, "resolved_at": None, "closed_at": None, "version": 1,
        }, {
            "id": old_id, "household_id": "home-main", "asset_id": "asset-washer-01",
            "title": "Washer drain hose leak", "description": "A small leak was traced to a loose drain-hose connection and tightened.",
            "original_report": "There was a small puddle behind the washing machine.", "status": "CLOSED", "priority": "NORMAL",
            "current_vendor_id": "vendor-brightfix", "current_appointment_id": None,
            "next_action": "No action required; historical repair is closed.",
            "unresolved_reason": "", "created_at": old_created,
            "updated_at": _iso(now - timedelta(days=230)), "resolved_at": _iso(now - timedelta(days=230)),
            "closed_at": _iso(now - timedelta(days=230)), "version": 4,
        }, {
            "id": "repair-dryer-2024-002", "household_id": "home-main", "asset_id": "asset-dryer-01",
            "title": "Dryer making a rattling noise", "description": "A drum panel was secured and the noise stopped.",
            "original_report": "The dryer started rattling during a cycle.", "status": "CLOSED", "priority": "LOW",
            "current_vendor_id": "vendor-northstar", "current_appointment_id": None,
            "next_action": "No action required; historical repair is closed.",
            "unresolved_reason": "", "created_at": _iso(now - timedelta(days=640)),
            "updated_at": _iso(now - timedelta(days=630)), "resolved_at": _iso(now - timedelta(days=630)),
            "closed_at": _iso(now - timedelta(days=630)), "version": 2,
        }])
        # Keep the incident-level booking lifecycle explicit as well as the
        # appointment-row status. This makes the current booking state cheap to
        # read while preserving every appointment in its own history.
        connection.execute("""
            UPDATE incidents SET booking_status = CASE
                WHEN status IN ('BOOKED','EXPECTED_VISIT') THEN 'BOOKED'
                WHEN status IN ('NO_SHOW','RESCHEDULING') THEN 'NO_SHOW'
                WHEN status = 'WAITING_APPROVAL' THEN 'PROPOSED'
                WHEN status IN ('IN_PROGRESS','AWAITING_CONFIRMATION') THEN 'COMPLETED'
                WHEN status = 'RESOLVED' THEN 'RESOLVED'
                WHEN status = 'CLOSED' THEN 'CLOSED'
                ELSE 'UNBOOKED'
            END
        """)

        _insert_many(connection, "approvals", [{
            "id": "approval-initial-booking", "incident_id": active_id,
            "action_type": "BOOK_APPOINTMENT",
            "action_payload_json": _json({
                "appointment_id": "appointment-washer-booked", "vendor_id": "vendor-brightfix",
                "slot_id": "slot-brightfix-booked", "price_estimate": 25.0,
                "currency": "USD", "simulation": True,
            }),
            "status": "APPROVED", "requested_by": "fixflow-agent", "decided_by": "household-user",
            "decision_note": "Pre-approved as part of the deterministic demo setup; this is not payment authorization.",
            "requested_at": created, "decided_at": created, "idempotency_key": "seed:initial-booking",
        }])
        _insert_many(connection, "appointments", [{
            "id": "appointment-washer-booked", "incident_id": active_id,
            "vendor_id": "vendor-brightfix", "slot_id": "slot-brightfix-booked",
            "approval_id": "approval-initial-booking", "status": "BOOKED",
            "starts_at": _iso(booked_start), "ends_at": _iso(booked_end), "price_estimate": 25.0,
            "user_approved": 1, "vendor_response": "SIMULATED_CONFIRMED",
            "created_at": created, "updated_at": created,
        }])
        _insert_many(connection, "timeline_events", [{
            "id": "event-washer-created", "incident_id": active_id, "event_type": "INCIDENT_CREATED",
            "title": "Leak reported", "description": "FixFlow saved the recurring washing-machine leak as an active repair.",
            "details_json": _json({"source": "seeded_demo", "original_report": "My washing machine is leaking again."}),
            "created_at": created,
        }, {
            "id": "event-washer-history", "incident_id": active_id, "event_type": "HISTORY_RETRIEVED",
            "title": "Previous repair found", "description": "A prior drain-hose leak was recorded and closed after the connection was tightened.",
            "details_json": _json({"related_incident_id": old_id}), "created_at": _iso(now + timedelta(seconds=1)),
        }, {
            "id": "event-washer-warranty", "incident_id": active_id, "event_type": "WARRANTY_CHECKED",
            "title": "Simulated warranty checked", "description": "The seeded warranty is active; the demo fee estimate is $25 and coverage is subject to a simulated claim review.",
            "details_json": _json({"warranty_id": "warranty-washer-01", "simulated": True}),
            "created_at": _iso(now + timedelta(seconds=2)),
        }, {
            "id": "event-washer-calendar", "incident_id": active_id, "event_type": "CALENDAR_CHECKED",
            "title": "Calendar conflict identified", "description": "A separate repair-partner slot overlaps a simulated work call; the booked slot does not overlap it.",
            "details_json": _json({"calendar_block_id": "calendar-work-block-01", "simulated": True}),
            "created_at": _iso(now + timedelta(seconds=3)),
        }, {
            "id": "event-washer-approved", "incident_id": active_id, "event_type": "APPOINTMENT_BOOKED",
            "title": "Visit approved and booked", "description": "The demo user approved a BrightFix visit. Booking is not proof that the repair is complete.",
            "details_json": _json({"appointment_id": "appointment-washer-booked", "approval_id": "approval-initial-booking", "price_estimate": 25.0}),
            "created_at": _iso(now + timedelta(seconds=4)),
        }])
        _insert_many(connection, "timeline_events", [{
            "id": "event-washer-old-created", "incident_id": old_id, "event_type": "INCIDENT_CREATED",
            "title": "Historical leak reported", "description": "The earlier drain-hose leak was recorded.",
            "details_json": _json({"historical": True}), "created_at": old_created,
        }, {
            "id": "event-washer-old-resolved", "incident_id": old_id, "event_type": "INCIDENT_CLOSED",
            "title": "Previous repair closed", "description": "The household confirmed the leak had stopped after the hose connection was tightened.",
            "details_json": _json({"historical": True, "user_confirmed": True}),
            "created_at": _iso(now - timedelta(days=230)),
        }])
        _insert_many(connection, "conversation_sessions", [{
            "id": "session-demo-main", "household_id": "home-main", "incident_id": active_id,
            "title": "Washing machine repair demo", "context_json": _json({"active_incident_id": active_id, "mode": "deterministic_demo"}),
            "created_at": created, "updated_at": created,
        }])
        _insert_many(connection, "conversation_messages", [{
            "id": "message-demo-user-001", "session_id": "session-demo-main", "role": "user",
            "content": "My washing machine is leaking again.", "tool_name": None,
            "tool_payload_json": None, "created_at": created,
        }, {
            "id": "message-demo-assistant-001", "session_id": "session-demo-main", "role": "assistant",
            "content": "I found the previous hose repair and an active simulated warranty. A preferred repair-partner visit is booked, but I will keep the case open until you confirm the leak is fixed.",
            "tool_name": None, "tool_payload_json": None, "created_at": _iso(now + timedelta(seconds=5)),
        }])

        # Keep the incident's update timestamp human-readable and align all seeded
        # timeline order even though rows are intentionally inserted together.
        connection.execute("UPDATE incidents SET updated_at = ? WHERE id = ?", (_iso(now + timedelta(seconds=5)), active_id))
        return table_counts(connection)


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize or reset FixFlow's local demo database.")
    parser.add_argument("--reset", action="store_true", help="replace existing domain records with fresh demo data")
    parser.add_argument("--db", type=Path, default=None, help="optional SQLite database path")
    args = parser.parse_args()
    counts = seed_demo_data(args.db, reset=args.reset)
    actual_path = args.db.expanduser().resolve() if args.db else configured_database_path()
    print(f"FixFlow database ready: {actual_path}")
    for table, count in counts.items():
        print(f"{table}: {count}")


if __name__ == "__main__":
    main()
