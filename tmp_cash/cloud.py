"""Same-origin social login and account-scoped wallet backup storage.

Identity providers authenticate only. Backup payloads never go to Google/Apple.
"""

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import UUID

import httpx
import jwt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from .crud import CLOUD, Crud
from .db import Database

MAX_BACKUP_BYTES = 16_000_000
SESSION_COOKIE = "tmp_cash_cloud_session"
LOGIN_COOKIE = "tmp_cash_cloud_login"
SESSION_SECONDS = 30 * 86400


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass(frozen=True)
class Provider:
    client_id: str
    client_secret: str = ""
    team_id: str = ""
    key_id: str = ""
    private_key: str = ""


@dataclass(frozen=True)
class CloudConfig:
    origin: str
    providers: dict[str, Provider]

    def __post_init__(self):
        url = urlsplit(self.origin)
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            url.scheme not in {"https", "http"}
            or (url.scheme != "https" and not local)
            or not url.netloc
            or url.username
            or url.password
            or url.path
            or url.query
            or url.fragment
        ):
            raise ValueError(
                "TMP_CASH_CLOUD_ORIGIN must be an HTTPS origin (HTTP only on localhost)"
            )
        if not self.providers or set(self.providers) - {"google", "apple"}:
            raise ValueError("Configure at least one cloud login provider")
        if "apple" in self.providers and url.scheme != "https":
            raise ValueError("Apple sign-in requires an HTTPS origin")

    @classmethod
    def from_mapping(cls, values: Mapping[str, str | None]):
        origin = values.get("TMP_CASH_CLOUD_ORIGIN")
        if not origin:
            return None
        providers = {}
        google = values.get("TMP_CASH_GOOGLE_CLIENT_ID")
        if google:
            secret = values.get("TMP_CASH_GOOGLE_CLIENT_SECRET")
            if not secret:
                raise ValueError("Configure TMP_CASH_GOOGLE_CLIENT_SECRET")
            providers["google"] = Provider(google, secret)
        apple = values.get("TMP_CASH_APPLE_CLIENT_ID")
        if apple:
            team = values.get("TMP_CASH_APPLE_TEAM_ID")
            key = values.get("TMP_CASH_APPLE_KEY_ID")
            file = values.get("TMP_CASH_APPLE_PRIVATE_KEY_FILE")
            if not (team and key and file):
                raise ValueError(
                    "Configure Apple's team ID, key ID and private key file"
                )
            private_key = Path(file).read_text()
            # Validate the key at startup; client secrets are minted on demand.
            jwt.encode({"test": True}, private_key, algorithm="ES256")
            providers["apple"] = Provider(
                apple, team_id=team, key_id=key, private_key=private_key
            )
        return cls(origin.rstrip("/"), providers)


ENDPOINTS = {
    "google": (
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        "https://www.googleapis.com/oauth2/v3/certs",
        ("https://accounts.google.com", "accounts.google.com"),
    ),
    "apple": (
        "https://appleid.apple.com/auth/authorize",
        "https://appleid.apple.com/auth/token",
        "https://appleid.apple.com/auth/keys",
        ("https://appleid.apple.com",),
    ),
}


class CloudIdentity:
    def __init__(self, config: CloudConfig, transport=None):
        self.config = config
        self.transport = transport
        self.keys: dict[str, tuple[float, dict]] = {}

    async def authenticate(self, provider: str, code: str, login: dict) -> dict:
        settings = self.config.providers[provider]
        _, token_url, jwks_url, issuers = ENDPOINTS[provider]
        secret = settings.client_secret
        if provider == "apple":
            now = int(time.time())
            secret = jwt.encode(
                {
                    "iss": settings.team_id,
                    "iat": now,
                    "exp": now + 300,
                    "aud": "https://appleid.apple.com",
                    "sub": settings.client_id,
                },
                settings.private_key,
                algorithm="ES256",
                headers={"kid": settings.key_id},
            )
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.config.origin + "/api/cloud/callback/" + provider,
            "client_id": settings.client_id,
            "client_secret": secret,
        }
        if provider == "google":
            data["code_verifier"] = login["verifier"]
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
            response = await client.post(token_url, data=data)
            response.raise_for_status()
            token = response.json()["id_token"]
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
                raise ValueError("Invalid ID token")
            cached_at, jwks = self.keys.get(provider, (0, {}))
            if time.monotonic() - cached_at > 3600 or not any(
                k.get("kid") == header["kid"] for k in jwks.get("keys", [])
            ):
                response = await client.get(jwks_url)
                response.raise_for_status()
                jwks = response.json()
                self.keys[provider] = (time.monotonic(), jwks)
            public = next((k for k in jwks["keys"] if k["kid"] == header["kid"]), None)
            if public is None:
                raise ValueError("Unknown ID token signing key")
            claims = jwt.decode(
                token,
                jwt.PyJWK.from_dict(public).key,
                algorithms=["RS256"],
                audience=settings.client_id,
                issuer=issuers,
                options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]},
            )
            if not secrets.compare_digest(claims["nonce"], login["nonce"]):
                raise ValueError("Invalid ID token nonce")
            if not isinstance(claims["sub"], str) or not 1 <= len(claims["sub"]) <= 255:
                raise ValueError("Invalid subject")
            if claims.get("azp", settings.client_id) != settings.client_id:
                raise ValueError("Invalid authorized party")
            return claims


async def bounded_body(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(413, "Backup or request is too large")
    return bytes(body)


def create_cloud_app(
    config: CloudConfig, location: Path | str, *, transport=None
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    db = Database(location, CLOUD)
    with db.transaction() as conn:
        conn.create_store()
    if db.path:
        db.path.chmod(0o600)
    identity = CloudIdentity(config, transport)
    app.state.db = db
    app.state.identity = identity
    secure = config.origin.startswith("https:")

    @app.middleware("http")
    async def private_response(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def mutation(request: Request):
        if (
            request.headers.get("origin") != config.origin
            or request.headers.get("x-cloud-request") != "1"
        ):
            raise HTTPException(403, "Invalid request origin")

    async def session(request: Request) -> dict:
        token = request.cookies.get(SESSION_COOKIE, "")
        row = (
            await db.run_read(lambda c: c.get("sessions", id=digest(token)))
            if token
            else None
        )
        if row is None or row["expires"] <= int(time.time()):
            raise HTTPException(401, "Sign in to cloud backups again")
        expected = request.headers.get("x-cloud-account")
        if (
            request.url.path != "/api/cloud/status"
            and (
                request.url.path.endswith("/backups") or "/backups/" in request.url.path
            )
            and expected != row["account"]
        ):
            raise HTTPException(409, "Cloud account changed. Reload before continuing.")
        return dict(row)

    def metadata(row):
        return {
            key: row[key] for key in ("id", "name", "revision", "updated", "encrypted")
        }

    @app.get("/status")
    async def status(request: Request):
        try:
            user = await session(request)
        except HTTPException:
            user = None
        return {
            "providers": list(config.providers),
            "user": (
                {key: user[key] for key in ("account", "provider", "label")}
                if user
                else None
            ),
        }

    @app.get("/login/{provider}")
    async def login(provider: str):
        if provider not in config.providers:
            raise HTTPException(404, "Login provider is not configured")
        state, binding, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(4))
        now = int(time.time())

        def save(c: Crud):
            c.cloud_prune_auth(now)
            c.insert(
                "logins",
                {
                    "id": digest(state),
                    "provider": provider,
                    "binding": digest(binding),
                    "nonce": nonce,
                    "verifier": verifier,
                    "expires": now + 600,
                },
            )

        await db.run_transaction(save)
        parameters = {
            "client_id": config.providers[provider].client_id,
            "redirect_uri": config.origin + "/api/cloud/callback/" + provider,
            "response_type": "code",
            "scope": "openid email" if provider == "google" else "email",
            "state": state,
            "nonce": nonce,
        }
        if provider == "google":
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                .rstrip(b"=")
                .decode()
            )
            parameters.update(code_challenge=challenge, code_challenge_method="S256")
        else:
            parameters["response_mode"] = "form_post"
        response = RedirectResponse(
            ENDPOINTS[provider][0] + "?" + urlencode(parameters), status_code=303
        )
        response.set_cookie(
            LOGIN_COOKIE,
            binding,
            max_age=600,
            httponly=True,
            secure=secure,
            samesite="none" if provider == "apple" else "lax",
            path="/api/cloud",
        )
        return response

    @app.api_route("/callback/{provider}", methods=["GET", "POST"])
    async def callback(provider: str, request: Request):
        response = RedirectResponse(
            config.origin + "/wallet/?cloud=error", status_code=303
        )
        response.delete_cookie(
            LOGIN_COOKIE,
            path="/api/cloud",
            secure=secure,
            httponly=True,
            samesite="none" if provider == "apple" else "lax",
        )
        if provider not in config.providers:
            return response
        if request.method == "POST":
            form = parse_qs(
                (await bounded_body(request, 16384)).decode(), max_num_fields=16
            )
            params = {
                key: values[0] for key, values in form.items() if len(values) == 1
            }
        else:
            params = dict(request.query_params)
        # Uvicorn logs the scope's query string when sending the response.
        # Authorization codes and state must not enter access logs.
        request.scope["query_string"] = b""
        state, binding = params.get("state", ""), request.cookies.get(LOGIN_COOKIE, "")

        def consume(c: Crud):
            row = c.get("logins", id=digest(state), for_update=True)
            if (
                row is None
                or row["provider"] != provider
                or row["expires"] <= int(time.time())
                or not secrets.compare_digest(row["binding"], digest(binding))
            ):
                return None
            c.delete("logins", id=digest(state))
            return dict(row)

        pending = await db.run_transaction(consume) if state and binding else None
        if not pending or "error" in params or not params.get("code"):
            return response
        try:
            claims = await identity.authenticate(provider, params["code"], pending)
        except (
            httpx.HTTPError,
            jwt.PyJWTError,
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
        ):
            return response
        account = digest(provider + "\0" + claims["sub"])
        label = claims.get("email")
        if not isinstance(label, str) or len(label) > 320:
            label = provider.title() + " account"
        token = secrets.token_urlsafe(32)
        await db.run_transaction(
            lambda c: c.insert(
                "sessions",
                {
                    "id": digest(token),
                    "account": account,
                    "provider": provider,
                    "label": label,
                    "expires": int(time.time()) + SESSION_SECONDS,
                },
            )
        )
        # Rotate any existing session on successful sign-in.
        old = request.cookies.get(SESSION_COOKIE)
        if old:
            await db.run_transaction(lambda c: c.delete("sessions", id=digest(old)))
        response.headers["location"] = config.origin + "/wallet/?cloud=connected"
        response.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=SESSION_SECONDS,
            httponly=True,
            secure=secure,
            samesite="lax",
            path="/api/cloud",
        )
        return response

    @app.post("/logout")
    async def logout(request: Request):
        mutation(request)
        token = request.cookies.get(SESSION_COOKIE, "")
        await db.run_transaction(lambda c: c.delete("sessions", id=digest(token)))
        response = JSONResponse({"ok": True})
        response.delete_cookie(
            SESSION_COOKIE,
            path="/api/cloud",
            secure=secure,
            httponly=True,
            samesite="lax",
        )
        return response

    @app.get("/backups")
    async def backups(request: Request):
        user = await session(request)
        rows = await db.run_read(
            lambda c: c.select(
                "backups",
                columns=("id", "name", "revision", "updated", "encrypted"),
                account=user["account"],
            )
        )
        return {
            "backups": sorted(
                (metadata(row) for row in rows),
                key=lambda r: r["updated"],
                reverse=True,
            )
        }

    @app.get("/backups/{backup_id}")
    async def download(backup_id: UUID, request: Request):
        user = await session(request)
        row = await db.run_read(
            lambda c: c.get("backups", account=user["account"], id=str(backup_id))
        )
        if row is None:
            raise HTTPException(404, "Backup not found")
        return {**metadata(row), "payload": row["payload"]}

    @app.put("/backups/{backup_id}")
    async def upload(backup_id: UUID, request: Request):
        mutation(request)
        user = await session(request)
        try:
            body = json.loads(
                await bounded_body(request, MAX_BACKUP_BYTES * 2 + 100_000)
            )
            payload, name, revision = body["payload"], body["name"], body["revision"]
            if not isinstance(payload, str) or len(payload.encode()) > MAX_BACKUP_BYTES:
                raise ValueError()
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                raise ValueError()
            if type(revision) is not int or revision < 0:
                raise ValueError()
            envelope = json.loads(payload)
            if envelope.get("version") != 1:
                raise ValueError()
            encrypted = envelope.get("format") == "cashu-layer3-encrypted"
            if encrypted:
                if (
                    envelope.get("kdf") != "PBKDF2-SHA256"
                    or envelope.get("iterations") != 250000
                ):
                    raise ValueError()
                for key, size in (("salt", 16), ("iv", 12)):
                    if len(base64.b64decode(envelope[key], validate=True)) != size:
                        raise ValueError()
                if len(base64.b64decode(envelope["ciphertext"], validate=True)) < 16:
                    raise ValueError()
            elif envelope.get("format") == "tmp-cash-plaintext":
                if (
                    body.get("acknowledgeUnencrypted") is not True
                    or not isinstance(envelope.get("state"), dict)
                    or not isinstance(envelope.get("mint"), str)
                ):
                    raise ValueError()
            else:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise HTTPException(
                400, "Invalid backup or missing unencrypted-backup acknowledgement"
            ) from None
        now = int(time.time())

        def save(c: Crud):
            c.lock_keys("cloud-account", [user["account"]])
            current = c.get(
                "backups", account=user["account"], id=str(backup_id), for_update=True
            )
            if current is None:
                if revision != 0:
                    raise HTTPException(
                        409,
                        "Cloud backup changed. Pause backups and reconnect this wallet.",
                    )
                if (
                    len(c.select("backups", columns=("id",), account=user["account"]))
                    >= 10
                ):
                    raise HTTPException(
                        409, "Cloud backup limit reached. Delete an old backup first."
                    )
                c.insert(
                    "backups",
                    {
                        "account": user["account"],
                        "id": str(backup_id),
                        "revision": 0,
                        "updated": now,
                        "name": name.strip(),
                        "encrypted": encrypted,
                        "payload": "",
                    },
                )
            elif current["revision"] != revision:
                # A committed upload may lose its HTTP response. Replaying the
                # exact previous request acknowledges that save without writing
                # again or allowing an older snapshot to replace a newer one.
                if (
                    current["revision"] == revision + 1
                    and current["payload"] == payload
                    and current["name"] == name.strip()
                    and current["encrypted"] == encrypted
                ):
                    return metadata(current)
                raise HTTPException(
                    409,
                    "Cloud backup changed. Pause backups and reconnect this wallet.",
                )
            result = c.update(
                "backups",
                {
                    "revision": revision + 1,
                    "updated": now,
                    "name": name.strip(),
                    "encrypted": encrypted,
                    "payload": payload,
                },
                account=user["account"],
                id=str(backup_id),
                revision=revision,
            )
            if result.rowcount != 1:
                raise HTTPException(
                    409,
                    "Cloud backup changed. Pause backups and reconnect this wallet.",
                )
            return {
                "id": str(backup_id),
                "name": name.strip(),
                "revision": revision + 1,
                "updated": now,
                "encrypted": encrypted,
            }

        return await db.run_transaction(save)

    @app.delete("/backups/{backup_id}")
    async def delete(backup_id: UUID, request: Request):
        mutation(request)
        user = await session(request)
        await db.run_transaction(
            lambda c: c.delete("backups", account=user["account"], id=str(backup_id))
        )
        return {"ok": True}

    return app
