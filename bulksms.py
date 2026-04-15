"""BulkSMS integration — send voucher codes via SMS after purchase."""

import logging
import re

import httpx

LOGGER = logging.getLogger("bulksms")
BULKSMS_API_URL = "https://api.bulksms.com/v1/messages"


def _normalise_phone(phone: str) -> str:
    """Convert a South African phone number to international format (+27...)."""
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("0") and len(digits) == 10:
        digits = "27" + digits[1:]
    if not digits.startswith("+"):
        digits = "+" + digits
    return digits


def send_voucher_sms(
    *,
    token_id: str,
    token_secret: str,
    to: str,
    voucher_code: str,
    plan_name: str = "",
) -> bool:
    """Send voucher code via BulkSMS.  Returns True on success."""
    phone = _normalise_phone(to)

    body = f"Your Wonke Connect WiFi code is: {voucher_code}"
    if plan_name:
        body += f" ({plan_name})"
    body += ". Enter it on the login page to connect. Need help? WhatsApp 081 869 4929"

    payload = {
        "to": phone,
        "body": body,
    }

    try:
        resp = httpx.post(
            BULKSMS_API_URL,
            json=payload,
            auth=(token_id, token_secret),
            timeout=15,
        )
        if resp.status_code in (200, 201):
            LOGGER.info("SMS sent to %s (voucher %s)", phone, voucher_code)
            return True
        LOGGER.warning("BulkSMS returned %s: %s", resp.status_code, resp.text[:300])
        return False
    except Exception as exc:
        LOGGER.error("BulkSMS request failed: %s", exc)
        return False
