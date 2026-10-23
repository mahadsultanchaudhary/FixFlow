"""Official MCP SDK server exposing FixFlow business operations over Streamable HTTP."""
from __future__ import annotations

import math

from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

from backend.app import services
from backend.app.config import frontend_origin
from backend.app.state_machine import WorkflowError

mcp = MCPServer(
    "FixFlow Repair Resolution",
    instructions=(
        "FixFlow is a simulated household repair-resolution agent. All repair partners, "
        "warranties, appointments, prices, and calendar data are local demo data. "
        "Never claim real service-provider contact or payment has occurred. Consequential "
        "booking and rescheduling actions require explicit repair-scoped approval."
    ),
)


def _run(fn, *args, **kwargs):
    """Return a predictable tool payload while avoiding raw exception leakage."""
    try:
        return {"ok": True, "data": fn(*args, **kwargs)}
    except (WorkflowError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "error_type": "workflow_error"}
    except Exception:
        # Detailed traces stay in the backend log; tool clients get a safe message.
        import logging

        logging.getLogger(__name__).exception("FixFlow MCP tool failed")
        return {
            "ok": False,
            "error": "The repair operation failed. Check the local backend log.",
            "error_type": "internal_error",
        }


@mcp.tool()
def create_repair(
    asset_id: str,
    title: str,
    description: str,
    original_report: str,
    priority: str = "NORMAL",
) -> dict:
    """Create a persistent repair incident for a known household asset."""
    return _run(
        services.create_repair, asset_id, title, description, original_report, priority
    )


@mcp.tool()
def get_repair(incident_id: str) -> dict:
    """Retrieve a repair incident with its chronological timeline."""
    return _run(services.get_repair, incident_id)


@mcp.tool()
def list_active_repairs() -> dict:
    """List all repair cases that are not closed, including unresolved and awaiting-confirmation cases."""
    return _run(services.list_active_repairs)


@mcp.tool()
def get_repair_history(incident_id: str) -> dict:
    """Retrieve current and previous repair history for the same appliance."""
    return _run(services.get_repair_history, incident_id)


@mcp.tool()
def check_warranty(asset_id: str) -> dict:
    """Check the simulated warranty record for a household asset."""
    return _run(services.check_warranty, asset_id)


@mcp.tool()
def find_vendors(asset_id: str) -> dict:
    """Find simulated repair partners relevant to the specified household asset."""
    return _run(services.find_vendors, asset_id)


@mcp.tool()
def compare_vendors(asset_id: str) -> dict:
    """Compare simulated repair partners, reliability, household history, price, and warranty support."""
    return _run(services.compare_vendors, asset_id)


@mcp.tool()
def select_vendor(
    incident_id: str,
    vendor_name: str,
    budget_limit: float = 250.0,
    require_brand_authorized: bool = True,
) -> dict:
    """Select and validate a named simulated repair partner for one repair; does not propose or book a slot."""
    def _select() -> dict:
        detail = services.get_repair(incident_id)
        comparison = services.compare_vendors(detail["repair"]["asset_id"])
        query = " ".join(vendor_name.casefold().split())
        vendors = comparison.get("vendors", [])
        matches = [v for v in vendors if " ".join(str(v.get("name", "")).casefold().split()) == query]
        if not matches:
            matches = [v for v in vendors if query and query in " ".join(str(v.get("name", "")).casefold().split())]
        if len(matches) != 1:
            raise WorkflowError("Repair partner name did not identify exactly one simulated provider")
        vendor = dict(matches[0])
        try:
            budget = float(budget_limit)
        except (TypeError, ValueError) as exc:
            raise WorkflowError("budget_limit must be a valid amount") from exc
        if not math.isfinite(budget) or budget < 0 or budget > 100000:
            raise WorkflowError("budget_limit must be a finite amount between $0 and $100,000")
        repair_cost = float(vendor.get("estimated_repair_cost") or 0)
        visit_fee = float(vendor.get("estimated_visit_fee") or 0)
        total = float(vendor.get("estimated_total_cost") or (repair_cost + visit_fee))
        reasons: list[str] = []
        if total > budget:
            reasons.append(f"Estimated all-in cost ${total:.0f} exceeds your ${budget:.0f} budget")
        if require_brand_authorized and not bool(vendor.get("brand_authorized")):
            reasons.append("Repair partner is not marked brand-authorized in the simulated records")
        return {
            "incident_id": incident_id,
            "vendor": vendor,
            "eligible": not reasons,
            "selected": not reasons,
            "estimated_total_cost": total,
            "budget_limit": budget,
            "require_brand_authorized": require_brand_authorized,
            "exclusion_reasons": reasons,
            "simulated": True,
        }
    return _run(_select)


@mcp.tool()
def prepare_proposal(
    incident_id: str,
    vendor_id: str,
    slot_id: str,
    budget_limit: float = 250.0,
    require_brand_authorized: bool = True,
) -> dict:
    """Prepare a persisted appointment proposal from a specific available slot; never books it."""
    return _run(services.propose_appointment, incident_id, vendor_id, slot_id, budget_limit, require_brand_authorized)


@mcp.tool()
def approve_proposal(incident_id: str, approval_id: str, note: str = "Explicit user approval") -> dict:
    """Approve exactly one persisted proposal for this repair; booking remains a separate tool call."""
    return _run(services.approve_action, incident_id, approval_id, "APPROVED", note)


@mcp.tool()
def record_vendor_no_show(
    incident_id: str,
    appointment_id: str | None = None,
    note: str = "User reported that the simulated repair partner did not arrive",
) -> dict:
    """Record a no-show using the incident's current appointment when appointment_id is omitted."""
    def _record_current() -> dict:
        detail = services.get_repair(incident_id)["repair"]
        current = services.get_current_appointment(incident_id)
        if not current or not isinstance(current.get("appointment"), dict):
            raise WorkflowError("No scheduled visit found to mark as a no-show.")
        active = current["appointment"]
        active_id = str(active.get("id") or "")
        if not active_id or (appointment_id and appointment_id != active_id):
            raise WorkflowError("The supplied appointment is not the current appointment for this repair")
        repair_status = str(detail.get("status", "")).upper()
        appointment_status = str(active.get("status", "")).upper()
        # UI copy sometimes describes BOOKED as “visit scheduled”; accept that
        # documented alias without changing the canonical persisted state.
        if repair_status == "VISIT_SCHEDULED":
            repair_status = "BOOKED"
        if appointment_status == "NO_SHOW" and repair_status in {"NO_SHOW", "RESCHEDULING", "OPTIONS_READY", "WAITING_APPROVAL"}:
            return {"incident_id": incident_id, "appointment_id": active_id, "status": repair_status, "case_open": True, "idempotent": True}
        if repair_status not in {"BOOKED", "EXPECTED_VISIT"}:
            raise WorkflowError("No scheduled visit found to mark as a no-show.")
        if appointment_status != "BOOKED":
            raise WorkflowError("No scheduled visit found to mark as a no-show.")
        return services.record_no_show(incident_id, active_id, note)
    return _run(_record_current)


@mcp.tool()
def get_vendor_availability(vendor_id: str) -> dict:
    """List available simulated appointment slots for one repair partner."""
    return _run(services.get_vendor_availability, vendor_id)


@mcp.tool()
def check_calendar(
    starts_at: str, ends_at: str, household_id: str = "home-main"
) -> dict:
    """Check simulated household calendar conflicts for an ISO timestamp interval."""
    return _run(services.check_calendar, starts_at, ends_at, household_id)


@mcp.tool()
def propose_appointment(
    incident_id: str,
    vendor_id: str,
    slot_id: str,
    budget_limit: float = 250.0,
    require_brand_authorized: bool = True,
) -> dict:
    """Create a pending proposal matching all-in budget and authorization preferences; this does not book it."""
    return _run(services.propose_appointment, incident_id, vendor_id, slot_id, budget_limit, require_brand_authorized)


@mcp.tool()
def request_approval(incident_id: str, action_type: str, action_payload: dict) -> dict:
    """Record a repair-scoped approval request for a supported consequential action."""
    return _run(services.request_approval, incident_id, action_type, action_payload)


@mcp.tool()
def approve_action(
    incident_id: str, approval_id: str, decision: str, note: str = ""
) -> dict:
    """Approve or reject one pending action tied to this exact incident and approval ID."""
    return _run(services.approve_action, incident_id, approval_id, decision, note)


@mcp.tool()
def reject_action(
    incident_id: str, approval_id: str, note: str = "Rejected by user"
) -> dict:
    """Reject one pending action; no appointment is booked."""
    return _run(services.approve_action, incident_id, approval_id, "REJECTED", note)


@mcp.tool()
def book_appointment(incident_id: str, approval_id: str) -> dict:
    """Commit a simulated appointment only when its repair-scoped approval is already approved."""
    return _run(services.book_appointment, incident_id, approval_id)


@mcp.tool()
def record_no_show(
    incident_id: str,
    appointment_id: str,
    note: str = "Repair partner did not arrive",
) -> dict:
    """Record a simulated missed repair-partner visit while preserving it in history."""
    return _run(services.record_no_show, incident_id, appointment_id, note)


@mcp.tool()
def find_alternatives(
    incident_id: str,
    budget_limit: float = 250.0,
    require_brand_authorized: bool = True,
) -> dict:
    """Find calendar-compatible slots and report budget/authorization exclusions."""
    return _run(services.find_alternatives, incident_id, budget_limit, require_brand_authorized)


@mcp.tool()
def reschedule_appointment(
    incident_id: str,
    vendor_id: str,
    slot_id: str,
    budget_limit: float = 250.0,
    require_brand_authorized: bool = True,
) -> dict:
    """Propose a replacement slot matching budget and authorization filters; approval is required."""
    return _run(services.reschedule_appointment, incident_id, vendor_id, slot_id, budget_limit, require_brand_authorized)


@mcp.tool()
def update_repair_status(incident_id: str, status: str, note: str = "") -> dict:
    """Move a repair through an allowed workflow state; protected resolution states require dedicated tools."""
    return _run(services.update_repair_status, incident_id, status, note)


@mcp.tool()
def mark_repair_completed(
    incident_id: str,
    appointment_id: str,
    technician_note: str = "Simulated technician reports the repair is complete",
) -> dict:
    """Record a completed visit and move the case to awaiting user confirmation, never directly to resolved."""
    return _run(services.mark_completed, incident_id, appointment_id, technician_note)


@mcp.tool()
def confirm_resolution(incident_id: str, confirmed: bool, note: str = "") -> dict:
    """Record the user's explicit confirmation that the appliance is fixed; confirmation does not close the case."""
    return _run(services.confirm_resolution, incident_id, confirmed, note)


@mcp.tool()
def close_repair(incident_id: str, confirmed: bool) -> dict:
    """Close only a user-confirmed RESOLVED repair; its history remains stored."""
    return _run(services.close_repair, incident_id, confirmed)


@mcp.tool()
def get_current_appointment(incident_id: str) -> dict | None:
    """Retrieve the current appointment's repair partner, status, time, and estimate."""
    return _run(services.get_current_appointment, incident_id)


@mcp.tool()
def get_pending_approval(incident_id: str) -> dict | None:
    """Retrieve an actionable booking proposal so a pending approval card survives browser reloads."""
    return _run(services.get_pending_approval, incident_id)


@mcp.tool()
def get_conversation_history(incident_id: str) -> dict:
    """Retrieve the persisted conversation turns associated with one repair."""
    return _run(services.get_conversation_history, incident_id)


@mcp.tool()
def append_conversation_turn(
    incident_id: str, user_message: str, assistant_message: str,
    tool_name: str = "", tool_payload: dict | None = None,
) -> dict:
    """Persist a user command and deterministic agent reply in the repair conversation."""
    return _run(services.append_conversation_turn, incident_id, user_message, assistant_message, tool_name, tool_payload)


@mcp.tool()
def reset_demo_scenario() -> dict:
    """Reset local demo data to the deterministic washing-machine repair scenario."""
    return _run(services.reset_demo_scenario)


# Mount this child app at the FastAPI root (last route) so its public endpoint is
# exactly /mcp, rather than /mcp/ with a trailing-slash redirect.
transport_security = TransportSecuritySettings(
    allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*"],
    allowed_origins=[frontend_origin(), "http://127.0.0.1:5173"],
)
mcp_http_app = mcp.streamable_http_app(
    json_response=True,
    transport_security=transport_security,
)
