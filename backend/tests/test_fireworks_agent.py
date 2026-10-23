"""Fireworks configuration and deterministic safety-fallback tests."""
from __future__ import annotations

import asyncio
import pytest

from backend.app import fireworks_agent as agent


def test_default_fireworks_endpoint_is_official_openai_compatible_base(monkeypatch):
    monkeypatch.delenv("FIREWORKS_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    assert agent.fireworks_base_url() == "https://api.fireworks.ai/inference/v1"
    assert agent._chat_completions_url(agent.fireworks_base_url()) == (
        "https://api.fireworks.ai/inference/v1/chat/completions"
    )


def test_parse_safe_intent_accepts_allowlisted_label_only():
    assert agent.parse_safe_intent('{"intent":"repair_history"}') == "repair_history"
    assert agent.parse_safe_intent('```json\n{"intent":"check_warranty"}\n```') == "check_warranty"
    assert agent.parse_safe_intent('{"intent":"approve_booking"}') is None
    assert agent.parse_safe_intent('not json') is None


def test_fireworks_environment_variables_take_precedence(monkeypatch):
    monkeypatch.setenv("FIREWORKS_BASE_URL", "https://custom.example/v1/")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://ignored.example/v1")
    monkeypatch.setenv("FIREWORKS_MODEL", "accounts/fireworks/models/test-model")
    monkeypatch.setenv("OPENAI_MODEL", "ignored-model")
    assert agent.fireworks_base_url() == "https://custom.example/v1"
    assert agent.fireworks_model() == "accounts/fireworks/models/test-model"


def test_missing_key_falls_back_without_network(monkeypatch):
    monkeypatch.delenv("FIREWORKS_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    request = agent.IntentInterpretRequest(command="Can you tell me what's still broken?")
    result = asyncio.run(agent.interpret_safe_intent(request))
    assert result == {"mode": "deterministic", "intent": None, "reason": "no_api_key"}


def test_fireworks_other_classification_reports_provider_use_without_claiming_intent_match(monkeypatch):
    monkeypatch.setenv("FIREWORKS_API_KEY", "test-key")
    class FakeResponse:
        def raise_for_status(self):
            return None
        def json(self):
            return {"choices": [{"message": {"content": '{"intent":"other"}'}}]}
    class FakeClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def post(self, *args, **kwargs): return FakeResponse()
    monkeypatch.setattr(agent.httpx, "AsyncClient", FakeClient)
    result = asyncio.run(agent.interpret_safe_intent(agent.IntentInterpretRequest(command="Could you help me with this unusual wording?")))
    assert result["mode"] == "deterministic"
    assert result["intent"] is None
    assert result["reason"] == "unrecognized_intent"
    status = agent.fireworks_runtime_status()
    assert status["configured"] is True
    assert status["last_request_status"] == "success_unclassified"
    assert "test-key" not in repr(status)


def test_general_question_uses_requested_safe_conversational_prompt(monkeypatch):
    monkeypatch.setenv("FIREWORKS_API_KEY", "test-key")
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None
        def json(self):
            return {"choices": [{"message": {"content": "FixFlow keeps a repair case open until you confirm it is fixed. It uses local tools for approvals."}}]}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return None
        async def post(self, url, *, headers, json):
            captured["url"] = url
            captured["payload"] = json
            return FakeResponse()

    monkeypatch.setattr(agent.httpx, "AsyncClient", FakeClient)
    response = asyncio.run(agent.answer_general_question(agent.IntentInterpretRequest(command="What is FixFlow?")))
    assert response["mode"] == "fireworks-answer"
    assert response["reply"].startswith("FixFlow keeps a repair case open")
    assert captured["url"] == "https://api.fireworks.ai/inference/v1/chat/completions"
    assert captured["payload"]["messages"][0]["content"] == (
        "You are FixFlow AI, an assistant for household repair management.\n"
        "The user is asking a general or conversational question.\n"
        "DO NOT attempt to execute repair bookings, vendor selections, or state changes.\n"
        "Answer concisely in 1-2 sentences."
    )
    assert "test-key" not in repr(response)
