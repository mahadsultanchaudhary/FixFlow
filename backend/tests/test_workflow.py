"""Workflow safety and state-machine regression tests using isolated SQLite files."""
import json
import pytest
from backend.app.database import initialize_schema, connection_scope
from backend.app.seed import seed_demo_data
from backend.app import services
from backend.app.state_machine import WorkflowError, validate_transition

@pytest.fixture
def demo_db(tmp_path, monkeypatch):
    path=tmp_path/"fixflow-test.db"
    monkeypatch.setenv("DATABASE_PATH",str(path))
    initialize_schema(path); seed_demo_data(path,reset=True)
    return path

def test_seeded_repair_is_persistent_and_booked(demo_db):
    result=services.get_repair("repair-washer-2026-001")
    assert result["repair"]["status"]=="BOOKED"
    assert result["timeline"]
    with connection_scope(demo_db) as c:
        assert c.execute("SELECT COUNT(*) FROM incidents").fetchone()[0]==3

@pytest.mark.parametrize("old_status", [
    "CREATED",
    "BOOKED",
    "NO_SHOW",
    "IN_PROGRESS",
    "AWAITING_CONFIRMATION",
])
def test_unresolved_repair_cannot_be_closed(old_status):
    with pytest.raises(WorkflowError):
        validate_transition(old_status, "CLOSED")

def test_only_confirmed_resolved_repair_can_transition_to_closed():
    validate_transition("RESOLVED", "CLOSED")

def test_booking_requires_approval(demo_db):
    with pytest.raises(WorkflowError,match="Approval not found"):
        services.book_appointment("repair-washer-2026-001","not-an-approval")

def test_approval_is_scoped_to_incident(demo_db):
    with connection_scope(demo_db) as c:
        row=c.execute("SELECT id FROM approvals LIMIT 1").fetchone()
        other=c.execute("SELECT id FROM incidents WHERE id<>? LIMIT 1",("repair-washer-2026-001",)).fetchone()
    with pytest.raises(WorkflowError,match="Approval not found for this repair"):
        services.approve_action(other["id"],row["id"],"APPROVED")

def test_no_show_recovery_preserves_failed_appointment(demo_db):
    with connection_scope(demo_db) as c:
        appt=c.execute("SELECT id FROM appointments WHERE incident_id=?",("repair-washer-2026-001",)).fetchone()["id"]
    result=services.record_no_show("repair-washer-2026-001",appt)
    assert result["status"]=="NO_SHOW" and result["case_open"]
    alternatives=services.find_alternatives("repair-washer-2026-001")
    assert alternatives["options"] and alternatives["approval_required"]
    with connection_scope(demo_db) as c:
        assert c.execute("SELECT status FROM appointments WHERE id=?",(appt,)).fetchone()["status"]=="NO_SHOW"

def test_completion_is_not_resolution(demo_db):
    with connection_scope(demo_db) as c:
        appt=c.execute("SELECT id FROM appointments WHERE incident_id=?",("repair-washer-2026-001",)).fetchone()["id"]
    result=services.mark_completed("repair-washer-2026-001",appt)
    assert result["status"]=="AWAITING_CONFIRMATION" and not result["case_closed"]
    with pytest.raises(WorkflowError,match="Cannot close"):
        services.close_repair("repair-washer-2026-001",True)

def test_resolution_and_close_require_two_explicit_steps(demo_db):
    with connection_scope(demo_db) as c:
        appt=c.execute("SELECT id FROM appointments WHERE incident_id=?",("repair-washer-2026-001",)).fetchone()["id"]
    services.mark_completed("repair-washer-2026-001",appt)
    resolved=services.confirm_resolution("repair-washer-2026-001",True,"Confirmed fixed")
    assert resolved["status"]=="RESOLVED" and not resolved["closed"]
    closed=services.close_repair("repair-washer-2026-001",True)
    assert closed["status"]=="CLOSED" and closed["history_retained"]

def test_user_reporting_unresolved_repair_reopens_work(demo_db):
    incident_id="repair-washer-2026-001"
    with connection_scope(demo_db) as c:
        appointment_id=c.execute(
            "SELECT id FROM appointments WHERE incident_id=?",
            (incident_id,),
        ).fetchone()["id"]

    services.mark_completed(incident_id,appointment_id)
    result=services.confirm_resolution(incident_id,False,"The leak is still present.")

    assert result["status"]=="IN_PROGRESS"
    assert result["closed"] is False
    repair=services.get_repair(incident_id)["repair"]
    assert repair["status"]=="IN_PROGRESS"
    assert repair["booking_status"]=="COMPLETED"
    assert repair["current_appointment_id"]==appointment_id

def test_reset_is_repeatable(demo_db):
    first=services.reset_demo_scenario(); second=services.reset_demo_scenario()
    assert first["counts"]==second["counts"]
    assert services.get_repair("repair-washer-2026-001")["repair"]["status"]=="BOOKED"
