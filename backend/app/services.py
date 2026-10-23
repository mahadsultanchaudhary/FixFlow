"""Business operations for FixFlow; all consequential mutations are persisted."""
from __future__ import annotations
import json, sqlite3, uuid, math
from datetime import datetime, timedelta
from typing import Any
from backend.app.config import database_path
from backend.app.database import connection_scope, initialize_schema
from backend.app.repositories import get_incident, get_incident_history, get_asset_warranty, list_incidents, list_vendors
from backend.app.seed import seed_demo_data
from backend.app.state_machine import WorkflowError, now_iso, validate_transition

ACTIVE_STATUSES = ("CREATED", "INVESTIGATING", "VENDOR_SEARCH", "WAITING_VENDOR", "OPTIONS_READY", "WAITING_APPROVAL", "BOOKED", "EXPECTED_VISIT", "NO_SHOW", "RESCHEDULING", "WAITING_PART", "IN_PROGRESS", "AWAITING_CONFIRMATION", "RESOLVED")

def _id(prefix: str) -> str: return f"{prefix}-{uuid.uuid4().hex[:12]}"
def _event(c, iid, kind, title, description, details=None):
    c.execute("INSERT INTO timeline_events(id,incident_id,event_type,title,description,details_json,created_at) VALUES(?,?,?,?,?,?,?)", (_id("evt"),iid,kind,title,description,json.dumps(details or {}),now_iso()))
def _incident(c, iid):
    row=c.execute("SELECT * FROM incidents WHERE id=?",(iid,)).fetchone()
    if not row: raise WorkflowError(f"Repair incident not found: {iid}")
    return dict(row)
def _booking_status_for_transition(status: str, current: str = "UNBOOKED") -> str:
    """Keep the durable appointment lifecycle aligned with repair transitions."""
    mapped = {
        "WAITING_APPROVAL": "PROPOSED",
        "BOOKED": "BOOKED",
        "EXPECTED_VISIT": "BOOKED",
        "NO_SHOW": "NO_SHOW",
        "AWAITING_CONFIRMATION": "COMPLETED",
        "RESOLVED": "RESOLVED",
        "CLOSED": "CLOSED",
    }
    return mapped.get(status, current or "UNBOOKED")


def _transition(c, incident, status, next_action, event_title, description, details=None):
    validate_transition(incident["status"],status)
    now=now_iso()
    booking_status = _booking_status_for_transition(status, incident.get("booking_status", "UNBOOKED"))
    c.execute("UPDATE incidents SET status=?,booking_status=?,next_action=?,updated_at=?,version=version+1 WHERE id=?",(status,booking_status,next_action,now,incident["id"]))
    _event(c,incident["id"],"STATUS_CHANGED",event_title,description,{"from":incident["status"],"to":status,"booking_status":booking_status,**(details or {})})
    return _incident(c,incident["id"])
def get_repair(incident_id: str):
    record=get_incident(incident_id)
    if not record: raise WorkflowError(f"Repair incident not found: {incident_id}")
    return {"repair":record,"timeline":get_incident_history(incident_id)}
def list_active_repairs(): return list_incidents(active_only=True)
def create_repair(asset_id: str, title: str, description: str, original_report: str, priority: str="NORMAL"):
    if priority not in {"LOW","NORMAL","HIGH","URGENT"}: raise WorkflowError("priority must be LOW, NORMAL, HIGH, or URGENT")
    with connection_scope() as c:
        asset=c.execute("SELECT * FROM assets WHERE id=?",(asset_id,)).fetchone()
        if not asset: raise WorkflowError(f"Asset not found: {asset_id}")
        iid=_id("repair"); now=now_iso()
        c.execute("INSERT INTO incidents(id,household_id,asset_id,title,description,original_report,status,priority,next_action,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(iid,asset["household_id"],asset_id,title.strip(),description.strip(),original_report.strip(),"CREATED",priority,"Investigate the issue and check warranty and repair history.",now,now))
        _event(c,iid,"REPAIR_CREATED","Repair case created",original_report,{"asset_id":asset_id})
        return _incident(c,iid)
def get_repair_history(incident_id: str):
    record=get_incident(incident_id)
    if not record: raise WorkflowError(f"Repair incident not found: {incident_id}")
    with connection_scope() as c:
        rows=c.execute("SELECT i.id,i.title,i.status,i.created_at,i.closed_at,i.resolved_at,i.original_report,a.name AS asset_name FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE i.asset_id=? ORDER BY i.created_at DESC",(record["asset_id"],)).fetchall()
    return [dict(r) for r in rows]
def check_warranty(asset_id: str):
    warranty=get_asset_warranty(asset_id)
    if not warranty: return {"asset_id":asset_id,"covered":False,"status":"UNKNOWN","message":"No warranty record exists."}
    return {"asset_id":asset_id,"covered":warranty["status"]=="ACTIVE","warranty":warranty,"simulated":True}
def find_vendors(asset_id: str):
    with connection_scope() as c:
        asset=c.execute("SELECT asset_type FROM assets WHERE id=?",(asset_id,)).fetchone()
        if not asset: raise WorkflowError(f"Asset not found: {asset_id}")
    asset_type = str(asset["asset_type"]).replace("_", " ").lower().strip()
    aliases = {
        "washing machine": {"washing machine", "washing machines", "washer", "washers", "appliance"},
        "dryer": {"dryer", "dryers", "clothes dryer", "appliance"},
    }
    asset_aliases = aliases.get(asset_type, {asset_type, "appliance"})
    found = []
    for vendor in list_vendors():
        specialties = [str(item).lower().strip() for item in (vendor.get("specialties") or [])]
        if not specialties or any(item in asset_aliases or item in {a.rstrip("s") for a in asset_aliases} or "appliance" in item for item in specialties):
            found.append(vendor)
    return found
def compare_vendors(asset_id: str):
    warranty=check_warranty(asset_id)
    vendors=find_vendors(asset_id)
    return {"simulated":True,"warranty":warranty,"vendors":[{**v,"warranty_relevant":bool(warranty.get("covered") and v.get("warranty_supported"))} for v in vendors]}
def get_vendor_availability(vendor_id: str):
    with connection_scope() as c:
        vendor=c.execute("SELECT * FROM vendors WHERE id=?",(vendor_id,)).fetchone()
        if not vendor: raise WorkflowError(f"Repair partner not found: {vendor_id}")
        slots=c.execute("SELECT * FROM vendor_slots WHERE vendor_id=? AND status='AVAILABLE' ORDER BY starts_at",(vendor_id,)).fetchall()
    return {"vendor":dict(vendor),"slots":[dict(s) for s in slots],"simulated":True}
def check_calendar(starts_at: str, ends_at: str, household_id: str="home-main"):
    if ends_at <= starts_at: raise WorkflowError("ends_at must be later than starts_at")
    with connection_scope() as c:
        conflicts=c.execute("SELECT * FROM calendar_blocks WHERE household_id=? AND starts_at < ? AND ends_at > ? ORDER BY starts_at",(household_id,ends_at,starts_at)).fetchall()
    return {"available":not conflicts,"conflicts":[dict(x) for x in conflicts],"simulated":True}
def propose_appointment(incident_id: str, vendor_id: str, slot_id: str, budget_limit: float = 250.0, require_brand_authorized: bool = True):
    with connection_scope() as c:
        i=_incident(c,incident_id)
        if i["status"]=="CLOSED" or i["status"]=="RESOLVED": raise WorkflowError("Cannot schedule a closed or resolved case")
        if not math.isfinite(float(budget_limit)) or budget_limit < 0 or budget_limit > 100000:
            raise WorkflowError("budget_limit must be a finite amount between $0 and $100,000")
        vendor=c.execute("SELECT * FROM vendors WHERE id=?",(vendor_id,)).fetchone()
        if not vendor: raise WorkflowError("The selected repair partner does not exist")
        repair_cost=float(vendor["estimated_repair_cost"])
        if require_brand_authorized and not bool(vendor["brand_authorized"]):
            raise WorkflowError("This repair partner is not marked brand-authorized in the simulated records; turn off the authorization filter only if you accept that trade-off")
        slot=c.execute("SELECT * FROM vendor_slots WHERE id=? AND vendor_id=?",(slot_id,vendor_id)).fetchone()
        if not slot: raise WorkflowError("The selected time slot does not belong to this repair partner")
        if slot["status"]!="AVAILABLE": raise WorkflowError("That appointment time is no longer available")
        # The slot's estimate is the fee for this appointment; use it instead of
        # assuming every time slot has the vendor's default visit fee.
        visit_fee=float(slot["price_estimate"])
        total_cost=repair_cost + visit_fee
        if total_cost > budget_limit:
            raise WorkflowError(f"Estimated total ${total_cost:.0f} (repair ${repair_cost:.0f} + visit fee ${visit_fee:.0f}) exceeds your ${budget_limit:.0f} budget")
        cal=check_calendar(slot["starts_at"],slot["ends_at"],i["household_id"])
        if not cal["available"]: raise WorkflowError("The proposed slot conflicts with the household calendar")
        existing=c.execute(
            """SELECT * FROM approvals WHERE incident_id=? AND status='PENDING'
               AND action_type IN ('BOOK_APPOINTMENT','RESCHEDULE_APPOINTMENT')
               ORDER BY requested_at DESC LIMIT 1""",
            (incident_id,),
        ).fetchone()
        if existing:
            # Repeated selection of the same slot is idempotent. This matters for
            # browser retries and reloads: return the canonical approval ID rather
            # than leaving the client with a stale or missing proposal reference.
            existing_payload = json.loads(existing["action_payload_json"] or "{}")
            if existing_payload.get("slot_id") == slot_id:
                return {
                    "approval_id": existing["id"],
                    "id": existing["id"],
                    "incident_id": incident_id,
                    "appointment_id": existing_payload.get("appointment_id"),
                    "action_type": existing["action_type"],
                    "status": existing["status"],
                    "proposal": existing_payload,
                    "idempotent": True,
                    "consequence": "This exact proposal was already saved. It still requires explicit approval.",
                }
            raise WorkflowError(
                "A booking proposal is already awaiting a decision. Approve or reject that exact proposal before choosing a different time."
            )
        aid=_id("approval"); appt=_id("appt"); now=now_iso()
        action="RESCHEDULE_APPOINTMENT" if i["status"] in {"NO_SHOW","RESCHEDULING","OPTIONS_READY","BOOKED","EXPECTED_VISIT","IN_PROGRESS","WAITING_PART"} else "BOOK_APPOINTMENT"
        payload={"appointment_id":appt,"vendor_id":vendor_id,"vendor_name":vendor["name"],"slot_id":slot_id,"starts_at":slot["starts_at"],"ends_at":slot["ends_at"],"price_estimate":float(slot["price_estimate"]),"estimated_visit_fee":visit_fee,"estimated_repair_cost":repair_cost,"estimated_total_cost":total_cost,"brand_authorized":bool(vendor["brand_authorized"]),"budget_limit":budget_limit,"require_brand_authorized":require_brand_authorized}
        c.execute("INSERT INTO approvals(id,incident_id,action_type,action_payload_json,status,requested_at,idempotency_key) VALUES(?,?,?,?,?,?,?)",(aid,incident_id,action,json.dumps(payload),"PENDING",now,f"{incident_id}:{action}:{slot_id}"))
        c.execute("INSERT INTO appointments(id,incident_id,vendor_id,slot_id,approval_id,status,starts_at,ends_at,price_estimate,user_approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(appt,incident_id,vendor_id,slot_id,aid,"PROPOSED",slot["starts_at"],slot["ends_at"],slot["price_estimate"],0,now,now))
        current=i
        if current["status"] in {"NO_SHOW","BOOKED","EXPECTED_VISIT","IN_PROGRESS","WAITING_PART"}:
            current=_transition(c,current,"RESCHEDULING","Choose a replacement appointment; explicit approval is required before booking.","Rescheduling started","FixFlow is preparing a replacement slot. No booking has been made.")
        _transition(c,current,"WAITING_APPROVAL","Review and explicitly approve or reject the proposed appointment.","Appointment proposed","FixFlow found a simulated slot. No booking has been made and no spending is authorized.",payload)
        return {"approval_id":aid,"id":aid,"incident_id":incident_id,"appointment_id":appt,"action_type":action,"status":"PENDING","proposal":payload,"consequence":"No booking or paid work occurs unless you explicitly approve this specific proposal."}
def request_approval(incident_id: str, action_type: str, action_payload: dict[str,Any]):
    allowed={"BOOK_APPOINTMENT","RESCHEDULE_APPOINTMENT","ACCEPT_QUOTE","AUTHORIZE_PAID_WORK"}
    if action_type not in allowed: raise WorkflowError(f"Unsupported approval action: {action_type}")
    with connection_scope() as c:
        _incident(c,incident_id)
        key=action_payload.get("idempotency_key") or f"{incident_id}:{action_type}:{json.dumps(action_payload,sort_keys=True)}"
        old=c.execute("SELECT * FROM approvals WHERE idempotency_key=?",(key,)).fetchone()
        if old: return dict(old)
        aid=_id("approval"); now=now_iso()
        c.execute("INSERT INTO approvals(id,incident_id,action_type,action_payload_json,status,requested_at,idempotency_key) VALUES(?,?,?,?,?,?,?)",(aid,incident_id,action_type,json.dumps(action_payload),"PENDING",now,key))
        return {"id":aid,"incident_id":incident_id,"action_type":action_type,"action_payload":action_payload,"status":"PENDING"}
def approve_action(incident_id: str, approval_id: str, decision: str, note: str=""):
    if decision not in {"APPROVED","REJECTED"}: raise WorkflowError("decision must be APPROVED or REJECTED")
    with connection_scope() as c:
        i=_incident(c,incident_id)
        approval=c.execute("SELECT * FROM approvals WHERE id=? AND incident_id=?",(approval_id,incident_id)).fetchone()
        if not approval: raise WorkflowError("Approval not found for this repair; cross-repair decisions are forbidden")
        if approval["status"]!="PENDING":
            if approval["status"]==decision: return {"approval_id":approval_id,"status":decision,"idempotent":True}
            raise WorkflowError(f"Approval already decided: {approval['status']}")
        payload=json.loads(approval["action_payload_json"]); now=now_iso()
        c.execute("UPDATE approvals SET status=?,decided_by='user',decision_note=?,decided_at=? WHERE id=?",(decision,note,now,approval_id))
        if decision=="REJECTED":
            c.execute("UPDATE appointments SET status='CANCELLED',updated_at=? WHERE approval_id=? AND status='PROPOSED'",(now,approval_id))
            c.execute("UPDATE vendor_slots SET status='AVAILABLE' WHERE id=? AND status='HELD'",(payload.get("slot_id"),))
            if i["status"]=="WAITING_APPROVAL":
                i = _transition(c,i,"OPTIONS_READY","Choose another option or ask FixFlow to find alternatives.","Proposal rejected","The user rejected this proposal. No booking was made.",{"approval_id":approval_id,"note":note})
            current = c.execute("SELECT status FROM appointments WHERE id=? AND incident_id=?", (i.get("current_appointment_id"), incident_id)).fetchone() if i.get("current_appointment_id") else None
            current_status = str(current["status"]).upper() if current else ""
            restored_booking_status = {
                "BOOKED": "BOOKED", "APPROVED": "BOOKED", "NO_SHOW": "NO_SHOW",
                "COMPLETED": "COMPLETED", "RESCHEDULED": "UNBOOKED", "CANCELLED": "UNBOOKED",
            }.get(current_status, "UNBOOKED")
            c.execute("UPDATE incidents SET booking_status=?,updated_at=? WHERE id=?", (restored_booking_status, now_iso(), incident_id))
            return {"approval_id":approval_id,"status":"REJECTED","booking_created":False,"booking_status":restored_booking_status}
        if approval["action_type"] in {"BOOK_APPOINTMENT","RESCHEDULE_APPOINTMENT"}:
            slot=c.execute("SELECT * FROM vendor_slots WHERE id=?",(payload.get("slot_id"),)).fetchone()
            if not slot or slot["status"]!="AVAILABLE": raise WorkflowError("The approved slot is no longer available; request a new proposal")
            cal=check_calendar(payload["starts_at"],payload["ends_at"],i["household_id"])
            if not cal["available"]: raise WorkflowError("Calendar conflict appeared before approval; choose another slot")
            c.execute("UPDATE appointments SET status='APPROVED',user_approved=1,updated_at=? WHERE id=? AND approval_id=?",(now,payload.get("appointment_id"),approval_id))
            return {"approval_id":approval_id,"status":"APPROVED","approved_action":approval["action_type"],"appointment_id":payload.get("appointment_id"),"ready_to_book":True,"message":"User approved this specific proposal. Call book_appointment to commit the simulated booking."}
        return {"approval_id":approval_id,"status":"APPROVED","approved_action":approval["action_type"],"message":"Approval recorded for this exact action."}
def book_appointment(incident_id: str, approval_id: str):
    with connection_scope() as c:
        i=_incident(c,incident_id)
        approval=c.execute("SELECT * FROM approvals WHERE id=? AND incident_id=?",(approval_id,incident_id)).fetchone()
        if not approval: raise WorkflowError("Approval not found for this repair")
        if approval["status"]!="APPROVED": raise WorkflowError("Booking is forbidden until this exact action has been approved")
        payload=json.loads(approval["action_payload_json"])
        if approval["action_type"] not in {"BOOK_APPOINTMENT","RESCHEDULE_APPOINTMENT"}: raise WorkflowError("This approval does not authorize appointment booking")
        appt=c.execute("SELECT * FROM appointments WHERE id=? AND approval_id=?",(payload.get("appointment_id"),approval_id)).fetchone()
        if not appt: raise WorkflowError("Proposed appointment is missing")
        if appt["status"]=="BOOKED":
            if not appt["user_approved"]:
                raise WorkflowError("Appointment is not in approved state")
            c.execute(
                """UPDATE incidents SET booking_status='BOOKED',current_appointment_id=?,
                   current_vendor_id=?,updated_at=?,version=version+1 WHERE id=?""",
                (appt["id"], appt["vendor_id"], now_iso(), incident_id),
            )
            fresh = _incident(c, incident_id)
            if fresh["status"] != "BOOKED":
                fresh = _transition(
                    c,
                    fresh,
                    "BOOKED",
                    "Wait for the scheduled visit; if the repair partner misses it, record the missed visit and find alternatives.",
                    "Appointment booking synchronized",
                    "The approved appointment was already booked; FixFlow synchronized it as the current repair visit.",
                    {"appointment_id": appt["id"], "vendor_id": appt["vendor_id"]},
                )
            provider = c.execute("SELECT name FROM vendors WHERE id=?", (appt["vendor_id"],)).fetchone()
            return {
                "appointment_id": appt["id"],
                "status": "BOOKED",
                "booking_status": fresh["booking_status"],
                "service_provider_name": provider["name"] if provider else "Unknown repair partner",
                "user_approved": True,
                "simulated": True,
                "idempotent": True,
            }
        if appt["status"]!="APPROVED" or not appt["user_approved"]: raise WorkflowError("Appointment is not in approved state")
        slot=c.execute("SELECT * FROM vendor_slots WHERE id=?",(payload["slot_id"],)).fetchone()
        if not slot or slot["status"]!="AVAILABLE": raise WorkflowError("Slot is no longer available")
        # If this approval replaces a currently booked visit, supersede the old
        # appointment only after the user has approved the replacement. Keep the
        # row and timeline event for audit history; do not leave two live bookings.
        previous_id = i.get("current_appointment_id")
        if previous_id and previous_id != appt["id"]:
            previous = c.execute(
                "SELECT * FROM appointments WHERE id=? AND incident_id=?",
                (previous_id, incident_id),
            ).fetchone()
            if previous and previous["status"] == "BOOKED":
                c.execute(
                    "UPDATE appointments SET status='RESCHEDULED',updated_at=? WHERE id=?",
                    (now_iso(), previous_id),
                )
                if previous["slot_id"]:
                    # The old slot is retained as unavailable so it cannot be
                    # re-offered as if this same visit had never existed.
                    c.execute(
                        "UPDATE vendor_slots SET status='UNAVAILABLE' WHERE id=? AND status='BOOKED'",
                        (previous["slot_id"],),
                    )
                _event(
                    c,
                    incident_id,
                    "APPOINTMENT_SUPERSEDED",
                    "Previous appointment replaced",
                    "The user approved a new appointment. The earlier booking is retained as rescheduled history.",
                    {"previous_appointment_id": previous_id, "replacement_appointment_id": appt["id"]},
                )
        c.execute("UPDATE vendor_slots SET status='BOOKED' WHERE id=?",(slot["id"],))
        c.execute("UPDATE appointments SET status='BOOKED',updated_at=? WHERE id=?",(now_iso(),appt["id"]))
        c.execute("UPDATE incidents SET current_vendor_id=?,current_appointment_id=? WHERE id=?",(appt["vendor_id"],appt["id"],incident_id))
        fresh=_incident(c,incident_id)
        _transition(c,fresh,"BOOKED","Wait for the scheduled visit; if the repair partner misses it, record the missed visit and find alternatives.","Appointment booked","The user approved this appointment and FixFlow recorded the simulated booking.",{"appointment_id":appt["id"],"vendor_id":appt["vendor_id"]})
        provider = c.execute("SELECT name FROM vendors WHERE id=?", (appt["vendor_id"],)).fetchone()
        return {"appointment_id":appt["id"],"status":"BOOKED","booking_status":"BOOKED","service_provider_name":provider["name"] if provider else "Unknown repair partner","user_approved":True,"simulated":True}
def record_no_show(incident_id: str, appointment_id: str, note: str="Repair partner did not arrive"):
    with connection_scope() as c:
        i=_incident(c,incident_id)
        appt=c.execute("SELECT * FROM appointments WHERE id=? AND incident_id=?",(appointment_id,incident_id)).fetchone()
        if not appt: raise WorkflowError("Appointment not found for this repair")
        if i.get("current_appointment_id") != appointment_id:
            raise WorkflowError("Only the current appointment for this repair can be marked as a no-show")
        if appt["status"] == "NO_SHOW" and i["status"] in {"NO_SHOW", "RESCHEDULING", "OPTIONS_READY", "WAITING_APPROVAL"}:
            return {"incident_id":incident_id,"status":i["status"],"booking_status":i.get("booking_status", "NO_SHOW"),"appointment_id":appointment_id,"case_open":True,"idempotent":True}
        if appt["status"] != "BOOKED": raise WorkflowError(f"A missed visit can only be recorded for a booked appointment (current status: {appt['status']})")
        c.execute("UPDATE appointments SET status='NO_SHOW',updated_at=? WHERE id=?",(now_iso(),appointment_id))
        # Preserve the failed appointment's slot as unavailable so recovery does
        # not misleadingly offer the exact missed slot again.
        if appt["slot_id"]: c.execute("UPDATE vendor_slots SET status='UNAVAILABLE' WHERE id=?",(appt["slot_id"],))
        updated=_transition(c,i,"NO_SHOW","Find replacement appointment options; the incident remains open.","Repair partner missed visit",note,{"appointment_id":appointment_id})
        return {"incident_id":incident_id,"status":updated["status"],"appointment_id":appointment_id,"case_open":True,"recovery_next_step":"find_alternatives"}
def find_alternatives(incident_id: str, budget_limit: float = 250.0, require_brand_authorized: bool = True):
    if not math.isfinite(float(budget_limit)) or budget_limit < 0 or budget_limit > 100000:
        raise WorkflowError("budget_limit must be a finite amount between $0 and $100,000")
    with connection_scope() as c:
        i=_incident(c,incident_id)
        if i["status"] not in {"NO_SHOW","RESCHEDULING","OPTIONS_READY","WAITING_APPROVAL","IN_PROGRESS","WAITING_PART"}: raise WorkflowError("Alternatives are available after a failed visit or when arranging follow-up work")
        rows=c.execute("SELECT s.*,v.name AS vendor_name,v.reliability_score,v.previous_household_jobs,v.is_preferred,v.brand_authorized,v.estimated_repair_cost,v.estimated_visit_fee FROM vendor_slots s JOIN vendors v ON v.id=s.vendor_id WHERE s.status='AVAILABLE' ORDER BY v.is_preferred DESC,v.reliability_score DESC,s.starts_at").fetchall()
        conflicts=c.execute("SELECT starts_at,ends_at FROM calendar_blocks WHERE household_id=?",(i["household_id"],)).fetchall()
    choices=[]
    for r in rows:
        d=dict(r)
        # Frontend option contracts use `slot_id`; the SQL table calls this
        # primary key `id`. Return both names to avoid ever sending an omitted
        # slot_id over MCP when the user chooses a replacement time.
        d["slot_id"] = d.get("slot_id") or d["id"]
        if any(d["starts_at"] < b["ends_at"] and d["ends_at"] > b["starts_at"] for b in conflicts): continue
        repair_cost=float(d.get("estimated_repair_cost") or 0)
        visit_fee=float(d.get("estimated_visit_fee") or d.get("price_estimate") or 0)
        total_cost=repair_cost + visit_fee
        d["estimated_total_cost"] = total_cost
        reasons=[]
        if total_cost > budget_limit:
            reasons.append(f"Estimated total ${total_cost:.0f} (repair ${repair_cost:.0f} + visit fee ${visit_fee:.0f}) exceeds your ${budget_limit:.0f} budget")
        if require_brand_authorized and not bool(d.get("brand_authorized")):
            reasons.append("Not marked brand-authorized in the simulated records")
        d["eligible"] = not reasons
        d["exclusion_reasons"] = reasons
        d["budget_limit"] = budget_limit
        d["require_brand_authorized"] = require_brand_authorized
        choices.append(d)
    if i["status"] in {"NO_SHOW", "IN_PROGRESS", "WAITING_PART"}:
        with connection_scope() as c:
            latest = _incident(c, incident_id)
            if latest["status"] in {"NO_SHOW", "IN_PROGRESS", "WAITING_PART"}:
                _transition(c, latest, "RESCHEDULING", "Select a replacement slot; explicit approval is required before booking.", "Recovery started", "FixFlow is comparing simulated alternative appointments for follow-up work.")
    return {"incident_id":incident_id,"options":choices,"simulated":True,"approval_required":True,"budget_limit":budget_limit,"require_brand_authorized":require_brand_authorized}
def reschedule_appointment(incident_id: str, vendor_id: str, slot_id: str, budget_limit: float = 250.0, require_brand_authorized: bool = True):
    return propose_appointment(incident_id,vendor_id,slot_id,budget_limit,require_brand_authorized)
def update_repair_status(incident_id: str, status: str, note: str=""):
    if status not in {"INVESTIGATING","VENDOR_SEARCH","WAITING_VENDOR","OPTIONS_READY","EXPECTED_VISIT","WAITING_PART","IN_PROGRESS","AWAITING_CONFIRMATION"}: raise WorkflowError("Unsupported or protected status; use dedicated completion, resolution, or close tools")
    with connection_scope() as c:
        i=_incident(c,incident_id)
        if status=="EXPECTED_VISIT" and not i["current_appointment_id"]: raise WorkflowError("Cannot expect a visit without a current appointment")
        return _transition(c,i,status,note or f"Continue the repair workflow from {status.lower().replace('_',' ')}.","Repair status updated",note or f"Repair workflow moved to {status}.")
def mark_completed(incident_id: str, appointment_id: str, technician_note: str="Simulated technician reports the repair is complete"):
    with connection_scope() as c:
        i=_incident(c,incident_id)
        appt=c.execute("SELECT * FROM appointments WHERE id=? AND incident_id=?",(appointment_id,incident_id)).fetchone()
        if not appt: raise WorkflowError("Appointment not found for this repair")
        if i.get("current_appointment_id") != appointment_id:
            raise WorkflowError("Only the current appointment can be marked completed")
        if appt["status"] != "BOOKED": raise WorkflowError("Only the current booked visit can be marked completed")
        c.execute("UPDATE appointments SET status='COMPLETED',updated_at=? WHERE id=?",(now_iso(),appointment_id))
        current=i
        if current["status"] in {"BOOKED","EXPECTED_VISIT"}:
            current=_transition(c,current,"IN_PROGRESS","Check the reported work and ask the user whether the appliance is fixed.","Work reported complete","The simulated technician reports completion; FixFlow is verifying the outcome.",{"appointment_id":appointment_id})
        updated=_transition(c,current,"AWAITING_CONFIRMATION","Ask the user whether the appliance is actually fixed. Do not close the case until they confirm.","Visit marked completed","The simulated technician reports completion; FixFlow is waiting for the user's confirmation.",{"appointment_id":appointment_id,"technician_note":technician_note})
        return {"incident_id":incident_id,"status":updated["status"],"case_closed":False,"user_confirmation_required":True}
def confirm_resolution(incident_id: str, confirmed: bool, note: str=""):
    with connection_scope() as c:
        i=_incident(c,incident_id)
        if i["status"]!="AWAITING_CONFIRMATION": raise WorkflowError("Resolution can only be confirmed after a visit is marked completed")
        if not confirmed:
            updated=_transition(c,i,"IN_PROGRESS","Continue troubleshooting or arrange a follow-up; the case stays open.","User says issue persists","The user did not confirm the repair is fixed.",{"note":note})
            return {"incident_id":incident_id,"status":updated["status"],"closed":False}
        now=now_iso(); validate_transition(i["status"],"RESOLVED")
        c.execute("UPDATE incidents SET status='RESOLVED',booking_status='RESOLVED',resolved_at=?,updated_at=?,next_action=?,version=version+1 WHERE id=?",(now,now,"Ask whether the user wants to close the resolved repair record.",incident_id))
        _event(c,incident_id,"RESOLUTION_CONFIRMED","User confirmed resolution",note or "The user explicitly confirmed the appliance is fixed.")
        return {"incident_id":incident_id,"status":"RESOLVED","closed":False,"next_action":"close_repair requires an explicit separate call"}
def close_repair(incident_id: str, confirmed: bool):
    if not confirmed: raise WorkflowError("Closing requires explicit user confirmation")
    with connection_scope() as c:
        i=_incident(c,incident_id)
        if i["status"]!="RESOLVED": raise WorkflowError("Cannot close a repair until the user has confirmed resolution")
        updated=_transition(c,i,"CLOSED","No further action required. Repair history retained.","Repair case closed","The user explicitly closed a previously confirmed resolved repair.")
        c.execute("UPDATE incidents SET closed_at=? WHERE id=?",(now_iso(),incident_id))
        return {"incident_id":incident_id,"status":updated["status"],"history_retained":True}
def reset_demo_scenario():
    counts=seed_demo_data(reset=True)
    return {"reset":True,"counts":counts,"active_incident_id":"repair-washer-2026-001"}


def get_current_appointment(incident_id: str):
    """Return current simulated appointment details for a repair, if present."""
    with connection_scope() as c:
        incident = _incident(c, incident_id)
        appointment_id = incident.get("current_appointment_id")
        if not appointment_id:
            return None
        row = c.execute(
            """SELECT a.*, v.name AS vendor_name, v.name AS service_provider_name, v.reliability_score,
                      v.previous_household_jobs, v.is_preferred
               FROM appointments a JOIN vendors v ON v.id=a.vendor_id
               WHERE a.id=? AND a.incident_id=?""",
            (appointment_id, incident_id),
        ).fetchone()
        if not row:
            return None
        return {"appointment": dict(row), "simulated": True}


def get_pending_approval(incident_id: str):
    """Return a still-actionable booking proposal after page reloads."""
    with connection_scope() as c:
        _incident(c, incident_id)
        rows = c.execute(
            """SELECT * FROM approvals
               WHERE incident_id=? AND action_type IN ('BOOK_APPOINTMENT','RESCHEDULE_APPOINTMENT')
                 AND status IN ('PENDING','APPROVED')
               ORDER BY requested_at DESC""",
            (incident_id,),
        ).fetchall()
        for row in rows:
            approval = dict(row)
            try:
                payload = json.loads(approval.get("action_payload_json") or "{}")
            except json.JSONDecodeError:
                payload = {}
            appointment_id = payload.get("appointment_id")
            appointment = c.execute(
                "SELECT status FROM appointments WHERE id=? AND incident_id=?",
                (appointment_id, incident_id),
            ).fetchone()
            if appointment and appointment["status"] in {"PROPOSED", "APPROVED"}:
                approval["action_payload"] = payload
                approval["approval_id"] = approval.get("id")
                approval.pop("action_payload_json", None)
                return approval
        return None


def get_conversation_history(incident_id: str):
    """Return the latest persisted conversation session for one repair."""
    with connection_scope() as c:
        _incident(c, incident_id)
        session = c.execute(
            """SELECT * FROM conversation_sessions WHERE incident_id=?
               ORDER BY updated_at DESC, created_at DESC LIMIT 1""",
            (incident_id,),
        ).fetchone()
        if not session:
            return {"session_id": None, "messages": []}
        messages = c.execute(
            """SELECT id, role, content, tool_name, tool_payload_json, created_at
               FROM conversation_messages WHERE session_id=?
               ORDER BY rowid ASC""",
            (session["id"],),
        ).fetchall()
        parsed = []
        for row in messages:
            item = dict(row)
            raw_payload = item.pop("tool_payload_json", None)
            if raw_payload:
                try:
                    item["tool_payload"] = json.loads(raw_payload)
                except json.JSONDecodeError:
                    item["tool_payload"] = None
            else:
                item["tool_payload"] = None
            parsed.append(item)
        return {"session_id": session["id"], "messages": parsed}


def append_conversation_turn(
    incident_id: str,
    user_message: str,
    assistant_message: str,
    tool_name: str = "",
    tool_payload: dict[str, Any] | None = None,
):
    """Persist one user/assistant turn against the repair's conversation session."""
    user_text = user_message.strip()
    assistant_text = assistant_message.strip()
    if not user_text or not assistant_text:
        raise WorkflowError("Both the user message and assistant reply must be non-empty")
    with connection_scope() as c:
        incident = _incident(c, incident_id)
        session = c.execute(
            """SELECT * FROM conversation_sessions WHERE incident_id=?
               ORDER BY updated_at DESC, created_at DESC LIMIT 1""",
            (incident_id,),
        ).fetchone()
        now = now_iso()
        if not session:
            session_id = _id("session")
            c.execute(
                """INSERT INTO conversation_sessions
                   (id, household_id, incident_id, title, context_json, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (session_id, incident["household_id"], incident_id,
                 f"Repair conversation · {incident['title']}",
                 json.dumps({"active_incident_id": incident_id, "mode": "deterministic_demo"}),
                 now, now),
            )
        else:
            session_id = session["id"]
        c.execute(
            """INSERT INTO conversation_messages
               (id, session_id, role, content, tool_name, tool_payload_json, created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (_id("msg"), session_id, "user", user_text, None, None, now),
        )
        assistant_at = now_iso()
        c.execute(
            """INSERT INTO conversation_messages
               (id, session_id, role, content, tool_name, tool_payload_json, created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (_id("msg"), session_id, "assistant", assistant_text,
             tool_name or None, json.dumps(tool_payload) if tool_payload is not None else None,
             assistant_at),
        )
        c.execute("UPDATE conversation_sessions SET updated_at=? WHERE id=?", (assistant_at, session_id))
    return get_conversation_history(incident_id)
