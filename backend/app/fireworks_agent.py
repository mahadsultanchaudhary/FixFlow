"""Optional Fireworks conversational answers and legacy safe-intent parsing.

The frontend routes repair/appointment state changes deterministically before
calling this endpoint. The API key stays on the backend; this module never
receives MCP credentials and never executes a tool or changes repair state.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env", override=False)

DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1"
DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/models/qwen3-235b-a22b-instruct-2507"
_LAST_FIREWORKS_STATUS: dict[str, Any] = {
    "last_request_status": "not_used",
    "last_intent": None,
    "last_request_at": None,
    "reason": None,
}


def fireworks_runtime_status() -> dict[str, Any]:
    """Expose provider state without ever returning the API key."""
    return {
        "configured": bool(fireworks_api_key()),
        "base_url": fireworks_base_url(),
        "model": fireworks_model(),
        **_LAST_FIREWORKS_STATUS,
    }


def _set_fireworks_status(status: str, *, intent: str | None = None, reason: str | None = None) -> None:
    _LAST_FIREWORKS_STATUS.update({
        "last_request_status": status,
        "last_intent": intent,
        "last_request_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reason": reason,
    })


SAFE_INTENTS = {
    "active_repairs",
    "repair_history",
    "check_warranty",
    "compare_vendors",
    "what_waiting",
    "other",
}


class IntentInterpretRequest(BaseModel):
    command: str = Field(min_length=1, max_length=1800)
    repair_title: str | None = Field(default=None, max_length=200)
    repair_status: str | None = Field(default=None, max_length=60)
    has_pending_approval: bool = False
    has_current_appointment: bool = False


def fireworks_api_key() -> str:
    """Return a configured Fireworks key, supporting OpenAI-style aliases."""
    return (os.getenv("FIREWORKS_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()


def fireworks_base_url() -> str:
    """Use the Fireworks OpenAI-compatible inference base URL by default."""
    return (
        os.getenv("FIREWORKS_BASE_URL")
        or os.getenv("OPENAI_BASE_URL")
        or DEFAULT_FIREWORKS_BASE_URL
    ).strip().rstrip("/")


def fireworks_model() -> str:
    return (
        os.getenv("FIREWORKS_MODEL")
        or os.getenv("OPENAI_MODEL")
        or DEFAULT_FIREWORKS_MODEL
    ).strip()


def _chat_completions_url(base_url: str) -> str:
    cleaned = base_url.rstrip("/")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    return f"{cleaned}/chat/completions"


def parse_safe_intent(content: str) -> str | None:
    """Parse model JSON strictly; discard unknown and consequential intent labels."""
    candidate = content.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[1] if "\n" in candidate else candidate
        if candidate.endswith("```"):
            candidate = candidate[:-3].strip()
        if candidate.lower().startswith("json\n"):
            candidate = candidate[5:].strip()
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        # Permit a short explanatory prefix/suffix but only parse the first JSON object.
        start = candidate.find("{")
        if start < 0:
            return None
        try:
            data, _ = json.JSONDecoder().raw_decode(candidate[start:])
        except json.JSONDecodeError:
            return None
    if not isinstance(data, dict):
        return None
    intent = data.get("intent")
    if not isinstance(intent, str) or intent not in SAFE_INTENTS:
        return None
    return intent


async def interpret_safe_intent(request: IntentInterpretRequest) -> dict[str, Any]:
    """Use Fireworks if configured; always fail open to deterministic routing."""
    api_key = fireworks_api_key()
    if not api_key:
        _set_fireworks_status("not_configured", reason="no_api_key")
        return {"mode": "deterministic", "intent": None, "reason": "no_api_key"}

    context = {
        "command": request.command,
        "repair_title": request.repair_title,
        "repair_status": request.repair_status,
        "has_pending_approval": request.has_pending_approval,
        "has_current_appointment": request.has_current_appointment,
    }
    system_message = (
        "You classify a user's household-repair request for FixFlow. Return only one JSON object: "
        '{"intent":"LABEL"}. Allowed LABEL values: active_repairs, repair_history, '
        "check_warranty, compare_vendors, what_waiting, other. "
        "Choose a specific label only when the user's command clearly asks for it; otherwise choose other. "
        "This is classification only, not execution. Never approve or reject a proposal, book or reschedule, "
        "record a no-show, mark a visit complete, confirm a repair, or close a case. Those operations must be "
        "handled separately by explicit user actions and the application safety checks. Do not add prose."
    )
    url = _chat_completions_url(fireworks_base_url())
    payload = {
        "model": fireworks_model(),
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
        ],
        "temperature": 0,
        "max_tokens": 80,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=4.0)) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            result = response.json()
        content = result["choices"][0]["message"]["content"]
        if not isinstance(content, str):
            raise ValueError("The model response had no text content")
        intent = parse_safe_intent(content)
        if not intent or intent == "other":
            _set_fireworks_status("success_unclassified", reason="unrecognized_intent")
            return {"mode": "deterministic", "intent": None, "reason": "unrecognized_intent", "provider": "fireworks"}
        _set_fireworks_status("success", intent=intent)
        return {"mode": "fireworks", "provider": "fireworks", "intent": intent}
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        # Do not surface provider details or credentials to the browser. The caller
        # simply uses the original command and the deterministic router.
        _set_fireworks_status("error", reason="provider_unavailable")
        return {"mode": "deterministic", "intent": None, "reason": "provider_unavailable"}


async def answer_general_question(request: IntentInterpretRequest) -> dict[str, Any]:
    """Answer only a conversational query; never execute or recommend an implicit state change."""
    api_key = fireworks_api_key()
    if not api_key:
        _set_fireworks_status("not_configured", reason="no_api_key")
        return {
            "mode": "fallback",
            "reason": "no_api_key",
            "reply": "I can manage household repairs locally, but a conversational AI answer is unavailable because Fireworks is not configured. You can still report a repair, review options, and explicitly approve appointments.",
        }

    system_message = (
        "You are FixFlow AI, an assistant for household repair management.\n"
        "The user is asking a general or conversational question.\n"
        "DO NOT attempt to execute repair bookings, vendor selections, or state changes.\n"
        "Answer concisely in 1-2 sentences."
    )
    payload = {
        "model": fireworks_model(),
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": request.command.strip()},
        ],
        "temperature": 0.2,
        "max_tokens": 160,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=4.0)) as client:
            response = await client.post(
                _chat_completions_url(fireworks_base_url()),
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        content = data["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("The model response had no text content")
        reply = " ".join(content.split()).strip()
        # Keep conversational output concise even if the provider ignores its prompt.
        sentences = re.split(r"(?<=[.!?])\s+", reply)
        if len(sentences) > 2:
            reply = " ".join(sentences[:2])
        _set_fireworks_status("success", intent="general_answer")
        return {"mode": "fireworks-answer", "provider": "fireworks", "reply": reply}
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        _set_fireworks_status("error", reason="provider_unavailable")
        return {
            "mode": "fallback",
            "reason": "provider_unavailable",
            "reply": "I couldn’t reach Fireworks for a conversational answer. Your repair history and deterministic repair workflow remain available locally.",
        }
