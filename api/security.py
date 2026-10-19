"""Shared request boundaries. Keep security defaults out of individual routes."""
import hashlib
import re
from urllib.parse import urlsplit

from typing import Annotated

from fastapi import HTTPException, Path as PathParameter

DatabaseId = Annotated[int, PathParameter(gt=0, le=2**63-1)]
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse


def valid_password(value: str) -> str:
    if len(value) < 8 or len(value.encode()) > 72:
        raise ValueError("password must be at least 8 characters and at most 72 UTF-8 bytes")
    return value


def valid_image_path(value: str | None) -> str | None:
    if value is not None and not re.fullmatch(r"(?:/|assets/)(?:uploads|photos|team|brand)/[^\\\x00-\x1f?#]+\.(?:jpg|jpeg|png|webp)", value, re.I):
        raise ValueError("image must be a local image path")
    if value and any(part in (".", "..") for part in value.split("/")):
        raise ValueError("image path cannot traverse directories")
    return value


async def rate_limit(pool, action: str, key: str, limit: int, seconds: int):
    # A fixed-size row per key/window, shared across processes. Never store raw
    # reset addresses or tokens. Locking the upsert also handles concurrent calls.
    digest = hashlib.sha256(f"{action}:{key}".encode()).hexdigest()
    count = await pool.fetchval("""INSERT INTO auth_limits (key, started_at, attempts)
        VALUES ($1, now(), 1) ON CONFLICT (key) DO UPDATE SET
        attempts=CASE WHEN auth_limits.started_at < now()-make_interval(secs=>$2)
                      THEN 1 ELSE least(auth_limits.attempts+1, $3+1) END,
        started_at=CASE WHEN auth_limits.started_at < now()-make_interval(secs=>$2)
                       THEN now() ELSE auth_limits.started_at END RETURNING attempts""",
        digest, float(seconds), limit)
    if count > limit:
        raise HTTPException(429, "too many requests; please try again later", headers={"Retry-After": str(seconds)})


class SecurityMiddleware:
    """No-store on success AND errors, same-origin writes, bounded bodies."""
    def __init__(self, app, public_origin: str, secure: bool = True):
        self.app = app
        parsed = urlsplit(public_origin)
        if parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.path not in ("", "/"):
            raise ValueError("PUBLIC_BASE_URL must be an origin")
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.secure = secure

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)

        async def protected_send(message):
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                h["Cache-Control"] = "no-store"
                h["Referrer-Policy"] = "no-referrer"
                h["X-Content-Type-Options"] = "nosniff"
                h["X-Frame-Options"] = "DENY"
            await send(message)

        async def reject(code, detail):
            await JSONResponse({"detail": detail}, status_code=code)(scope, receive, protected_send)

        if scope["method"] not in ("GET", "HEAD", "OPTIONS"):
            origin = headers.get("origin")
            allowed = {self.origin}
            if not self.secure:
                allowed.add(f"{scope['scheme']}://{headers.get('host', '')}")
            if headers.get("sec-fetch-site") == "cross-site" or (origin is not None and origin not in allowed):
                return await reject(403, "use the team website to make changes")
            if origin is None and headers.get("sec-fetch-site") == "same-site":
                return await reject(403, "same-origin requests are required")

        path = scope["path"].rstrip("/")
        limit = 13 * 1024 * 1024 if path in ("/uploads", "/api/uploads") else 1024 * 1024
        if scope["method"] == "PUT" and re.fullmatch(r"(?:/api)?/highlights/uploads/[0-9a-fA-F-]{36}", path):
            limit = 8 * 1024 * 1024
        try:
            declared = int(headers.get("content-length", "0"))
        except ValueError:
            return await reject(400, "invalid content length")
        if declared < 0 or declared > limit:
            return await reject(413, "request body is too large")
        # Enforce the actual length too, including chunked requests.
        parts, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > limit:
                return await reject(413, "request body is too large")
            parts.append(chunk)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(parts), "more_body": False}
            return await receive()

        await self.app(scope, replay, protected_send)
