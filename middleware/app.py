import os
import json
import time
import base64
from typing import Dict

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

OPENROUTER_BASE = "https://openrouter.ai/api"   # ✅ correct base
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_HTTP_REFERER = os.environ.get("OPENROUTER_HTTP_REFERER")
OPENROUTER_X_TITLE = os.environ.get("OPENROUTER_X_TITLE")
LOG_MODE = os.environ.get("LOG_MODE", "metadata")  # metadata|off

app = FastAPI()


def clean_hop_by_hop_headers(headers: Dict[str, str]) -> Dict[str, str]:
    hop = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
    return {k: v for k, v in headers.items() if k.lower() not in hop}


def get_user_from_jwt(token: str) -> str:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        # Pad base64
        payload += "=" * ((4 - len(payload) % 4) % 4)
        decoded = base64.urlsafe_b64decode(payload)
        data = json.loads(decoded)
        # Prefer email, then id, then sub
        return data.get("email") or data.get("id") or data.get("sub")
    except Exception:
        return None


def log_event(event: Dict):
    if LOG_MODE == "off":
        return
    print(json.dumps(event, ensure_ascii=False))


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_v1(path: str, request: Request):
    if not OPENROUTER_API_KEY:
        return Response(content="OPENROUTER_API_KEY not set", status_code=500)

    upstream_url = f"{OPENROUTER_BASE}/v1/{path}"

    in_headers = dict(request.headers)

    # 1. Try to get user from X-OpenWebUI headers (if ENABLE_FORWARD_USER_INFO_HEADERS=true)
    user_id = request.headers.get("x-openwebui-user-email") or \
              request.headers.get("x-openwebui-user-id")

    # 2. Fallback: Extract user from JWT (if provided in Authorization)
    if not user_id:
        auth_header = in_headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header.split(" ", 1)[1]
            user_id = get_user_from_jwt(token)

    in_headers.pop("host", None)
    in_headers.pop("content-length", None)

    # ตัด headers ที่ไม่ควรส่งต่อไป OpenRouter
    strip = {
        "cookie",
        "authorization",     # ของ OpenWebUI (JWT)
        "x-forwarded-for",
        "x-real-ip",
        "x-forwarded-proto",
        "x-forwarded-host",
        "accept-encoding",   # ตัดเพื่อเลี่ยง zstd/br mismatch
    }
    headers = {
        k: v for k, v in in_headers.items()
        if k.lower() not in strip
    }

    # hop-by-hop
    headers = clean_hop_by_hop_headers(headers)

    # ใส่ auth ของ OpenRouter
    headers["Authorization"] = f"Bearer {OPENROUTER_API_KEY}"
    headers["User-Agent"] = headers.get("User-Agent", "OpenWebUI-Middleware/1.0")

    # Optional headers
    if OPENROUTER_HTTP_REFERER:
        headers["HTTP-Referer"] = OPENROUTER_HTTP_REFERER
    if OPENROUTER_X_TITLE:
        headers["X-Title"] = OPENROUTER_X_TITLE

    # บังคับให้ upstream ตอบ JSON
    headers["Accept"] = "application/json"

    body_bytes = await request.body()

    # Inject OpenRouter "user" field for tracking
    injected = False
    if user_id and request.method == "POST" and "application/json" in request.headers.get("content-type", "").lower() and body_bytes:
        try:
            payload = json.loads(body_bytes)
            if isinstance(payload, dict):
                payload["user"] = user_id
                body_bytes = json.dumps(payload).encode("utf-8")
                injected = True
        except Exception:
            pass

    start = time.time()
    log_data = {
        "type": "request",
        "ts": int(start),
        "method": request.method,
        "path": f"/v1/{path}",
        "query": str(request.url.query),
        "user_id": user_id,
        "injected_tracking": injected,
        "debug_headers": {k: v for k, v in request.headers.items() if k.lower() not in {"authorization", "cookie"}},  # Hide sensitive headers
        "debug_auth_len": len(request.headers.get("authorization", "")),
        "debug_auth_prefix": request.headers.get("authorization", "")[:10] if request.headers.get("authorization") else "None"
    }

    if injected:
        # Preview a small part of payload to avoid spamming logs
        try:
             log_data["payload_preview"] = json.loads(body_bytes)
        except:
             pass

    # --- Debug: Check raw body from OpenWebUI ---
    if request.method == "POST" and "chat/completions" in path:
        try:
             raw_body_json = json.loads(body_bytes)
             log_data["incoming_body_preview"] = raw_body_json
        except:
             pass
    # --------------------------------------------

    log_event(log_data)

    client = httpx.AsyncClient(timeout=None)
    req = client.build_request(
        request.method,
        upstream_url,
        headers=headers,
        content=body_bytes,
        params=dict(request.query_params),
    )

    r = await client.send(req, stream=True)

    out_headers = clean_hop_by_hop_headers(dict(r.headers))
    out_headers.pop("content-length", None)
    out_headers.pop("content-encoding", None)

    async def close_client():
        await r.aclose()
        await client.aclose()

    log_event({
        "type": "response_stream",
        "status_code": r.status_code,
        "elapsed_ms": int((time.time() - start) * 1000),
        "path": f"/v1/{path}",
    })

    return StreamingResponse(
        r.aiter_bytes(),
        status_code=r.status_code,
        headers=out_headers,
        background=BackgroundTask(close_client)
    )
