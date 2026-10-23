"""Regression coverage for the select-vendor -> approve -> book path."""
from __future__ import annotations

from backend.app import services
from backend.app.database import connection_scope, initialize_schema
from backend.app.seed import seed_demo_data

DEMO_ID = "repair-washer-2026-001"


def _seed(tmp_path, monkeypatch):
    db_path = tmp_path / "fixflow-vendor-selection.sqlite3"
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    initialize_schema(db_path)
    seed_demo_data(db_path, reset=True)
    return db_path


def test_approved_vendor_selection_supersedes_old_booking_without_erasing_history(tmp_path, monkeypatch):
    db_path = _seed(tmp_path, monkeypatch)
    with connection_scope(db_path) as conn:
        incident = conn.execute("SELECT current_appointment_id FROM incidents WHERE id=?", (DEMO_ID,)).fetchone()
        previous_id = incident["current_appointment_id"]
        previous = conn.execute("SELECT slot_id,status FROM appointments WHERE id=?", (previous_id,)).fetchone()
        assert previous["status"] == "BOOKED"

    # Proposal creation alone must not cancel the appointment already on the calendar.
    proposal = services.reschedule_appointment(
        DEMO_ID,
        "vendor-brightfix",
        "slot-brightfix-alt",
        budget_limit=250,
        require_brand_authorized=True,
    )
    with connection_scope(db_path) as conn:
        assert conn.execute("SELECT status FROM appointments WHERE id=?", (previous_id,)).fetchone()["status"] == "BOOKED"

    approved = services.approve_action(DEMO_ID, proposal["approval_id"], "APPROVED", "Explicit user approval")
    assert approved["status"] == "APPROVED"
    booking = services.book_appointment(DEMO_ID, proposal["approval_id"])
    assert booking["status"] == "BOOKED"
    assert booking["appointment_id"] == proposal["appointment_id"]

    with connection_scope(db_path) as conn:
        old_row = conn.execute("SELECT status FROM appointments WHERE id=?", (previous_id,)).fetchone()
        new_row = conn.execute("SELECT status,user_approved FROM appointments WHERE id=?", (proposal["appointment_id"],)).fetchone()
        current = conn.execute("SELECT current_appointment_id,status FROM incidents WHERE id=?", (DEMO_ID,)).fetchone()
        replacement_event = conn.execute(
            "SELECT COUNT(*) AS n FROM timeline_events WHERE incident_id=? AND event_type='APPOINTMENT_SUPERSEDED'",
            (DEMO_ID,),
        ).fetchone()["n"]
    assert old_row["status"] == "RESCHEDULED"
    assert new_row["status"] == "BOOKED" and new_row["user_approved"] == 1
    assert current["current_appointment_id"] == proposal["appointment_id"]
    assert current["status"] == "BOOKED"
    assert services.get_repair(DEMO_ID)["repair"]["current_appointment_id"] == proposal["appointment_id"]
    assert services.get_current_appointment(DEMO_ID)["appointment"]["id"] == proposal["appointment_id"]
    assert replacement_event == 1


def test_repeated_booking_synchronizes_the_active_repair_snapshot(tmp_path, monkeypatch):
    db_path = _seed(tmp_path, monkeypatch)
    proposal = services.propose_appointment(
        DEMO_ID,
        "vendor-brightfix",
        "slot-brightfix-alt",
        budget_limit=250,
        require_brand_authorized=True,
    )
    services.approve_action(DEMO_ID, proposal["approval_id"], "APPROVED", "Explicit user approval")
    first_booking = services.book_appointment(DEMO_ID, proposal["approval_id"])

    # Simulate a stale incident row after the appointment itself was committed.
    with connection_scope(db_path) as conn:
        conn.execute(
            """UPDATE incidents SET status='WAITING_APPROVAL',booking_status='PROPOSED',
               current_appointment_id=NULL,current_vendor_id=NULL WHERE id=?""",
            (DEMO_ID,),
        )

    retry = services.book_appointment(DEMO_ID, proposal["approval_id"])
    repair = services.get_repair(DEMO_ID)["repair"]
    current = services.get_current_appointment(DEMO_ID)
    assert retry["idempotent"] is True
    assert repair["status"] == "BOOKED"
    assert repair["booking_status"] == "BOOKED"
    assert repair["current_appointment_id"] == first_booking["appointment_id"]
    assert current["appointment"]["id"] == proposal["appointment_id"]


def test_selecting_vendor_requires_approved_filter_and_budget_values_on_proposal(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    # Server-side policy is authoritative even if a browser card is manipulated.
    try:
        services.reschedule_appointment(
            DEMO_ID,
            "vendor-rapidhome",
            "slot-rapidhome-alt",
            budget_limit=250,
            require_brand_authorized=True,
        )
    except Exception as exc:
        assert "budget" in str(exc).lower()
    else:
        raise AssertionError("over-budget vendor must not create a proposal")
