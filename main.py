from __future__ import annotations

import logging
import secrets
import sqlite3
import string
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Union, Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from database import execute, fetch_all, fetch_one, get_connection, get_settings, init_db, set_settings
from payfast import (
    build_signature,
    get_payfast_url,
    validate_itn,
)
from bulksms import send_voucher_sms
from mikrotik import (
    MikroTikConfigError,
    MikroTikConnectionError,
    create_hotspot_user,
    get_hotspot_usage,
    sync_hotspot_user_profile,
    test_connection,
    create_hotspot_user_with_limits,
    configure_hotspot_profile,
    add_walled_garden,
    add_ip_binding,
    disable_hotspot_user,
    get_user_statistics,
    get_available_hotspot_profiles,
    setup_netcash_walled_garden,
    setup_payfast_walled_garden,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
LOGGER = logging.getLogger("wonke-connect")
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[handler])
ALPHABET = string.ascii_uppercase + string.digits


def _generate_payment_id() -> str:
    """Generate a unique merchant payment ID."""
    return secrets.token_hex(16)


def _is_sandbox(value: str) -> bool:
    """Return True if the sandbox setting string means 'enabled'."""
    return value.strip().lower() not in ("false", "0", "no", "off", "")


def get_payfast_config() -> dict:
    """Read PayFast settings: env vars take priority over DB (for Railway deployments)."""
    import os
    db = get_settings([
        "payfast_merchant_id", "payfast_merchant_key",
        "payfast_passphrase", "payfast_server_url",
        "payfast_sandbox", "mikrotik_sync_api_key",
    ])
    return {
        "payfast_merchant_id":  os.getenv("PAYFAST_MERCHANT_ID",  db.get("payfast_merchant_id", "")),
        "payfast_merchant_key": os.getenv("PAYFAST_MERCHANT_KEY", db.get("payfast_merchant_key", "")),
        "payfast_passphrase":   os.getenv("PAYFAST_PASSPHRASE",   db.get("payfast_passphrase", "")),
        "payfast_server_url":   os.getenv("PAYFAST_SERVER_URL",   db.get("payfast_server_url", "")),
        "payfast_sandbox":      os.getenv("PAYFAST_SANDBOX") or db.get("payfast_sandbox", "true"),
        "mikrotik_sync_api_key": os.getenv("MIKROTIK_SYNC_API_KEY", db.get("mikrotik_sync_api_key", "")),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        init_db()
        LOGGER.info("Database initialized successfully")
    except Exception as exc:
        LOGGER.error("Failed to initialize database during startup: %s", exc, exc_info=True)
        raise
    yield


app = FastAPI(
    title="Wonke Connect Voucher Manager",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

class PermissionsPolicyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        response.headers["Permissions-Policy"] = "payment=*"
        return response

app.add_middleware(PermissionsPolicyMiddleware)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/marketing", StaticFiles(directory=BASE_DIR / "1voucher_marketing"), name="marketing")


class VoucherBase(BaseModel):
    hotspot_user_profile: str = Field(..., min_length=1, max_length=50)
    code_length: int = Field(default=8, ge=6, le=8)

    @field_validator("hotspot_user_profile")
    @classmethod
    def validate_hotspot_user_profile(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("HotSpot user profile is required.")
        return value


class CreateVoucherRequest(VoucherBase):
    pass


class BulkCreateRequest(VoucherBase):
    quantity: int = Field(..., ge=1, le=200)


class PlanBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    hotspot_user_profile: str = Field(..., min_length=1, max_length=50)
    duration_label: str = Field(..., min_length=1, max_length=60)
    badge_label: str = Field(..., min_length=1, max_length=30)
    note: str = Field(..., min_length=1, max_length=255)
    price: float = Field(default=0.0, ge=0)
    active: bool = True

    @field_validator("name", "hotspot_user_profile", "duration_label", "badge_label", "note")
    @classmethod
    def validate_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field is required.")
        return value


class PlanCreateRequest(PlanBase):
    pass


class PlanUpdateRequest(PlanBase):
    pass


class PlanResponse(BaseModel):
    id: int
    name: str
    hotspot_user_profile: str
    duration_label: str
    badge_label: str
    note: str
    price: float = 0.0
    active: bool
    created_at: str


class PlanSaveResult(BaseModel):
    plan: PlanResponse
    mikrotik_synced: bool
    mikrotik_message: Optional[str] = None


class VoucherResponse(BaseModel):
    id: int
    code: str
    password: str
    hotspot_user_profile: str
    status: str
    created_at: str
    expires_at: Optional[str] = None
    deactivated_at: Optional[str] = None
    plan_name: str = ""
    duration_label: str = ""
    badge_label: str = ""
    note: str = ""


class VoucherCreateResult(BaseModel):
    voucher: VoucherResponse
    mikrotik_synced: bool
    mikrotik_message: Optional[str] = None


class BulkCreateResult(BaseModel):
    vouchers: list[VoucherResponse]
    synced_count: int
    failed_sync_count: int
    mikrotik_errors: list[str]


class StatsResponse(BaseModel):
    total: int
    used: int
    unused: int


class SyncStatusResponse(BaseModel):
    updated: int
    active_users: int
    message: str


class MikroTikSettingsResponse(BaseModel):
    host: str = ""
    username: str = ""
    password: str = ""
    port: int = 8728
    use_ssl: bool = False
    plaintext_login: bool = True


class MikroTikSettingsRequest(BaseModel):
    host: str = Field(..., min_length=1, max_length=255)
    username: str = Field(..., min_length=1, max_length=255)
    password: str = Field(default="", max_length=255)
    port: int = Field(default=8728, ge=1, le=65535)
    use_ssl: bool = False
    plaintext_login: bool = True

    @field_validator("host", "username")
    @classmethod
    def validate_setting_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field is required.")
        return value

    @field_validator("password")
    @classmethod
    def normalize_password(cls, value: str) -> str:
        return value.strip()


class MikroTikConnectionStatusResponse(BaseModel):
    connected: bool
    message: str


class HotSpotProfileRequest(BaseModel):
    profile_name: str = Field(..., min_length=1, max_length=50)
    rate_limit: Optional[str] = Field(None, max_length=100)  # e.g., "512k/1M"
    session_timeout: Optional[str] = Field(None, max_length=50)  # e.g., "1h"
    idle_timeout: Optional[str] = Field(None, max_length=50)  # e.g., "5m"
    keepalive_timeout: Optional[str] = Field(None, max_length=50)
    login_by: Optional[str] = Field(None, max_length=100)  # e.g., "http-chap,cookie"

    @field_validator("profile_name")
    @classmethod
    def validate_profile_name(cls, value: str) -> str:
        return value.strip()


class WalledGardenRequest(BaseModel):
    dst_host: str = Field(..., min_length=1, max_length=255)
    action: str = Field(default="allow", pattern="^(allow|deny)$")
    path: Optional[str] = Field(None, max_length=255)
    method: Optional[str] = Field(None, max_length=50)


class IPBindingRequest(BaseModel):
    src_address: str = Field(..., min_length=7, max_length=50)  # IP or range
    mac_address: str = Field(..., pattern=r"^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$")
    to_address: Optional[str] = Field(None, min_length=7, max_length=50)
    binding_type: str = Field(default="regular", pattern="^(regular|bypassed|blocked)$")


class VoucherWithLimitsRequest(VoucherBase):
    rate_limit: Optional[str] = Field(None, max_length=100)
    session_timeout: Optional[str] = Field(None, max_length=50)
    idle_timeout: Optional[str] = Field(None, max_length=50)
    limit_bytes_total: int = Field(default=0, ge=0)  # 0 means unlimited
    limit_uptime: Optional[str] = Field(None, max_length=50)


class UserStatisticsResponse(BaseModel):
    code: str
    bytes_in: int = 0
    bytes_out: int = 0
    bytes_total: int = 0
    uptime: Optional[str] = None
    current_limit_bytes_total: int = 0


class MikroTikConnectionStatusResponse(BaseModel):
    connected: bool
    message: str


class PayFastSettingsRequest(BaseModel):
    merchant_id: str = Field(..., min_length=1, max_length=20)
    merchant_key: str = Field(..., min_length=1, max_length=50)
    passphrase: str = Field(default="", max_length=255)
    server_url: str = Field(..., min_length=1, max_length=255,
                            description="Public URL of this server, e.g. https://wifi.myshop.co.za")
    sandbox: bool = True
    mikrotik_sync_api_key: str = Field(default="", max_length=128)


class PayFastSettingsResponse(BaseModel):
    merchant_id: str = ""
    merchant_key: str = ""
    passphrase: str = ""
    server_url: str = ""
    sandbox: bool = True
    configured: bool = False
    mikrotik_sync_api_key: str = ""


class NetcashSettingsRequest(BaseModel):
    service_key: str = Field(..., min_length=1, max_length=100,
                             description="Pay Now Service Key (GUID) from your Netcash account")
    server_url: str = Field(..., min_length=1, max_length=255,
                            description="Public URL of this server, e.g. https://wifi.myshop.co.za")

    @field_validator("service_key", "server_url")
    @classmethod
    def validate_setting_text(cls, value: str) -> str:
        return value.strip()


class NetcashSettingsResponse(BaseModel):
    service_key: str = ""
    server_url: str = ""
    configured: bool = False


class PaymentInitiateRequest(BaseModel):
    plan_id: int
    name_first: str = Field(..., min_length=1, max_length=100)
    name_last: str = Field(..., min_length=1, max_length=100)
    cell_number: str = Field(..., min_length=7, max_length=20)
    pay_method: Optional[str] = Field(None, pattern="^(eft)$", max_length=3)

    @field_validator("name_first", "name_last")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return value.strip()

    @field_validator("cell_number")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        cleaned = "".join(c for c in value if c.isdigit() or c in "+() -")
        if len(cleaned.replace(" ", "").replace("-", "")) < 7:
            raise ValueError("Phone number is too short.")
        return cleaned.strip()


class OrderStatusResponse(BaseModel):
    m_payment_id: str
    status: str
    amount: float
    plan_name: str
    voucher_code: Optional[str] = None


@app.get("/")
def serve_dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/portal")
def serve_portal() -> FileResponse:
    return FileResponse(STATIC_DIR / "portal.html", headers={"Permissions-Policy": "payment=*"})


@app.post("/portal")
async def serve_portal_post(request: Request) -> RedirectResponse:
    """Netcash POSTs to the portal URL — redirect to GET with query params preserved."""
    return RedirectResponse(url=f"/portal?{request.url.query}", status_code=303)


@app.get("/portal/plans")
def list_portal_plans() -> list[dict]:
    """Public endpoint: return active plans with prices for the customer portal."""
    rows = fetch_all(
        """
        SELECT id, name, profile AS hotspot_user_profile, duration_label,
               badge_label, note, price
        FROM plans
        WHERE active = 1
        ORDER BY price ASC, id ASC
        """
    )
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "hotspot_user_profile": row["hotspot_user_profile"],
            "duration_label": row["duration_label"],
            "badge_label": row["badge_label"],
            "note": row["note"],
            "price": float(row["price"] or 0),
        }
        for row in rows
    ]


@app.get("/settings/payfast", response_model=PayFastSettingsResponse)
def get_payfast_settings() -> PayFastSettingsResponse:
    s = get_payfast_config()
    merchant_id = s.get("payfast_merchant_id", "")
    return PayFastSettingsResponse(
        merchant_id=merchant_id,
        merchant_key=s.get("payfast_merchant_key", ""),
        passphrase=s.get("payfast_passphrase", ""),
        server_url=s.get("payfast_server_url", ""),
        sandbox=_is_sandbox(s.get("payfast_sandbox", "true")),
        configured=bool(merchant_id),
        mikrotik_sync_api_key=s.get("mikrotik_sync_api_key", ""),
    )


@app.post("/settings/payfast", response_model=PayFastSettingsResponse)
def save_payfast_settings(payload: PayFastSettingsRequest) -> PayFastSettingsResponse:
    # Auto-generate a sync API key if none provided and none saved yet
    existing_key = get_settings(["mikrotik_sync_api_key"]).get("mikrotik_sync_api_key", "")
    sync_key = payload.mikrotik_sync_api_key.strip() or existing_key or secrets.token_urlsafe(32)
    set_settings({
        "payfast_merchant_id": payload.merchant_id,
        "payfast_merchant_key": payload.merchant_key,
        "payfast_passphrase": payload.passphrase,
        "payfast_server_url": payload.server_url.rstrip("/"),
        "payfast_sandbox": "false" if not payload.sandbox else "true",
        "mikrotik_sync_api_key": sync_key,
    })
    return PayFastSettingsResponse(
        merchant_id=payload.merchant_id,
        merchant_key=payload.merchant_key,
        passphrase=payload.passphrase,
        server_url=payload.server_url.rstrip("/"),
        sandbox=payload.sandbox,
        configured=True,
        mikrotik_sync_api_key=sync_key,
    )


def get_netcash_config() -> dict:
    """Read Netcash settings from DB, env vars take priority."""
    import os
    db = get_settings(["netcash_service_key", "netcash_server_url"])
    return {
        "netcash_service_key": os.getenv("NETCASH_SERVICE_KEY", db.get("netcash_service_key", "")),
        "netcash_server_url": os.getenv("NETCASH_SERVER_URL", db.get("netcash_server_url", "")),
    }


def get_bulksms_config() -> dict:
    """Read BulkSMS settings: env vars take priority over DB.

    Supports two formats:
      - BULKSMS_TOKEN_ID + BULKSMS_TOKEN_SECRET  (separate)
      - BULKSMS_TOKEN  (the Base64 'Basic Auth' string shown in the BulkSMS dashboard)
    """
    import os
    db = get_settings(["bulksms_token_id", "bulksms_token_secret", "bulksms_token"])
    # Combined token takes priority if set
    combined = os.getenv("BULKSMS_TOKEN", db.get("bulksms_token", ""))
    if combined:
        return {"bulksms_token_id": combined, "bulksms_token_secret": ""}
    return {
        "bulksms_token_id": os.getenv("BULKSMS_TOKEN_ID", db.get("bulksms_token_id", "")),
        "bulksms_token_secret": os.getenv("BULKSMS_TOKEN_SECRET", db.get("bulksms_token_secret", "")),
    }


def _try_send_voucher_sms(m_payment_id: str, voucher_code: str, plan_name: str) -> None:
    """Look up buyer phone from the order and send SMS if BulkSMS is configured."""
    cfg = get_bulksms_config()
    token_id = cfg.get("bulksms_token_id", "")
    token_secret = cfg.get("bulksms_token_secret", "")  # empty string is valid for combined token
    if not token_id:
        LOGGER.info("BulkSMS not configured — skipping SMS for order %s", m_payment_id)
        return

    order = fetch_one(
        "SELECT buyer_phone FROM orders WHERE m_payment_id = ?",
        (m_payment_id,),
    )
    if not order or not order["buyer_phone"]:
        LOGGER.warning("No phone number for order %s — skipping SMS", m_payment_id)
        return

    LOGGER.info("Sending SMS for order %s to %s", m_payment_id, order["buyer_phone"])
    send_voucher_sms(
        token_id=token_id,
        token_secret=token_secret,
        to=order["buyer_phone"],
        voucher_code=voucher_code,
        plan_name=plan_name,
    )


@app.get("/settings/netcash", response_model=NetcashSettingsResponse)
def get_netcash_settings() -> NetcashSettingsResponse:
    cfg = get_netcash_config()
    service_key = cfg.get("netcash_service_key", "")
    return NetcashSettingsResponse(
        service_key=service_key,
        server_url=cfg.get("netcash_server_url", ""),
        configured=bool(service_key),
    )


@app.post("/settings/netcash", response_model=NetcashSettingsResponse)
def save_netcash_settings(payload: NetcashSettingsRequest) -> NetcashSettingsResponse:
    set_settings({
        "netcash_service_key": payload.service_key,
        "netcash_server_url": payload.server_url.rstrip("/"),
    })
    return NetcashSettingsResponse(
        service_key=payload.service_key,
        server_url=payload.server_url.rstrip("/"),
        configured=True,
    )


@app.post("/payment/netcash/initiate")
def initiate_netcash_payment(payload: PaymentInitiateRequest) -> dict:
    """Create a pending order and return Netcash Pay Now form parameters."""
    plan = fetch_one(
        "SELECT id, name, profile, price, active FROM plans WHERE id = ?",
        (payload.plan_id,),
    )
    if not plan or not plan["active"]:
        raise HTTPException(status_code=404, detail="Plan not found or inactive.")

    price = float(plan["price"] or 0)
    if price <= 0:
        raise HTTPException(
            status_code=400,
            detail="This plan has no price set. Contact staff for assistance.",
        )

    cfg = get_netcash_config()
    service_key = cfg.get("netcash_service_key", "")
    server_url = cfg.get("netcash_server_url", "").rstrip("/")

    if not service_key:
        raise HTTPException(
            status_code=503,
            detail="1Voucher payments are not configured yet. Please contact staff.",
        )
    if not server_url:
        raise HTTPException(
            status_code=503,
            detail="Server URL is not configured for payments. Contact staff.",
        )

    m_payment_id = _generate_payment_id()
    created_at = utc_now()

    execute(
        """
        INSERT INTO orders
            (m_payment_id, plan_id, buyer_name_first, buyer_name_last,
             buyer_phone, amount, status, payment_method, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 'netcash', ?, ?)
        """,
        (
            m_payment_id,
            plan["id"],
            payload.name_first,
            payload.name_last,
            payload.cell_number,
            price,
            created_at,
            created_at,
        ),
    )

    params = {
        "m1": service_key,
        "m2": "24ade73c-98cf-47b3-99be-cc7b867b3080",  # Netcash default ISV Software Vendor Key
        "p2": m_payment_id,                              # Unique transaction reference (used once)
        "p3": f"Wonke Connect WiFi - {plan['name']}",   # Description
        "p4": f"{price:.2f}",                            # Amount in ZAR
        "Budget": "Y",                                   # Required by Netcash
        "m5": f"{server_url}/payment/netcash/notify",   # Server-to-server postback
        "m6": f"{server_url}/portal?status=success&m_payment_id={m_payment_id}",  # Success redirect (same as PayFast)
        "m7": f"{server_url}/portal?status=cancel",      # Cancel redirect (same as PayFast)
    }
    LOGGER.info(
        "Netcash initiate: ref=%s m1_prefix=%s p4=%s",
        m_payment_id,
        service_key[:8] + "...",
        params["p4"],
    )
    return {
        "netcash_url": "https://paynow.netcash.co.za/site/paynow.aspx",
        "params": params,
        "m_payment_id": m_payment_id,
    }


@app.get("/payment/netcash/notify", status_code=200)
async def netcash_notify_get(request: Request) -> RedirectResponse:
    """Netcash sometimes redirects the browser to m5 in test mode. Redirect to portal."""
    params = dict(request.query_params)
    ref = params.get("p2", params.get("Reference", ""))
    cfg = get_netcash_config()
    server_url = cfg.get("netcash_server_url", "").rstrip("/")
    if ref and server_url:
        return RedirectResponse(url=f"{server_url}/portal?status=success&m_payment_id={ref}", status_code=303)
    return RedirectResponse(url="/portal?status=success", status_code=303)


@app.get("/payment/netcash/return")
@app.post("/payment/netcash/return")
async def netcash_return(request: Request) -> RedirectResponse:
    """Handles Netcash browser redirect after payment (GET or POST to m6)."""
    # Try multiple sources for the payment reference
    ref = request.query_params.get("ref", "")
    if not ref and request.method == "POST":
        form_data = dict(await request.form())
        ref = form_data.get("p2", form_data.get("Reference", ""))
    if not ref:
        ref = request.query_params.get("p2", request.query_params.get("Reference", ""))
    if ref:
        return RedirectResponse(url=f"/portal?status=success&m_payment_id={ref}", status_code=303)
    return RedirectResponse(url="/portal?status=success", status_code=303)


@app.get("/payment/netcash/cancel")
@app.post("/payment/netcash/cancel")
async def netcash_cancel(request: Request) -> RedirectResponse:
    """Handles Netcash browser redirect on cancel (GET or POST to m7)."""
    return RedirectResponse(url="/portal?status=cancel", status_code=303)


@app.post("/payment/netcash/notify", status_code=200)
async def netcash_notify(request: Request) -> dict:
    """Netcash server-to-server postback. Responds 200 immediately then provisions voucher."""
    form_data = await request.form()
    data = dict(form_data)

    LOGGER.info("Netcash postback received: %s", data)

    # Netcash sends TransactionAccepted as "true"/"false" — check both casing variants
    transaction_accepted = data.get("TransactionAccepted", data.get("transactionaccepted", "")).lower()
    reference = data.get("p2", data.get("Reference", ""))
    netcash_order_id = data.get("NetcashOrderId", data.get("OrderId", ""))
    LOGGER.info("Netcash postback: ref=%s accepted=%s order_id=%s", reference, transaction_accepted, netcash_order_id)

    if transaction_accepted != "true":
        LOGGER.info("Netcash payment not accepted for ref=%s status=%s", reference, transaction_accepted)
        order = fetch_one(
            "SELECT id, status FROM orders WHERE m_payment_id = ? AND payment_method = 'netcash'",
            (reference,),
        )
        if order and order["status"] == "pending":
            execute(
                "UPDATE orders SET status = 'failed', netcash_order_id = ?, updated_at = ? WHERE m_payment_id = ?",
                (netcash_order_id, utc_now(), reference),
            )
        return {"ok": True}

    order = fetch_one(
        "SELECT id, plan_id, status FROM orders WHERE m_payment_id = ? AND payment_method = 'netcash'",
        (reference,),
    )
    if not order:
        LOGGER.warning("Netcash postback for unknown reference: %s", reference)
        return {"ok": True}

    if order["status"] != "pending":
        LOGGER.info("Netcash postback for already-processed order %s (status=%s)", reference, order["status"])
        return {"ok": True}

    plan = fetch_one(
        "SELECT id, name, profile, active FROM plans WHERE id = ?",
        (order["plan_id"],),
    )
    voucher_id: Optional[int] = None
    voucher_code: str = ""
    if plan and plan["active"]:
        try:
            voucher = persist_voucher(
                hotspot_user_profile=str(plan["profile"]),
                code_length=8,
            )
            voucher_id = int(voucher["id"])
            voucher_code = str(voucher["code"])
            LOGGER.info("Voucher %s created for Netcash order %s", voucher_code, reference)
            try:
                sync_voucher_to_mikrotik(voucher)
            except Exception as sync_exc:
                LOGGER.warning("MikroTik sync failed for Netcash order %s (voucher still created): %s", reference, sync_exc)
        except Exception as exc:
            LOGGER.error("Failed to create voucher for Netcash order %s: %s", reference, exc)

    execute(
        """
        UPDATE orders
        SET status = 'complete', netcash_order_id = ?, voucher_id = ?, updated_at = ?
        WHERE m_payment_id = ?
        """,
        (netcash_order_id, voucher_id, utc_now(), reference),
    )

    # Send voucher via SMS
    if voucher_code and plan:
        try:
            LOGGER.info("Attempting SMS for Netcash order %s voucher %s", reference, voucher_code)
            _try_send_voucher_sms(reference, voucher_code, plan["name"])
        except Exception as sms_exc:
            LOGGER.warning("SMS send failed for Netcash order %s: %s", reference, sms_exc)

    return {"ok": True}


@app.post("/payment/initiate")
def initiate_payment(payload: PaymentInitiateRequest) -> dict:
    """Create a pending order and return redirect URL for PayFast payment form."""
    plan = fetch_one(
        "SELECT id, name, profile, price, active FROM plans WHERE id = ?",
        (payload.plan_id,),
    )
    if not plan or not plan["active"]:
        raise HTTPException(status_code=404, detail="Plan not found or inactive.")

    price = float(plan["price"] or 0)
    if price <= 0:
        raise HTTPException(
            status_code=400,
            detail="This plan has no price set. Contact staff for assistance.",
        )

    pf = get_payfast_config()
    merchant_id = pf.get("payfast_merchant_id", "")
    merchant_key = pf.get("payfast_merchant_key", "")
    passphrase = pf.get("payfast_passphrase", "")
    server_url = pf.get("payfast_server_url", "").rstrip("/")
    sandbox = _is_sandbox(pf.get("payfast_sandbox", "true"))

    if not merchant_id or not merchant_key:
        raise HTTPException(
            status_code=503,
            detail="Payment is not configured yet. Please contact staff.",
        )
    if not server_url:
        raise HTTPException(
            status_code=503,
            detail="Server URL is not configured for payments. Contact staff.",
        )

    m_payment_id = _generate_payment_id()
    created_at = utc_now()

    execute(
        """
        INSERT INTO orders
            (m_payment_id, plan_id, buyer_name_first, buyer_name_last,
             buyer_phone, amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        """,
        (
            m_payment_id,
            plan["id"],
            payload.name_first,
            payload.name_last,
            payload.cell_number,
            price,
            created_at,
            created_at,
        ),
    )

    # Prepare PayFast form fields for client-side submission with target="_blank"
    # This allows form submission to escape captive portal webview restrictions
    plan_name = plan["name"]

    params = {
        "merchant_id": merchant_id,
        "merchant_key": merchant_key,
        "return_url": f"{server_url}/portal?status=success&m_payment_id={m_payment_id}",
        "cancel_url": f"{server_url}/portal?status=cancel",
        "notify_url": f"{server_url}/payment/notify",
        "name_first": payload.name_first,
        "name_last": payload.name_last,
        "cell_number": payload.cell_number or "",
        "m_payment_id": m_payment_id,
        "amount": f"{price:.2f}",
        "item_name": f"Wonke Connect WiFi — {plan_name}",
        "payment_method": "eft",
    }
    params["signature"] = build_signature(params, passphrase)
    payfast_url = get_payfast_url(sandbox)
    return {
        "redirect_url": f"{server_url}/payment/redirect/{m_payment_id}",
        "m_payment_id": m_payment_id,
        "payfast_url": payfast_url,
        "payfast_fields": params,
    }


@app.get("/payment/redirect/{m_payment_id}")
def payment_redirect(m_payment_id: str) -> HTMLResponse:
    """Serve auto-submit form for PayFast — opened in Safari to bypass CNA."""
    import html as html_mod

    order = fetch_one(
        "SELECT plan_id, buyer_name_first, buyer_name_last, buyer_phone, amount, status "
        "FROM orders WHERE m_payment_id = ?",
        (m_payment_id,),
    )
    if not order or order["status"] != "pending":
        raise HTTPException(status_code=404, detail="Order not found or already processed.")

    plan = fetch_one("SELECT name FROM plans WHERE id = ?", (order["plan_id"],))
    plan_name = plan["name"] if plan else "WiFi"

    pf = get_payfast_config()
    merchant_id = pf.get("payfast_merchant_id", "")
    merchant_key = pf.get("payfast_merchant_key", "")
    server_url = pf.get("payfast_server_url", "").rstrip("/")
    passphrase = pf.get("payfast_passphrase", "")
    sandbox = _is_sandbox(pf.get("payfast_sandbox", "true"))

    params = {
        "merchant_id": merchant_id,
        "merchant_key": merchant_key,
        "return_url": f"{server_url}/portal?status=success&m_payment_id={m_payment_id}",
        "cancel_url": f"{server_url}/portal?status=cancel",
        "notify_url": f"{server_url}/payment/notify",
        "name_first": order["buyer_name_first"],
        "name_last": order["buyer_name_last"],
        "cell_number": order["buyer_phone"] or "",
        "m_payment_id": m_payment_id,
        "amount": f"{float(order['amount']):.2f}",
        "item_name": f"Wonke Connect WiFi \u2014 {plan_name}",
        "payment_method": "eft",
    }
    params["signature"] = build_signature(params, passphrase)
    payfast_url = get_payfast_url(sandbox)

    fields_html = "\n".join(
        f'<input type="hidden" name="{html_mod.escape(k)}" value="{html_mod.escape(v)}">'
        for k, v in params.items()
    )
    # Detect Apple CNA (Captive Network Assistant) via User-Agent.
    # CNA cannot make HTTPS connections, so we show a prompt to open Safari.
    # When the user taps "Done" in CNA, iOS opens Safari with the same URL,
    # and Safari can submit the HTTPS form successfully.
    page = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Complete Payment</title>
<style>
*{{box-sizing:border-box}}
body{{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#f5f5f5;color:#333}}
.cna-notice{{display:none;text-align:center;padding:32px 16px}}
.cna-notice h2{{font-size:1.3rem;margin:0 0 12px}}
.cna-notice p{{font-size:1rem;line-height:1.5;color:#555;margin:8px 0}}
.cna-notice .arrow{{font-size:2rem;margin:16px 0}}
.cna-notice .highlight{{background:#007aff;color:#fff;padding:4px 12px;border-radius:6px;font-weight:600}}
.loading{{text-align:center;padding:48px 16px}}
.loading p{{font-size:1.1rem}}
</style>
</head><body>
<div class="loading" id="loading">
<p>Redirecting to PayFast&hellip;</p>
</div>
<div class="cna-notice" id="cna-notice">
<h2>One more step</h2>
<div class="arrow">&uarr;</div>
<p>Tap <span class="highlight">Done</span> in the top-right corner to open Safari.</p>
<p>Your payment will continue automatically.</p>
</div>
<form id="pf" method="POST" action="{html_mod.escape(payfast_url)}" style="display:none">
{fields_html}
</form>
<script>
(function(){{
  var isCNA = /CaptiveNetworkSupport|wispr/i.test(navigator.userAgent);
  if (isCNA) {{
    document.getElementById('loading').style.display='none';
    document.getElementById('cna-notice').style.display='block';
  }} else {{
    document.getElementById('pf').submit();
  }}
}})();
</script>
</body></html>"""
    return HTMLResponse(content=page)


@app.post("/payment/notify", status_code=200)
async def payment_notify(request: Request) -> dict:
    """PayFast ITN webhook. Always responds 200 immediately (PayFast requirement)."""
    form_data = await request.form()
    data = dict(form_data)

    pf = get_payfast_config()
    passphrase = pf.get("payfast_passphrase", "")
    sandbox = _is_sandbox(pf.get("payfast_sandbox", "true"))

    LOGGER.info("PayFast ITN received for m_payment_id=%s status=%s data=%s",
                data.get("m_payment_id"), data.get("payment_status"), data)

    valid, reason = validate_itn(data, passphrase, sandbox)
    if not valid:
        LOGGER.warning("PayFast ITN validation failed: %s — proceeding anyway in sandbox mode", reason)
        if sandbox:
            return {"ok": True}  # Only skip validation in sandbox mode; in live mode reject.

    m_payment_id = data.get("m_payment_id", "")
    payment_status = data.get("payment_status", "")
    pf_payment_id = data.get("pf_payment_id", "")

    order = fetch_one(
        "SELECT id, plan_id, status FROM orders WHERE m_payment_id = ?",
        (m_payment_id,),
    )
    if not order:
        LOGGER.warning("PayFast ITN for unknown m_payment_id: %s", m_payment_id)
        return {"ok": True}

    if payment_status == "COMPLETE" and order["status"] == "pending":
        # Generate voucher.
        plan = fetch_one(
            "SELECT id, name, profile, active FROM plans WHERE id = ?",
            (order["plan_id"],),
        )
        voucher_id: Optional[int] = None
        if plan and plan["active"]:
            try:
                voucher = persist_voucher(
                    hotspot_user_profile=str(plan["profile"]),
                    code_length=8,
                )
                voucher_id = int(voucher["id"])
                LOGGER.info("Voucher %s created for order %s", voucher["code"], m_payment_id)
                try:
                    sync_voucher_to_mikrotik(voucher)
                except Exception as sync_exc:
                    LOGGER.warning("MikroTik sync failed for order %s (voucher still created): %s", m_payment_id, sync_exc)
            except Exception as exc:  # noqa: BLE001
                LOGGER.error("Failed to create voucher for order %s: %s", m_payment_id, exc)

        now = utc_now()
        execute(
            """
            UPDATE orders
            SET status = 'complete', pf_payment_id = ?, voucher_id = ?, updated_at = ?
            WHERE m_payment_id = ?
            """,
            (pf_payment_id, voucher_id, now, m_payment_id),
        )

        # Send voucher via SMS
        if voucher_id and plan:
            try:
                _try_send_voucher_sms(m_payment_id, voucher["code"], plan["name"])
            except Exception as sms_exc:
                LOGGER.warning("SMS send failed for order %s: %s", m_payment_id, sms_exc)

    elif payment_status in ("FAILED", "CANCELLED"):
        new_status = "failed" if payment_status == "FAILED" else "cancelled"
        execute(
            "UPDATE orders SET status = ?, pf_payment_id = ?, updated_at = ? WHERE m_payment_id = ?",
            (new_status, pf_payment_id, utc_now(), m_payment_id),
        )

    return {"ok": True}


@app.post("/api/debug/reset-sync")
def debug_reset_sync() -> dict:
    """Reset all vouchers to unsynced so MikroTik will re-pull them."""
    execute("UPDATE vouchers SET mikrotik_synced = 0 WHERE status = 'unused'")
    return {"ok": True}


@app.get("/api/debug/sms-test")
def sms_test(to: str = Query(..., description="Phone number to send test SMS to")) -> dict:
    """Fire a test SMS to verify BulkSMS credentials and phone normalisation."""
    import re, httpx as _httpx
    cfg = get_bulksms_config()
    token_id = cfg.get("bulksms_token_id", "")
    token_secret = cfg.get("bulksms_token_secret", "")
    if not token_id:
        return {"ok": False, "error": "BULKSMS_TOKEN (or BULKSMS_TOKEN_ID) not set in env vars"}

    # Normalise phone number same way as bulksms.py
    digits = re.sub(r"\D", "", to)
    if digits.startswith("0") and len(digits) == 10:
        digits = "27" + digits[1:]
    phone = ("+" if not digits.startswith("+") else "") + digits

    payload = {"to": phone, "body": "Wonke Connect test SMS. If you received this, BulkSMS is working!"}
    if token_secret:
        auth = (token_id, token_secret)
        headers = {}
    else:
        headers = {"Authorization": f"Basic {token_id}"}
        auth = None

    try:
        resp = _httpx.post("https://api.bulksms.com/v1/messages", json=payload, auth=auth, headers=headers, timeout=15)
        return {
            "ok": resp.status_code in (200, 201),
            "status_code": resp.status_code,
            "response_body": resp.text[:1000],
            "phone_normalised": phone,
            "token_id_prefix": token_id[:8] + "...",
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@app.get("/api/debug/orders")
def debug_orders() -> list:
    """List recent orders for debugging (last 20)."""
    rows = fetch_all(
        """
        SELECT o.m_payment_id, o.status, o.amount, o.created_at,
               p.name AS plan_name,
               v.code AS voucher_code, v.mikrotik_synced
        FROM orders o
        JOIN plans p ON p.id = o.plan_id
        LEFT JOIN vouchers v ON v.id = o.voucher_id
        ORDER BY o.id DESC LIMIT 20
        """
    )
    return [dict(r) for r in rows]


@app.get("/payment/order/{m_payment_id}", response_model=OrderStatusResponse)
def get_order_status(m_payment_id: str) -> OrderStatusResponse:
    """Poll order status after returning from PayFast."""
    row = fetch_one(
        """
        SELECT o.m_payment_id, o.status, o.amount,
               p.name AS plan_name,
               v.code  AS voucher_code
        FROM orders o
        JOIN plans p ON p.id = o.plan_id
        LEFT JOIN vouchers v ON v.id = o.voucher_id
        WHERE o.m_payment_id = ?
        """,
        (m_payment_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Order not found.")
    return OrderStatusResponse(
        m_payment_id=str(row["m_payment_id"]),
        status=str(row["status"]),
        amount=float(row["amount"]),
        plan_name=str(row["plan_name"]),
        voucher_code=row["voucher_code"],
    )


# ── MikroTik pull-sync endpoints ──────────────────────────────────────────────

@app.get("/api/mikrotik/pull-vouchers")
def pull_vouchers_for_mikrotik(api_key: str = Query(...)) -> dict:
    """MikroTik polls this every 15 s to get unsynced vouchers.

    Returns a pipe-delimited plain-text body one voucher per line:
        id|code|password|profile
    Easy to parse with RouterOS string operations.
    """
    saved_key = get_payfast_config().get("mikrotik_sync_api_key", "")
    if not saved_key or not secrets.compare_digest(api_key, saved_key):
        raise HTTPException(status_code=403, detail="Invalid API key.")

    rows = fetch_all(
        """
        SELECT id, code, password, profile
        FROM vouchers
        WHERE status = 'unused' AND mikrotik_synced = 0
        ORDER BY id
        LIMIT 50
        """,
    )
    lines = [f"{r['id']}|{r['code']}|{r['password']}|{r['profile']}" for r in rows]
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse("\n".join(lines))


@app.post("/api/mikrotik/confirm-sync")
def confirm_mikrotik_sync(api_key: str = Query(...), ids: str = Query(...)) -> dict:
    """MikroTik calls this after creating hotspot users to mark vouchers as synced.

    ids: comma-separated voucher IDs e.g. '42,43,44'
    """
    saved_key = get_payfast_config().get("mikrotik_sync_api_key", "")
    if not saved_key or not secrets.compare_digest(api_key, saved_key):
        raise HTTPException(status_code=403, detail="Invalid API key.")

    try:
        id_list = [int(i.strip()) for i in ids.split(",") if i.strip().isdigit()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid ids format.")

    if id_list:
        placeholders = ",".join("?" * len(id_list))
        execute(
            f"UPDATE vouchers SET mikrotik_synced = 1 WHERE id IN ({placeholders})",
            tuple(id_list),
        )
        LOGGER.info("MikroTik confirmed sync for voucher IDs: %s", id_list)

    return {"ok": True, "synced": len(id_list)}


if __name__ == "__main__":
    import os
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )


@app.get("/health")
def healthcheck() -> dict[str, str]:
    try:
        # Quick DB connectivity check
        with get_connection() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "timestamp": utc_now()}
    except Exception as exc:
        LOGGER.error("Health check failed: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/settings/mikrotik", response_model=MikroTikSettingsResponse)
def get_mikrotik_settings() -> MikroTikSettingsResponse:
    settings = get_settings(
        [
            "mikrotik_host",
            "mikrotik_username",
            "mikrotik_password",
            "mikrotik_port",
            "mikrotik_use_ssl",
            "mikrotik_plaintext_login",
        ]
    )
    return MikroTikSettingsResponse(
        host=settings.get("mikrotik_host", ""),
        username=settings.get("mikrotik_username", ""),
        password=settings.get("mikrotik_password", ""),
        port=int(settings.get("mikrotik_port", "8728") or 8728),
        use_ssl=settings.get("mikrotik_use_ssl", "false").lower() == "true",
        plaintext_login=settings.get("mikrotik_plaintext_login", "true").lower() == "true",
    )


@app.post("/settings/mikrotik", response_model=MikroTikSettingsResponse)
def save_mikrotik_settings(payload: MikroTikSettingsRequest) -> MikroTikSettingsResponse:
    set_settings(
        {
            "mikrotik_host": payload.host,
            "mikrotik_username": payload.username,
            "mikrotik_password": payload.password,
            "mikrotik_port": str(payload.port),
            "mikrotik_use_ssl": str(payload.use_ssl).lower(),
            "mikrotik_plaintext_login": str(payload.plaintext_login).lower(),
        }
    )
    return MikroTikSettingsResponse(
        host=payload.host,
        username=payload.username,
        password=payload.password,
        port=payload.port,
        use_ssl=payload.use_ssl,
        plaintext_login=payload.plaintext_login,
    )


@app.post("/settings/mikrotik/test", response_model=MikroTikConnectionStatusResponse)
def test_mikrotik_connection() -> MikroTikConnectionStatusResponse:
    try:
        test_connection()
        return MikroTikConnectionStatusResponse(connected=True, message="Connected to MikroTik successfully.")
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        return MikroTikConnectionStatusResponse(connected=False, message=str(exc))


@app.get("/hotspot/available-profiles")
def get_available_profiles() -> dict[str, Any]:
    """Fetch available HotSpot profiles from the MikroTik router."""
    try:
        profiles = get_available_hotspot_profiles()
        return {
            "available": True,
            "profiles": profiles,
            "message": f"Found {len(profiles)} profile(s) on MikroTik router.",
        }
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        return {
            "available": False,
            "profiles": [],
            "message": f"Could not fetch profiles: {str(exc)}",
        }


@app.get("/settings/vouchers")
def get_voucher_settings() -> dict[str, Union[str, int]]:
    """Get voucher expiration settings."""
    settings = get_settings(["voucher_expiration_days"])
    expiration_days = int(settings.get("voucher_expiration_days", "30") or "30")
    return {"voucher_expiration_days": expiration_days}


@app.post("/settings/vouchers")
def set_voucher_settings(payload: dict[str, int]) -> dict[str, Union[str, int]]:
    """Update voucher expiration settings."""
    expiration_days = payload.get("voucher_expiration_days", 30)
    if not isinstance(expiration_days, int) or expiration_days < 1 or expiration_days > 3650:
        raise HTTPException(status_code=400, detail="Expiration days must be between 1 and 3650.")
    
    set_settings({"voucher_expiration_days": str(expiration_days)})
    return {"message": "Voucher settings updated.", "voucher_expiration_days": expiration_days}


@app.post("/hotspot/profiles")
def create_hotspot_profile(payload: HotSpotProfileRequest) -> dict[str, str]:
    """Create or update a HotSpot user profile with advanced settings."""
    try:
        configure_hotspot_profile(
            profile_name=payload.profile_name,
            rate_limit=payload.rate_limit,
            session_timeout=payload.session_timeout,
            idle_timeout=payload.idle_timeout,
            keepalive_timeout=payload.keepalive_timeout,
            login_by=payload.login_by,
        )
        return {
            "message": f"HotSpot profile '{payload.profile_name}' configured successfully.",
            "profile_name": payload.profile_name,
        }
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/hotspot/walled-garden")
def add_walled_garden_rule(payload: WalledGardenRequest) -> dict[str, str]:
    """Add a walled garden rule to allow certain sites without authentication."""
    try:
        add_walled_garden(
            dst_host=payload.dst_host,
            action=payload.action,
            path=payload.path,
            method=payload.method,
        )
        return {
            "message": f"Walled garden rule for '{payload.dst_host}' added successfully.",
            "dst_host": payload.dst_host,
            "action": payload.action,
        }
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/hotspot/walled-garden/netcash")
def setup_netcash_walled_garden_rules() -> dict[str, Any]:
    """Add all Netcash/PayNow domains to the MikroTik walled garden."""
    try:
        added = setup_netcash_walled_garden()
        return {
            "message": "Netcash walled garden rules applied successfully.",
            "hosts": added,
        }
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/hotspot/walled-garden/payfast")
def setup_payfast_walled_garden_rules() -> dict[str, Any]:
    """Add all PayFast domains to the MikroTik walled garden."""
    try:
        added = setup_payfast_walled_garden()
        return {
            "message": "PayFast walled garden rules applied successfully.",
            "hosts": added,
        }
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/hotspot/ip-binding")
def create_ip_binding(payload: IPBindingRequest) -> dict[str, str]:
    """Create an IP binding for static NAT, bypass, or blocking."""
    try:
        add_ip_binding(
            src_address=payload.src_address,
            mac_address=payload.mac_address,
            to_address=payload.to_address,
            binding_type=payload.binding_type,
        )
        return {
            "message": f"IP binding for {payload.src_address} ({payload.binding_type}) created successfully.",
            "src_address": payload.src_address,
            "binding_type": payload.binding_type,
        }
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/vouchers/{voucher_id}/statistics")
def get_voucher_statistics(voucher_id: int) -> UserStatisticsResponse:
    """Fetch bandwidth and session statistics for a specific voucher."""
    voucher = fetch_one("SELECT code FROM vouchers WHERE id = ?", (voucher_id,))
    if not voucher:
        raise HTTPException(status_code=404, detail="Voucher not found.")
    
    try:
        stats = get_user_statistics(code=voucher["code"])
        if not stats:
            return UserStatisticsResponse(code=voucher["code"])
        
        return UserStatisticsResponse(
            code=voucher["code"],
            bytes_in=int(stats.get("bytes-in", 0) or 0),
            bytes_out=int(stats.get("bytes-out", 0) or 0),
            bytes_total=int(stats.get("bytes-in", 0) or 0) + int(stats.get("bytes-out", 0) or 0),
            uptime=str(stats.get("uptime", "")),
            current_limit_bytes_total=int(stats.get("limit-bytes-total", 0) or 0),
        )
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/plans", response_model=list[PlanResponse])
def list_plans(active_only: bool = Query(default=False)) -> list[PlanResponse]:
    query = """
        SELECT id,
               name,
               profile AS hotspot_user_profile,
               duration_label,
               badge_label,
               note,
               price,
               active,
               created_at
        FROM plans
    """
    if active_only:
        query += " WHERE active = 1"
    query += " ORDER BY active DESC, id ASC"
    rows = fetch_all(query)
    return [serialize_plan(row) for row in rows]


@app.post("/plans", response_model=PlanSaveResult)
def create_plan(payload: PlanCreateRequest) -> PlanSaveResult:
    try:
        plan_id = execute(
            """
            INSERT INTO plans (name, profile, duration_label, badge_label, note, price, active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.name,
                payload.hotspot_user_profile,
                payload.duration_label,
                payload.badge_label,
                payload.note,
                payload.price,
                1 if payload.active else 0,
            ),
        )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A plan with that HotSpot user profile already exists.") from exc

    row = fetch_one(
        """
        SELECT id, name, profile AS hotspot_user_profile,
               duration_label, badge_label, note, price, active, created_at
        FROM plans WHERE id = ?
        """,
        (plan_id,),
    )
    plan = serialize_plan(row)
    synced, message = sync_plan_to_mikrotik(plan.hotspot_user_profile)
    return PlanSaveResult(plan=plan, mikrotik_synced=synced, mikrotik_message=message)


@app.put("/plans/{plan_id}", response_model=PlanSaveResult)
def update_plan(plan_id: int, payload: PlanUpdateRequest) -> PlanSaveResult:
    ensure_plan_exists(plan_id)
    try:
        with get_connection() as connection:
            connection.execute(
                """
                UPDATE plans
                SET name = ?, profile = ?, duration_label = ?, badge_label = ?,
                    note = ?, price = ?, active = ?
                WHERE id = ?
                """,
                (
                    payload.name,
                    payload.hotspot_user_profile,
                    payload.duration_label,
                    payload.badge_label,
                    payload.note,
                    payload.price,
                    1 if payload.active else 0,
                    plan_id,
                ),
            )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A plan with that HotSpot user profile already exists.") from exc

    row = fetch_one(
        """
        SELECT id, name, profile AS hotspot_user_profile,
               duration_label, badge_label, note, price, active, created_at
        FROM plans WHERE id = ?
        """,
        (plan_id,),
    )
    plan = serialize_plan(row)
    synced, message = sync_plan_to_mikrotik(plan.hotspot_user_profile)
    return PlanSaveResult(plan=plan, mikrotik_synced=synced, mikrotik_message=message)


@app.delete("/plans/{plan_id}")
def delete_plan(plan_id: int) -> dict[str, str]:
    ensure_plan_exists(plan_id)
    with get_connection() as connection:
        in_use = connection.execute(
            "SELECT COUNT(*) AS count FROM vouchers WHERE profile = (SELECT profile FROM plans WHERE id = ?)",
            (plan_id,),
        ).fetchone()
        if in_use and int(in_use["count"] or 0) > 0:
            connection.execute("UPDATE plans SET active = 0 WHERE id = ?", (plan_id,))
            return {"message": "Plan is used by existing vouchers, so it was deactivated instead of deleted."}
        connection.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    return {"message": "Plan deleted."}


@app.post("/create-voucher", response_model=VoucherCreateResult)
def create_voucher_endpoint(payload: CreateVoucherRequest) -> VoucherCreateResult:
    voucher = persist_voucher(hotspot_user_profile=payload.hotspot_user_profile, code_length=payload.code_length)
    synced, message = sync_voucher_to_mikrotik(voucher)
    return VoucherCreateResult(voucher=VoucherResponse(**voucher), mikrotik_synced=synced, mikrotik_message=message)


@app.post("/create-voucher-with-limits", response_model=VoucherCreateResult)
def create_voucher_with_limits_endpoint(payload: VoucherWithLimitsRequest) -> VoucherCreateResult:
    """Create a voucher with bandwidth and session limits."""
    voucher = persist_voucher_with_limits(
        hotspot_user_profile=payload.hotspot_user_profile,
        code_length=payload.code_length,
        rate_limit=payload.rate_limit,
        session_timeout=payload.session_timeout,
        idle_timeout=payload.idle_timeout,
        limit_bytes_total=payload.limit_bytes_total,
        limit_uptime=payload.limit_uptime,
    )
    synced, message = sync_voucher_to_mikrotik_with_limits(voucher)
    return VoucherCreateResult(voucher=VoucherResponse(**voucher), mikrotik_synced=synced, mikrotik_message=message)


@app.post("/bulk-create", response_model=BulkCreateResult)
def bulk_create_endpoint(payload: BulkCreateRequest) -> BulkCreateResult:
    vouchers = [
        persist_voucher(hotspot_user_profile=payload.hotspot_user_profile, code_length=payload.code_length)
        for _ in range(payload.quantity)
    ]

    synced_count = 0
    mikrotik_errors: list[str] = []
    for voucher in vouchers:
        synced, message = sync_voucher_to_mikrotik(voucher)
        if synced:
            synced_count += 1
        elif message:
            mikrotik_errors.append(f"{voucher['code']}: {message}")

    return BulkCreateResult(
        vouchers=[VoucherResponse(**voucher) for voucher in vouchers],
        synced_count=synced_count,
        failed_sync_count=len(vouchers) - synced_count,
        mikrotik_errors=mikrotik_errors,
    )


@app.get("/vouchers", response_model=list[VoucherResponse])
def list_vouchers(
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> list[VoucherResponse]:
    apply_auto_expire_deactivate()
    rows = fetch_all(
        """
        SELECT v.id,
               v.code,
               v.password,
               v.profile AS hotspot_user_profile,
               v.status,
               v.created_at,
               v.expires_at,
               v.deactivated_at,
               COALESCE(p.name, v.profile) AS plan_name,
               COALESCE(p.duration_label, v.profile) AS duration_label,
               COALESCE(p.badge_label, v.profile) AS badge_label,
               COALESCE(p.note, 'Valid for Wonke Connect hotspot access.') AS note
        FROM vouchers v
        LEFT JOIN plans p ON p.profile = v.profile
        ORDER BY datetime(v.created_at) DESC, v.id DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    )
    return [VoucherResponse(**row) for row in rows]


@app.delete("/vouchers/{voucher_id}")
def delete_voucher(voucher_id: int) -> dict[str, str]:
    """Delete a specific voucher by ID and disable it in MikroTik."""
    voucher = fetch_one("SELECT id, code FROM vouchers WHERE id = ?", (voucher_id,))
    if not voucher:
        raise HTTPException(status_code=404, detail="Voucher not found.")
    
    # Disable user in MikroTik
    try:
        disable_hotspot_user(code=voucher["code"])
    except (MikroTikConfigError, MikroTikConnectionError):
        # Log error but continue with deletion
        LOGGER.warning(f"Failed to disable user {voucher['code']} in MikroTik, proceeding with deletion")
    
    execute("DELETE FROM vouchers WHERE id = ?", (voucher_id,))
    return {"message": f"Voucher {voucher_id} deleted successfully."}


@app.post("/vouchers/{voucher_id}/revoke")
def revoke_voucher(voucher_id: int) -> dict[str, str]:
    """Revoke/disable a voucher without deleting it."""
    voucher = fetch_one(
        "SELECT id, code, status FROM vouchers WHERE id = ?",
        (voucher_id,)
    )
    if not voucher:
        raise HTTPException(status_code=404, detail="Voucher not found.")
    
    if voucher["status"] == "deactivated":
        return {"message": "Voucher is already deactivated."}
    
    # Disable user in MikroTik
    try:
        disable_hotspot_user(code=voucher["code"])
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=f"Failed to revoke in MikroTik: {str(exc)}") from exc
    
    # Mark as deactivated in database
    deactivated_at = utc_now()
    execute(
        "UPDATE vouchers SET status = 'deactivated', deactivated_at = ? WHERE id = ?",
        (deactivated_at, voucher_id)
    )
    return {"message": f"Voucher {voucher_id} revoked successfully."}


@app.post("/vouchers/delete-bulk")
def delete_bulk_vouchers(voucher_ids: list[int]) -> dict[str, Union[str, int]]:
    """Delete multiple vouchers by their IDs."""
    if not voucher_ids:
        raise HTTPException(status_code=400, detail="No voucher IDs provided.")
    
    placeholders = ",".join("?" for _ in voucher_ids)
    vouchers = fetch_all(f"SELECT code FROM vouchers WHERE id IN ({placeholders})", tuple(voucher_ids))
    
    # Disable users in MikroTik
    for voucher in vouchers:
        try:
            disable_hotspot_user(code=voucher["code"])
        except (MikroTikConfigError, MikroTikConnectionError):
            LOGGER.warning(f"Failed to disable user {voucher['code']} in MikroTik")
    
    with get_connection() as connection:
        cursor = connection.execute(
            f"DELETE FROM vouchers WHERE id IN ({placeholders})",
            tuple(voucher_ids),
        )
        deleted_count = cursor.rowcount
    
    return {"message": f"{deleted_count} voucher(s) deleted successfully.", "deleted_count": deleted_count}


@app.get("/stats", response_model=StatsResponse)
def stats() -> StatsResponse:
    apply_auto_expire_deactivate()
    row = fetch_one(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status IN ('used', 'deactivated') THEN 1 ELSE 0 END) AS used,
               SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused
        FROM vouchers
        """
    ) or {"total": 0, "used": 0, "unused": 0}
    return StatsResponse(
        total=int(row["total"] or 0),
        used=int(row["used"] or 0),
        unused=int(row["unused"] or 0),
    )


@app.post("/sync-status", response_model=SyncStatusResponse)
def sync_status() -> SyncStatusResponse:
    apply_auto_expire_deactivate()
    try:
        hotspot_users, active_users = get_hotspot_usage()
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    active_names = {
        (entry.get("user") or entry.get("name") or "").strip()
        for entry in active_users
        if (entry.get("user") or entry.get("name"))
    }
    used_codes = {
        user.get("name", "").strip()
        for user in hotspot_users
        if user.get("name") and (has_usage(user) or user.get("name", "").strip() in active_names)
    }
    used_codes.update(active_names)

    if not used_codes:
        return SyncStatusResponse(updated=0, active_users=len(active_names), message="No used vouchers detected on MikroTik.")

    placeholders = ",".join("?" for _ in used_codes)
    deactivated_at = utc_now()
    with get_connection() as connection:
        cursor = connection.execute(
            f"UPDATE vouchers SET status = 'deactivated', deactivated_at = ? WHERE code IN ({placeholders}) AND status NOT IN ('deactivated', 'expired')",
            (deactivated_at, *tuple(sorted(used_codes))),
        )
        updated = cursor.rowcount

    return SyncStatusResponse(
        updated=updated,
        active_users=len(active_names),
        message="Voucher statuses refreshed from MikroTik hotspot activity.",
    )


@app.get("/users/active")
def get_active_users() -> dict[str, Any]:
    """Fetch list of currently active hotspot users with their bandwidth usage."""
    try:
        hotspot_users, active_users = get_hotspot_usage()
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        raise HTTPException(status_code=503, detail=f"Failed to fetch active users: {str(exc)}") from exc
    
    # Enrich active users with voucher plan info
    enriched_users = []
    for user in active_users:
        user_code = (user.get("user") or user.get("name") or "").strip()
        if not user_code:
            continue
        
        # Fetch voucher info
        voucher = fetch_one("SELECT id, hotspot_user_profile FROM vouchers WHERE code = ?", (user_code,))
        
        bytes_in = int(user.get("bytes-in", 0) or 0)
        bytes_out = int(user.get("bytes-out", 0) or 0)
        bytes_total = bytes_in + bytes_out
        
        enriched_users.append({
            "code": user_code,
            "profile": voucher["hotspot_user_profile"] if voucher else "Unknown",
            "uptime": str(user.get("uptime", "")),
            "bytes_in": bytes_in,
            "bytes_out": bytes_out,
            "bytes_total": bytes_total,
            "mac_address": user.get("mac-address", ""),
            "address": user.get("address", ""),
            "login_time": user.get("login-time", ""),
        })
    
    return {
        "total_active": len(enriched_users),
        "users": enriched_users,
    }


def persist_voucher(*, hotspot_user_profile: str, code_length: int) -> dict[str, Union[str, int]]:
    plan = get_plan_by_hotspot_user_profile(hotspot_user_profile)
    if not plan or not bool(plan["active"]):
        raise HTTPException(status_code=404, detail="Selected HotSpot user profile plan was not found or is inactive.")

    for _ in range(20):
        code = generate_voucher_code(code_length)
        created_at = utc_now()
        expires_at = get_voucher_expiration_time(created_at)
        try:
            voucher_id = execute(
                """
                INSERT INTO vouchers (code, password, profile, status, created_at, expires_at)
                VALUES (?, ?, ?, 'unused', ?, ?)
                """,
                (code, code, hotspot_user_profile, created_at, expires_at),
            )
            return {
                "id": voucher_id,
                "code": code,
                "password": code,
                "hotspot_user_profile": hotspot_user_profile,
                "status": "unused",
                "created_at": created_at,
                "expires_at": expires_at,
                "deactivated_at": None,
                "plan_name": str(plan["name"]),
                "duration_label": str(plan["duration_label"]),
                "badge_label": str(plan["badge_label"]),
                "note": str(plan["note"]),
            }
        except sqlite3.IntegrityError:
            LOGGER.warning("Duplicate voucher code generated, retrying.")

    raise HTTPException(status_code=500, detail="Could not generate a unique voucher code after several attempts.")


def persist_voucher_with_limits(
    *,
    hotspot_user_profile: str,
    code_length: int,
    rate_limit: Optional[str] = None,
    session_timeout: Optional[str] = None,
    idle_timeout: Optional[str] = None,
    limit_bytes_total: int = 0,
    limit_uptime: Optional[str] = None,
) -> dict[str, Union[str, int, None]]:
    """Create a voucher with bandwidth and session limits."""
    plan = get_plan_by_hotspot_user_profile(hotspot_user_profile)
    if not plan or not bool(plan["active"]):
        raise HTTPException(status_code=404, detail="Selected HotSpot user profile plan was not found or is inactive.")

    for _ in range(20):
        code = generate_voucher_code(code_length)
        created_at = utc_now()
        expires_at = get_voucher_expiration_time(created_at)
        try:
            voucher_id = execute(
                """
                INSERT INTO vouchers (code, password, profile, status, created_at, expires_at, 
                                    rate_limit, session_timeout, idle_timeout, limit_bytes_total, limit_uptime)
                VALUES (?, ?, ?, 'unused', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    code,
                    code,
                    hotspot_user_profile,
                    created_at,
                    expires_at,
                    rate_limit,
                    session_timeout,
                    idle_timeout,
                    limit_bytes_total,
                    limit_uptime,
                ),
            )
            return {
                "id": voucher_id,
                "code": code,
                "password": code,
                "hotspot_user_profile": hotspot_user_profile,
                "status": "unused",
                "created_at": created_at,
                "expires_at": expires_at,
                "deactivated_at": None,
                "rate_limit": rate_limit,
                "session_timeout": session_timeout,
                "idle_timeout": idle_timeout,
                "limit_bytes_total": limit_bytes_total,
                "limit_uptime": limit_uptime,
                "plan_name": str(plan["name"]),
                "duration_label": str(plan["duration_label"]),
                "badge_label": str(plan["badge_label"]),
                "note": str(plan["note"]),
            }
        except sqlite3.IntegrityError:
            LOGGER.warning("Duplicate voucher code generated, retrying.")

    raise HTTPException(status_code=500, detail="Could not generate a unique voucher code after several attempts.")


def generate_voucher_code(length: int) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def sync_voucher_to_mikrotik(voucher: dict[str, Union[str, int]]) -> tuple[bool, Optional[str]]:
    try:
        create_hotspot_user(
            code=str(voucher["code"]),
            password=str(voucher["password"]),
            hotspot_user_profile=str(voucher["hotspot_user_profile"]),
        )
        return True, None
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        LOGGER.error("MikroTik sync failed for %s: %s", voucher["code"], exc)
        return False, str(exc)


def sync_voucher_to_mikrotik_with_limits(voucher: dict[str, Union[str, int, None]]) -> tuple[bool, Optional[str]]:
    """Sync voucher to MikroTik with bandwidth and session limits."""
    try:
        create_hotspot_user_with_limits(
            code=str(voucher["code"]),
            password=str(voucher["password"]),
            hotspot_user_profile=str(voucher["hotspot_user_profile"]),
            rate_limit=voucher.get("rate_limit"),
            session_timeout=voucher.get("session_timeout"),
            idle_timeout=voucher.get("idle_timeout"),
            limit_bytes_total=int(voucher.get("limit_bytes_total", 0) or 0),
            limit_uptime=voucher.get("limit_uptime"),
        )
        return True, None
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        LOGGER.error("MikroTik sync failed for %s: %s", voucher["code"], exc)
        return False, str(exc)


def sync_plan_to_mikrotik(hotspot_user_profile: str) -> tuple[bool, Optional[str]]:
    try:
        sync_hotspot_user_profile(hotspot_user_profile=hotspot_user_profile)
        return True, None
    except (MikroTikConfigError, MikroTikConnectionError) as exc:
        LOGGER.error("HotSpot user profile sync failed for %s: %s", hotspot_user_profile, exc)
        return False, str(exc)


def has_usage(user: dict[str, str]) -> bool:
    uptime = str(user.get("uptime", "")).strip()
    if uptime and any(char.isdigit() and char != "0" for char in uptime):
        return True

    for key in ("bytes-in", "bytes-out"):
        value = str(user.get(key, "")).strip()
        if value.isdigit() and int(value) > 0:
            return True

    return False


def get_voucher_expiration_time(created_at: str) -> str:
    """Calculate voucher expiration time based on configured duration (default 30 days)."""
    settings = get_settings(["voucher_expiration_days"])
    expiration_days = int(settings.get("voucher_expiration_days", "30") or "30")
    
    created_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    expires_dt = created_dt + timedelta(days=expiration_days)
    return expires_dt.replace(microsecond=0).isoformat()


def apply_auto_expire_deactivate() -> None:
    """Auto-mark vouchers as expired if they've passed their expiration time."""
    now = utc_now()
    deactivated_at = utc_now()
    
    with get_connection() as connection:
        # Mark expired unused vouchers as expired
        connection.execute(
            """
            UPDATE vouchers 
            SET status = 'expired', deactivated_at = ?
            WHERE status = 'unused' AND expires_at IS NOT NULL AND expires_at < ? AND status != 'expired'
            """,
            (deactivated_at, now),
        )
        
        # Mark expired used/deactivated vouchers as expired if not already
        connection.execute(
            """
            UPDATE vouchers 
            SET status = 'expired'
            WHERE status IN ('used', 'deactivated') AND expires_at IS NOT NULL AND expires_at < ? AND status != 'expired'
            """,
            (now,),
        )


def get_plan_by_hotspot_user_profile(hotspot_user_profile: str) -> Optional[dict[str, object]]:
    return fetch_one(
        """
        SELECT id, name, profile AS hotspot_user_profile,
               duration_label, badge_label, note, price, active, created_at
        FROM plans WHERE profile = ?
        """,
        (hotspot_user_profile,),
    )


def ensure_plan_exists(plan_id: int) -> None:
    row = fetch_one("SELECT id FROM plans WHERE id = ?", (plan_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Plan not found.")


def serialize_plan(row: Optional[dict[str, object]]) -> PlanResponse:
    if not row:
        raise HTTPException(status_code=404, detail="Plan not found.")
    return PlanResponse(
        id=int(row["id"]),
        name=str(row["name"]),
        hotspot_user_profile=str(row["hotspot_user_profile"]),
        duration_label=str(row["duration_label"]),
        badge_label=str(row["badge_label"]),
        note=str(row["note"]),
        price=float(row.get("price") or 0),
        active=bool(row["active"]),
        created_at=str(row["created_at"]),
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()
