"""Wire-level MCP tests using the official Python SDK over actual HTTP."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pytest
from mcp import Client
from mcp.types import TextContent

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def running_fixflow_mcp(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("fixflow-mcp-http")
    port = _reserve_port()
    base_url = f"http://127.0.0.1:{port}"
    log_path = tmp_path / "uvicorn.log"
    log_file = log_path.open("w", encoding="utf-8")
    env = os.environ.copy()
    env["DATABASE_PATH"] = str(tmp_path / "mcp-test.sqlite3")
    env["FRONTEND_ORIGIN"] = "http://localhost:5173"
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=PROJECT_ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=log_file,
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                log_file.flush()
                raise RuntimeError(
                    "FixFlow test server exited during startup:\n"
                    + log_path.read_text(encoding="utf-8")
                )
            try:
                with urlopen(f"{base_url}/api/health", timeout=0.5) as response:
                    if response.status == 200:
                        break
            except (URLError, TimeoutError, OSError):
                time.sleep(0.15)
        else:
            log_file.flush()
            raise RuntimeError(
                "FixFlow test server did not become healthy:\n"
                + log_path.read_text(encoding="utf-8")
            )
        yield f"{base_url}/mcp"
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log_file.close()


def _payload(result):
    if result.structured_content is not None:
        return result.structured_content
    for block in result.content:
        if isinstance(block, TextContent):
            try:
                return json.loads(block.text)
            except json.JSONDecodeError:
                continue
    return None


async def _exercise_protocol(endpoint: str):
    # mode="legacy" deliberately exercises initialize + initialized notification
    # rather than the newer 2026 discovery-first protocol. Client drives the full
    # Streamable HTTP handshake and headers according to the official SDK.
    async with Client(endpoint, mode="legacy") as client:
        assert client.protocol_version
        assert client.server_info is not None
        assert client.server_info.name == "FixFlow Repair Resolution"

        tool_result = await client.list_tools()
        tools = {tool.name: tool for tool in tool_result.tools}
        required = {
            "create_repair",
            "get_repair",
            "list_active_repairs",
            "check_warranty",
            "compare_vendors",
            "propose_appointment",
            "select_vendor",
            "prepare_proposal",
            "approve_proposal",
            "record_vendor_no_show",
            "approve_action",
            "book_appointment",
            "record_no_show",
            "find_alternatives",
            "confirm_resolution",
            "close_repair",
            "reset_demo_scenario",
            "get_current_appointment",
            "get_pending_approval",
            "get_conversation_history",
            "append_conversation_turn",
        }
        assert required.issubset(tools), f"missing MCP tools: {required - tools.keys()}"
        assert tools["get_repair"].input_schema.get("type") == "object"
        assert "incident_id" in tools["get_repair"].input_schema.get("properties", {})
        # The browser sends filter arguments when selecting alternatives. They must
        # be advertised in MCP input schemas, not rejected as unexpected arguments.
        for tool_name in ("propose_appointment", "reschedule_appointment", "find_alternatives"):
            properties = tools[tool_name].input_schema.get("properties", {})
            assert "budget_limit" in properties, f"{tool_name} does not accept budget_limit"
            assert "require_brand_authorized" in properties, f"{tool_name} does not accept require_brand_authorized"

        result = await client.call_tool(
            "get_repair", {"incident_id": "repair-washer-2026-001"}
        )
        assert not result.is_error, _payload(result)
        payload = _payload(result)
        assert isinstance(payload, dict), "MCP tool returned no structured/JSON content"
        assert payload.get("ok") is True, payload
        repair_data = payload["data"]
        assert repair_data["repair"]["id"] == "repair-washer-2026-001"
        assert repair_data["repair"]["status"] == "BOOKED"

        selected = await client.call_tool(
            "select_vendor",
            {
                "incident_id": "repair-washer-2026-001",
                "vendor_name": "BrightFix Appliance Care",
                "budget_limit": 250,
                "require_brand_authorized": True,
            },
        )
        assert not selected.is_error, _payload(selected)
        selected_payload = _payload(selected)
        assert selected_payload["ok"] is True, selected_payload
        assert selected_payload["data"]["eligible"] is True

        # The chat client need only supply the active incident ID. The MCP tool
        # resolves and validates the current booked appointment server-side.
        no_show = await client.call_tool(
            "record_vendor_no_show", {"incident_id": "repair-washer-2026-001"}
        )
        assert not no_show.is_error, _payload(no_show)
        no_show_payload = _payload(no_show)
        assert no_show_payload["ok"] is True, no_show_payload
        assert no_show_payload["data"]["status"] == "NO_SHOW"
        assert no_show_payload["data"]["case_open"] is True

        missing_visit = await client.call_tool(
            "record_vendor_no_show", {"incident_id": "repair-washer-2025-004"}
        )
        missing_payload = _payload(missing_visit)
        assert isinstance(missing_payload, dict)
        assert missing_payload["ok"] is False
        assert missing_payload["error"] == "No scheduled visit found to mark as a no-show."

        return {
            "protocol_version": client.protocol_version,
            "tools_count": len(tool_result.tools),
            "repair_status": repair_data["repair"]["status"],
        }


def test_streamable_http_initialize_tools_list_and_tool_call(running_fixflow_mcp):
    outcome = asyncio.run(_exercise_protocol(running_fixflow_mcp))
    assert outcome["tools_count"] >= 20
    assert outcome["repair_status"] == "BOOKED"
