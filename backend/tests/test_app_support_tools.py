"""Tests for browser-facing MCP support tools backed by SQLite."""

from __future__ import annotations

import pytest

from backend.app import services
from backend.app.database import connection_scope, initialize_schema
from backend.app.seed import seed_demo_data

DEMO_ID = "repair-washer-2026-001"


def _seed(tmp_path, monkeypatch):
    db_path = tmp_path / "fixflow-support.sqlite3"
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    initialize_schema(db_path)
    seed_demo_data(db_path, reset=True)
    return db_path


def test_current_appointment_and_pending_approval_are_grounded_in_database(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)

    current = services.get_current_appointment(DEMO_ID)
    assert current is not None
    assert current["appointment"]["id"] == "appointment-washer-booked"
    assert current["appointment"]["status"] == "BOOKED"
    assert current["appointment"]["vendor_name"] == "BrightFix Appliance Care"
    assert services.get_pending_approval(DEMO_ID) is None


def test_conversation_turns_persist_and_can_be_reloaded(tmp_path, monkeypatch):
    db_path = _seed(tmp_path, monkeypatch)

    initial = services.get_conversation_history(DEMO_ID)
    assert initial["session_id"] == "session-demo-main"
    assert len(initial["messages"]) == 2

    saved = services.append_conversation_turn(
        DEMO_ID,
        "What am I waiting for?",
        "The simulated vendor visit is booked; the repair stays open until fixed.",
        tool_name="get_repair",
        tool_payload={"status": "BOOKED"},
    )
    assert len(saved["messages"]) == 4
    assert saved["messages"][-2]["role"] == "user"
    assert saved["messages"][-1]["role"] == "assistant"
    assert saved["messages"][-1]["tool_name"] == "get_repair"
    assert saved["messages"][-1]["tool_payload"] == {"status": "BOOKED"}

    # A separate connection sees the committed conversation turn.
    with connection_scope(db_path) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM conversation_messages WHERE session_id=?",
            (saved["session_id"],),
        ).fetchone()[0]
    assert count == 4


def test_pending_approval_survives_reload_after_proposal(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)

    result = services.reschedule_appointment(
        DEMO_ID, "vendor-rapidhome", "slot-rapidhome-alt", budget_limit=400,
        require_brand_authorized=True,
    )
    pending = services.get_pending_approval(DEMO_ID)

    assert pending is not None
    assert pending["id"] == result["approval_id"]
    assert pending["approval_id"] == result["approval_id"]
    assert pending["status"] == "PENDING"
    assert pending["action_payload"]["appointment_id"] == result["appointment_id"]
    assert pending["action_payload"]["vendor_id"] == "vendor-rapidhome"


def test_seeded_vendor_preferences_cover_budget_and_brand_authorization(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    result = services.compare_vendors("asset-washer-01")
    vendors = {v["id"]: v for v in result["vendors"]}
    assert vendors["vendor-brightfix"]["estimated_repair_cost"] == 220
    assert vendors["vendor-brightfix"]["estimated_visit_fee"] == 25
    assert bool(vendors["vendor-brightfix"]["brand_authorized"])
    assert vendors["vendor-rapidhome"]["estimated_repair_cost"] == 325
    assert not bool(vendors["vendor-northstar"]["brand_authorized"])


def test_booking_proposal_enforces_budget_and_brand_authorization(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    with pytest.raises(Exception, match="exceeds your .* budget"):
        services.propose_appointment(DEMO_ID, "vendor-rapidhome", "slot-rapidhome-alt", budget_limit=250)
    with pytest.raises(Exception, match="exceeds your .* budget"):
        services.propose_appointment(DEMO_ID, "vendor-rapidhome", "slot-rapidhome-alt", budget_limit=350)
    with pytest.raises(Exception, match="not marked brand-authorized"):
        services.propose_appointment(DEMO_ID, "vendor-northstar", "slot-northstar-alt", budget_limit=250, require_brand_authorized=True)
    allowed = services.propose_appointment(DEMO_ID, "vendor-northstar", "slot-northstar-alt", budget_limit=250, require_brand_authorized=False)
    assert allowed["approval_id"]
    assert allowed["proposal"]["brand_authorized"] is False


def test_alternatives_explain_which_mock_vendors_fail_filters(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    with connection_scope() as conn:
        appointment_id = conn.execute("SELECT id FROM appointments WHERE incident_id=?", (DEMO_ID,)).fetchone()["id"]
    services.record_no_show(DEMO_ID, appointment_id)
    result = services.find_alternatives(DEMO_ID, budget_limit=250, require_brand_authorized=True)
    options = {item["vendor_id"]: item for item in result["options"]}
    assert options["vendor-brightfix"]["eligible"] is True
    assert options["vendor-brightfix"]["slot_id"] == "slot-brightfix-alt"
    assert options["vendor-brightfix"]["estimated_total_cost"] == 245
    assert options["vendor-rapidhome"]["estimated_total_cost"] == 360
    assert any("exceeds" in reason for reason in options["vendor-rapidhome"]["exclusion_reasons"])
    assert any("brand-authorized" in reason for reason in options["vendor-northstar"]["exclusion_reasons"])
    assert "slot-brightfix-booked" not in {item["slot_id"] for item in result["options"]}


def test_repeating_the_same_proposal_returns_the_same_persisted_approval(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    first = services.reschedule_appointment(
        DEMO_ID, "vendor-brightfix", "slot-brightfix-alt", budget_limit=250,
        require_brand_authorized=True,
    )
    second = services.reschedule_appointment(
        DEMO_ID, "vendor-brightfix", "slot-brightfix-alt", budget_limit=250,
        require_brand_authorized=True,
    )
    assert second["approval_id"] == first["approval_id"]
    assert second["appointment_id"] == first["appointment_id"]
    assert second["status"] == "PENDING"
    assert second["idempotent"] is True
    assert services.get_pending_approval(DEMO_ID)["approval_id"] == first["approval_id"]
