import base64
import hashlib
import json
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tmp_cash.cloud import CloudConfig, Provider, create_cloud_app

ORIGIN = "https://wallet.example"


@pytest.fixture
def cloud(tmp_path):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    jwk.update(kid="test-key", alg="RS256", use="sig")
    apple_key = ec.generate_private_key(ec.SECP256R1())
    from cryptography.hazmat.primitives import serialization

    apple_pem = apple_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    codes = {}
    exchanges = []

    def provider(request):
        if request.url.path.endswith(("certs", "keys")):
            return httpx.Response(200, json={"keys": [jwk]})
        data = {
            key: values[0] for key, values in parse_qs(request.content.decode()).items()
        }
        exchanges.append(data)
        claims = codes[data["code"]]
        return httpx.Response(
            200,
            json={
                "id_token": jwt.encode(
                    claims,
                    rsa.generate_private_key(public_exponent=65537, key_size=2048)
                    if claims.get("invalid_signature")
                    else private,
                    algorithm="RS256",
                    headers={"kid": "test-key"},
                )
            },
        )

    config = CloudConfig(
        ORIGIN,
        {
            "google": Provider("google-client", "google-secret"),
            "apple": Provider(
                "apple-client",
                team_id="team",
                key_id="apple-key",
                private_key=apple_pem,
            ),
        },
    )
    transport = httpx.MockTransport(provider)
    location = tmp_path / "cloud.sqlite3"

    def make_client():
        app = FastAPI()
        service = create_cloud_app(config, location, transport=transport)
        app.mount("/api/cloud", service)
        return TestClient(app, base_url=ORIGIN), service

    client, service = make_client()

    def login(
        client=client, provider="google", subject="alice", overrides=None, finish=True
    ):
        start = client.get("/api/cloud/login/" + provider, follow_redirects=False)
        assert start.status_code == 303
        query = {
            k: v[0]
            for k, v in parse_qs(urlsplit(start.headers["location"]).query).items()
        }
        now = int(time.time())
        code = str(uuid4())
        codes[code] = {
            "iss": "https://accounts.google.com"
            if provider == "google"
            else "https://appleid.apple.com",
            "sub": subject,
            "aud": provider + "-client",
            "iat": now,
            "exp": now + 300,
            "nonce": query["nonce"],
            "email": "same-email@example.com",
            **(overrides or {}),
        }
        params = {"code": code, "state": query["state"]}
        if not finish:
            return query, params
        if provider == "apple":
            result = client.post(
                "/api/cloud/callback/apple", data=params, follow_redirects=False
            )
        else:
            result = client.get(
                "/api/cloud/callback/google", params=params, follow_redirects=False
            )
        return result, query

    return client, service, login, make_client, exchanges


def headers(client):
    account = client.get("/api/cloud/status").json()["user"]["account"]
    return {"Origin": ORIGIN, "X-Cloud-Request": "1", "X-Cloud-Account": account}


def payload(**changes):
    return {
        "name": "Laptop",
        "revision": 0,
        "acknowledgeUnencrypted": True,
        "payload": json.dumps(
            {
                "format": "tmp-cash-plaintext",
                "version": 1,
                "mint": "https://mint.example",
                "state": {
                    "proofs": [],
                    "fundings": [],
                    "operations": [],
                    "activity": [],
                },
            }
        ),
        **changes,
    }


@pytest.mark.parametrize("provider", ["google", "apple"])
def test_signin_validates_signed_identity_and_uses_secure_cookies(cloud, provider):
    client, _, login, _, exchanges = cloud
    result, query = login(provider=provider)
    assert "cloud=connected" in result.headers["location"]
    assert "Secure" in result.headers["set-cookie"]
    assert "HttpOnly" in result.headers["set-cookie"]
    assert "SameSite=lax" in result.headers["set-cookie"]
    user = client.get("/api/cloud/status").json()["user"]
    assert user["provider"] == provider
    assert user["label"] == "same-email@example.com"
    exchange = exchanges[-1]
    assert exchange["redirect_uri"] == ORIGIN + "/api/cloud/callback/" + provider
    if provider == "google":
        challenge = (
            base64.urlsafe_b64encode(
                hashlib.sha256(exchange["code_verifier"].encode()).digest()
            )
            .rstrip(b"=")
            .decode()
        )
        assert query["code_challenge"] == challenge
        assert query["code_challenge_method"] == "S256"
    else:
        assert query["response_mode"] == "form_post"
        # Apple client-secret JWT is ES256, bound to team and Services ID.
        claims = jwt.decode(
            exchange["client_secret"], options={"verify_signature": False}
        )
        assert claims["iss"] == "team" and claims["sub"] == "apple-client"
        assert claims["exp"] - claims["iat"] == 300


@pytest.mark.parametrize(
    "overrides",
    [
        {"nonce": "other"},
        {"aud": "other"},
        {"iss": "https://attacker.example"},
        {"exp": 1},
        {"sub": ""},
        {"invalid_signature": True},
    ],
)
def test_rejects_invalid_identity(cloud, overrides):
    client, _, login, _, _ = cloud
    result, _ = login(overrides=overrides)
    assert "cloud=error" in result.headers["location"]
    assert client.get("/api/cloud/status").json()["user"] is None


def test_login_requires_browser_binding_and_one_time_state(cloud):
    client, _, login, make_client, _ = cloud
    _, params = login(finish=False)
    attacker, _ = make_client()
    assert (
        "cloud=error"
        in attacker.get(
            "/api/cloud/callback/google", params=params, follow_redirects=False
        ).headers["location"]
    )
    assert (
        "cloud=connected"
        in client.get(
            "/api/cloud/callback/google", params=params, follow_redirects=False
        ).headers["location"]
    )
    assert (
        "cloud=error"
        in client.get(
            "/api/cloud/callback/google", params=params, follow_redirects=False
        ).headers["location"]
    )


def test_login_state_expires(cloud):
    client, service, login, _, _ = cloud
    _, params = login(finish=False)
    with service.state.db.transaction() as conn:
        conn.update("logins", {"expires": 1})
    assert (
        "cloud=error"
        in client.get(
            "/api/cloud/callback/google", params=params, follow_redirects=False
        ).headers["location"]
    )


def test_backups_persist_and_are_isolated_by_provider_and_subject(cloud):
    client, _, login, make_client, _ = cloud
    login()
    identifier = str(uuid4())
    path = "/api/cloud/backups/" + identifier
    h = headers(client)
    assert client.put(path, headers=h, json=payload()).status_code == 200
    assert client.get(path, headers=h).json()["payload"] == payload()["payload"]
    fresh, _ = make_client()
    fresh.cookies.update(client.cookies)
    assert fresh.get(path, headers=h).status_code == 200
    assert (
        fresh.get("/api/cloud/backups", headers=h).json()["backups"][0]["name"]
        == "Laptop"
    )
    login(provider="apple")
    assert client.get(path, headers=headers(client)).status_code == 404
    login(subject="bob")
    assert client.get(path, headers=headers(client)).status_code == 404
    assert client.get(path, headers=h).status_code == 409
    login()
    assert client.get(path, headers=headers(client)).status_code == 200


def test_upload_requires_acknowledgement_and_same_origin(cloud):
    client, _, login, _, _ = cloud
    path = "/api/cloud/backups/" + str(uuid4())
    assert client.get(path).status_code == 401
    login()
    h = headers(client)
    assert (
        client.put(
            path, headers=h, json=payload(acknowledgeUnencrypted=False)
        ).status_code
        == 400
    )
    assert (
        client.put(
            path, headers={**h, "Origin": "https://attacker.example"}, json=payload()
        ).status_code
        == 403
    )
    assert (
        client.put(path, headers={"Origin": ORIGIN}, json=payload()).status_code == 403
    )
    assert client.put(path, headers=h, json=payload()).status_code == 200
    result = client.get(path, headers=h)
    assert result.headers["cache-control"] == "no-store"
    assert result.json()["encrypted"] is False
    assert client.put(path, headers=h, json=payload()).status_code == 200
    assert (
        client.put(path, headers=h, json=payload(name="Different wallet")).status_code
        == 409
    )
    assert client.put(path, headers=h, json=payload(revision=1)).json()["revision"] == 2
    assert client.delete(path, headers={**h, "Origin": "null"}).status_code == 403
    assert client.delete(path, headers=h).status_code == 200
    assert client.get(path, headers=h).status_code == 404


def test_encrypted_upload_and_payload_limits(cloud):
    client, _, login, _, _ = cloud
    login()
    h = headers(client)
    path = "/api/cloud/backups/" + str(uuid4())
    envelope = {
        "format": "cashu-layer3-encrypted",
        "version": 1,
        "kdf": "PBKDF2-SHA256",
        "iterations": 250000,
        "salt": base64.b64encode(bytes(16)).decode(),
        "iv": base64.b64encode(bytes(12)).decode(),
        "ciphertext": base64.b64encode(bytes(32)).decode(),
    }
    assert (
        client.put(
            path,
            headers=h,
            json=payload(payload=json.dumps(envelope), acknowledgeUnencrypted=False),
        ).json()["encrypted"]
        is True
    )
    assert (
        client.put(path, headers=h, json=payload(payload="x" * 16_000_001)).status_code
        == 400
    )
    assert client.put(path, headers=h, content=b"x" * 32_100_001).status_code == 413


def test_logout_revokes_session_and_expired_sessions_cannot_download(cloud):
    client, service, login, make_client, _ = cloud
    login()
    copy, _ = make_client()
    copy.cookies.update(client.cookies)
    h = headers(client)
    assert client.post("/api/cloud/logout", headers=h).status_code == 200
    assert copy.get("/api/cloud/backups", headers=h).status_code == 401
    login()
    with service.state.db.transaction() as conn:
        conn.update("sessions", {"expires": 1})
    assert client.get("/api/cloud/backups", headers=h).status_code == 401


def test_cloud_config_is_opt_in_and_rejects_insecure_public_origins():
    assert CloudConfig.from_mapping({}) is None
    for origin in (
        "http://wallet.example",
        "https://wallet.example/path",
        "https://wallet.example?x=y",
    ):
        with pytest.raises(ValueError):
            CloudConfig(origin, {"google": Provider("id", "secret")})
    with pytest.raises(ValueError):
        CloudConfig("http://localhost:5173", {"apple": Provider("id")})


def test_account_backup_quota_can_be_reclaimed_by_deleting_a_copy(cloud):
    client, _, login, _, _ = cloud
    login()
    h = headers(client)
    paths = ["/api/cloud/backups/" + str(uuid4()) for _ in range(11)]
    for path in paths[:10]:
        assert client.put(path, headers=h, json=payload()).status_code == 200
    assert client.put(paths[10], headers=h, json=payload()).status_code == 409
    assert client.delete(paths[0], headers=h).status_code == 200
    assert client.put(paths[10], headers=h, json=payload()).status_code == 200


@pytest.mark.parametrize("encrypted", [True, False])
def test_replayed_upload_acknowledges_only_the_exact_latest_save(
    cloud, monkeypatch, encrypted
):
    client, _, login, _, _ = cloud
    login()
    h = headers(client)
    path = "/api/cloud/backups/" + str(uuid4())
    body = payload()
    if encrypted:
        body["acknowledgeUnencrypted"] = False
        body["payload"] = json.dumps(
            {
                "format": "cashu-layer3-encrypted",
                "version": 1,
                "kdf": "PBKDF2-SHA256",
                "iterations": 250000,
                "salt": base64.b64encode(bytes(16)).decode(),
                "iv": base64.b64encode(bytes(12)).decode(),
                "ciphertext": base64.b64encode(bytes(32)).decode(),
            }
        )
    saved = client.put(path, headers=h, json=body).json()
    now = int(time.time())
    monkeypatch.setattr("tmp_cash.cloud.time.time", lambda: now + 10)
    replayed = client.put(path, headers=h, json=body)
    assert replayed.status_code == 200
    assert replayed.json() == saved
    changed = json.loads(body["payload"])
    if encrypted:
        changed["ciphertext"] = base64.b64encode(b"different-ciphertext" * 2).decode()
    else:
        changed["mint"] = "https://different-mint.example"
    different = {**body, "payload": json.dumps(changed)}
    assert client.put(path, headers=h, json=different).status_code == 409
    updated = client.put(path, headers=h, json={**different, "revision": 1})
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert client.put(path, headers=h, json=body).status_code == 409
    assert client.get(path, headers=h).json()["payload"] == different["payload"]
