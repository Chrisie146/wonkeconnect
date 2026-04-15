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
    """Send voucher code via BulkSMS.  Returns True on success.

    token_id / token_secret can be supplied in two ways:
      1. Separately:  token_id="abc", token_secret="xyz"  → Basic auth built automatically
      2. Combined:    token_id="base64string", token_secret=""
         (paste the Base64 value shown in the BulkSMS 'Basic Auth' field directly as token_id)
    """
    phone = _normalise_phone(to)

    body = f"Your Wonke Connect WiFi code is: {voucher_code}"
    if plan_name:
        body += f" ({plan_name})"
    body += ". Enter it on the WiFi login page to connect. For help WhatsApp us."

    payload = {
        "to": phone,
        "body": body,
    }

    # Build auth header — support both separate and combined (base64) token formats.
    if token_secret:
        # Standard: separate token_id and token_secret
        auth = (token_id, token_secret)
        headers = {}
    else:
        # Combined: token_id is already the Base64-encoded "tokenId:tokenSecret" string
        headers = {"Authorization": f"Basic {token_id}"}
        auth = None

    try:
        resp = httpx.post(
            BULKSMS_API_URL,
            json=payload,
            auth=auth,
            headers=headers,
            timeout=15,
        )
        LOGGER.info("BulkSMS response: status=%s body=%s", resp.status_code, resp.text[:500])
        if resp.status_code in (200, 201):
            LOGGER.info("SMS sent to %s (voucher %s)", phone, voucher_code)
            return True
        LOGGER.warning("BulkSMS returned %s: %s", resp.status_code, resp.text[:300])
        return False
    except Exception as exc:
        LOGGER.error("BulkSMS request failed: %s", exc)
        return False
