"""Validated incident transitions and safe, auditable repair actions."""
from __future__ import annotations
from datetime import datetime, timezone

TERMINAL = {"CLOSED"}
ALLOWED = {
    "CREATED": {"INVESTIGATING", "VENDOR_SEARCH", "WAITING_APPROVAL"},
    "INVESTIGATING": {"VENDOR_SEARCH", "WAITING_VENDOR", "WAITING_APPROVAL"},
    "VENDOR_SEARCH": {"WAITING_VENDOR", "OPTIONS_READY", "WAITING_APPROVAL"},
    "WAITING_VENDOR": {"OPTIONS_READY", "WAITING_APPROVAL", "BOOKED", "NO_SHOW"},
    "OPTIONS_READY": {"WAITING_APPROVAL", "RESCHEDULING"},
    "WAITING_APPROVAL": {"OPTIONS_READY", "BOOKED", "RESCHEDULING"},
    "BOOKED": {"EXPECTED_VISIT", "NO_SHOW", "IN_PROGRESS", "RESCHEDULING", "WAITING_APPROVAL"},
    "EXPECTED_VISIT": {"NO_SHOW", "IN_PROGRESS", "RESCHEDULING", "WAITING_APPROVAL"},
    "NO_SHOW": {"RESCHEDULING"},
    "RESCHEDULING": {"OPTIONS_READY", "WAITING_APPROVAL", "BOOKED"},
    "WAITING_PART": {"IN_PROGRESS", "RESCHEDULING"},
    "IN_PROGRESS": {"WAITING_PART", "AWAITING_CONFIRMATION", "RESCHEDULING"},
    "AWAITING_CONFIRMATION": {"IN_PROGRESS", "RESOLVED"},
    "RESOLVED": {"CLOSED"},
    "CLOSED": set(),
}
class WorkflowError(ValueError):
    """Raised when a requested workflow operation is unsafe or invalid."""

def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

def validate_transition(old: str, new: str) -> None:
    if new not in ALLOWED.get(old, set()):
        raise WorkflowError(f"Invalid repair transition: {old} -> {new}")
