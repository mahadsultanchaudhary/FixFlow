#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .venv/bin/activate ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

echo '== backend health =='
python - <<'PY'
import json
from urllib.request import urlopen

with urlopen("http://127.0.0.1:8000/api/health", timeout=3) as response:
    payload = json.load(response)
assert response.status == 200
assert payload.get("status") == "ok", payload
assert payload.get("mcp_endpoint") == "/mcp", payload
print("Backend health: ok")
print("MCP endpoint:", "http://127.0.0.1:8000" + payload["mcp_endpoint"])
PY

echo
echo '== MCP protocol smoke =='
python scripts/smoke_mcp.py

echo
echo '== frontend HTTP =='
python - <<'PY'
from urllib.request import urlopen

with urlopen("http://127.0.0.1:5173", timeout=3) as response:
    html = response.read().decode("utf-8", errors="replace")
assert response.status == 200
assert "FixFlow" in html, html[:500]
print("Frontend dev server: ok")
PY

echo
echo '== frontend tests =='
npm --prefix frontend test

echo
echo '== frontend production build =='
npm --prefix frontend run build

echo
echo 'Local smoke checks completed. Review every step above for success.'
