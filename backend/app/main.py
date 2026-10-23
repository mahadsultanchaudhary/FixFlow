"""FastAPI host for FixFlow APIs and its mounted official MCP endpoint."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from backend.app.config import database_path, frontend_origin
from backend.app.database import connection_scope, initialize_schema
from backend.app.mcp_server import mcp, mcp_http_app
from backend.app.seed import seed_demo_data
from backend.app.fireworks_agent import IntentInterpretRequest, answer_general_question, fireworks_runtime_status


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_schema()
    with connection_scope() as conn:
        count = conn.execute("SELECT COUNT(*) FROM households").fetchone()[0]
    if not count:
        seed_demo_data()
    # A mounted MCP sub-application's lifespan is not entered automatically.
    # The host app must own the session manager lifecycle.
    async with mcp.session_manager.run():
        yield


app = FastAPI(
    title="FixFlow",
    version="0.3.0",
    description="Simulated household repair resolution agent",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin(), "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Authorization",
        "Content-Type",
        "Last-Event-ID",
        "Mcp-Method",
        "Mcp-Name",
        "Mcp-Protocol-Version",
        "Mcp-Session-Id",
    ],
    expose_headers=["Mcp-Session-Id", "Mcp-Protocol-Version"],
)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "fixflow",
        "database": str(database_path()),
        "mcp_endpoint": "/mcp",
        "simulated_services": True,
    }


@app.get("/api/agent/status")
def agent_status():
    """Report provider configuration and last request result without exposing credentials."""
    return fireworks_runtime_status()


@app.post("/api/agent/interpret")
async def interpret_agent_command(request: IntentInterpretRequest):
    """Optional Fireworks intent normalization; no repair action is executed here."""
    return await answer_general_question(request)


@app.get("/api/repairs")
def repairs():
    from backend.app.services import list_active_repairs

    return {"repairs": list_active_repairs()}


@app.get("/api/repairs/{incident_id}")
def repair(incident_id: str):
    from backend.app.services import get_repair

    try:
        return get_repair(incident_id)
    except ValueError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc)})


# Keep the catch-all mount last: the MCP child app exposes /mcp, while all API
# and FastAPI documentation routes above keep their own routing precedence.
app.mount("/", mcp_http_app)
