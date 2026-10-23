#!/usr/bin/env python3
"""Verify the local FixFlow MCP endpoint using the official MCP Python client."""
from __future__ import annotations

import anyio
import json
import os
import sys
import urllib.request
from urllib.error import URLError

from mcp import Client
from mcp.types import TextContent


async def run() -> int:
    base_url = os.getenv("FIXFLOW_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
    endpoint = os.getenv("MCP_ENDPOINT", f"{base_url}/mcp")
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=3) as response:
            health = json.loads(response.read().decode("utf-8"))
        if health.get("status") != "ok":
            raise RuntimeError(f"Health check failed: {health}")
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        print(f"FAIL backend health: {exc}", file=sys.stderr)
        return 1

    print(f"Backend health: {health['status']}")
    print(f"MCP endpoint: {endpoint}")
    try:
        async with Client(endpoint, mode="legacy") as client:
            print(f"MCP initialize: OK (protocol {client.protocol_version})")
            listing = await client.list_tools()
            names = {tool.name for tool in listing.tools}
            expected = {"get_repair", "list_active_repairs", "check_warranty", "record_no_show", "confirm_resolution"}
            missing = expected - names
            if missing:
                raise RuntimeError(f"MCP tools missing: {', '.join(sorted(missing))}")
            print(f"tools/list: OK ({len(names)} tools discovered)")

            result = await client.call_tool(
                "get_repair", {"incident_id": "repair-washer-2026-001"}
            )
            if result.is_error:
                raise RuntimeError(f"tools/call returned an MCP tool error: {result.content}")
            payload = result.structured_content
            if payload is None:
                for item in result.content:
                    if isinstance(item, TextContent):
                        try:
                            payload = json.loads(item.text)
                            break
                        except json.JSONDecodeError:
                            pass
            if not isinstance(payload, dict) or payload.get("ok") is not True:
                raise RuntimeError(f"Unexpected get_repair result: {payload!r}")
            repair = payload["data"]["repair"]
            print(f"tools/call: OK ({repair['title']} — {repair['status']})")
        return 0
    except Exception as exc:
        print(f"FAIL MCP protocol smoke test: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(anyio.run(run))
