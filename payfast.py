"""PayFast payment utility for Wonke Connect.

Handles signature generation, ITN validation, and onsite payment identifiers
for secure payments via PayFast.

Key rules (from PayFast docs):
- Payment initiation signature: PayFast documented field order (NOT alphabetical).
- ITN validation signature: alphabetical field order.
- Spaces → '+' (not %20).
- Passphrase appended last: &passphrase=VALUE.
- Always respond 200 to ITN immediately, then validate asynchronously.
- Onsite payments: Requires live mode (testMode=false), no sandbox support.
"""

from __future__ import annotations

import hashlib
import json
import logging
import urllib.error
import urllib.parse
import urllib.request

LOGGER = logging.getLogger("wonke-connect.payfast")

# Documented PayFast field order for payment initiation signature.
PAYFAST_FIELD_ORDER = [
    "merchant_id",
    "merchant_key",
    "return_url",
    "cancel_url",
    "notify_url",
    "name_first",
    "name_last",
    "email_address",
    "cell_number",
    "m_payment_id",
    "amount",
    "item_name",
    "item_description",
    "custom_int1",
    "custom_int2",
    "custom_int3",
    "custom_int4",
    "custom_int5",
    "custom_str1",
    "custom_str2",
    "custom_str3",
    "custom_str4",
    "custom_str5",
    "email_confirmation",
    "confirmation_address",
    "payment_method",
    "subscription_type",
    "billing_date",
    "recurring_amount",
    "frequency",
    "cycles",
]


def get_payfast_url(sandbox: bool) -> str:
    if sandbox:
        return "https://sandbox.payfast.co.za/eng/process"
    return "https://www.payfast.co.za/eng/process"


def get_validate_host(sandbox: bool) -> str:
    return "sandbox.payfast.co.za" if sandbox else "www.payfast.co.za"


def build_signature(
    params: dict,
    passphrase: str = "",
    alphabetical: bool = False,
) -> str:
    """Build an MD5 signature for a PayFast request.

    Args:
        params: Dict of PayFast parameters (excluding 'signature').
        passphrase: Merchant passphrase (leave empty string if not set).
        alphabetical: If True, sort fields alphabetically (required for ITN
                      validation). If False, use PayFast documented field order
                      (required for payment initiation).

    Returns:
        Lowercase hex MD5 digest.
    """
    valid_keys = [
        k for k in params if k != "signature" and params[k] not in ("", None)
    ]

    if alphabetical:
        ordered_keys = sorted(valid_keys)
    else:
        known = [k for k in PAYFAST_FIELD_ORDER if k in valid_keys]
        unknown = sorted(k for k in valid_keys if k not in PAYFAST_FIELD_ORDER)
        ordered_keys = known + unknown

    parts = [
        f"{k}={urllib.parse.quote(str(params[k]).strip(), safe='').replace('%20', '+')}"
        for k in ordered_keys
    ]
    sig_str = "&".join(parts)

    if passphrase:
        sig_str += (
            f"&passphrase="
            f"{urllib.parse.quote(passphrase.strip(), safe='').replace('%20', '+')}"
        )

    return hashlib.md5(sig_str.encode()).hexdigest()


def validate_itn(data: dict, passphrase: str, sandbox: bool) -> tuple[bool, str]:
    """Validate an Instant Transaction Notification (ITN) from PayFast.

    Two-step process required by PayFast:
    1. Verify MD5 signature using alphabetical field order.
    2. POST data back to PayFast /eng/query/validate and check for 'VALID'.

    Args:
        data: All fields from the ITN POST body as a dict.
        passphrase: Merchant passphrase (empty string if not set).
        sandbox: True when testing with PayFast sandbox.

    Returns:
        (is_valid, reason) tuple.
    """
    # Step 1 — signature check.
    received_sig = data.get("signature", "")
    check_data = {k: v for k, v in data.items() if k != "signature"}
    expected_sig = build_signature(check_data, passphrase, alphabetical=True)

    if expected_sig != received_sig:
        LOGGER.warning(
            "PayFast ITN signature mismatch. Expected: %s, got: %s",
            expected_sig[:8],
            received_sig[:8],
        )
        return False, "Signature mismatch"

    # Step 2 — server-side confirmation with PayFast.
    host = get_validate_host(sandbox)
    post_body = urllib.parse.urlencode(data).encode()

    try:
        req = urllib.request.Request(
            f"https://{host}/eng/query/validate",
            data=post_body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read().decode().strip()

        if body == "VALID":
            return True, "ok"

        LOGGER.warning("PayFast ITN validation returned: %s", body)
        return False, f"PayFast returned: {body}"

    except urllib.error.URLError as exc:
        LOGGER.error("PayFast ITN validation request failed: %s", exc)
        return False, f"Validation request failed: {exc}"
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("Unexpected error during ITN validation: %s", exc)
        return False, f"Unexpected error: {exc}"


def get_onsite_payment_identifier(
    merchant_id: str,
    merchant_key: str,
    passphrase: str,
    sandbox: bool,
    m_payment_id: str,
    amount: str,
    item_name: str,
    return_url: str = "",
    cancel_url: str = "",
    notify_url: str = "",
    name_first: str = "",
    name_last: str = "",
    email_address: str = "",
) -> tuple[str | None, str]:
    """Generate a PayFast onsite payment identifier (UUID).

    Onsite payments embed the payment form directly in your page with no
    redirects. Only available in LIVE mode (sandbox must be False).

    Args:
        merchant_id: PayFast merchant ID.
        merchant_key: PayFast merchant key.
        passphrase: Merchant passphrase (empty string if not set).
        sandbox: Must be False for onsite payments (they're production-only).
        m_payment_id: Your unique merchant payment ID.
        amount: Payment amount (e.g., "79.00").
        item_name: Item/service description.
        return_url: Return URL after payment (required).
        cancel_url: Cancel URL if user cancels (required).
        notify_url: Webhook URL for ITN notifications (required).
        name_first: Customer first name (optional).
        name_last: Customer last name (optional).
        email_address: Customer email (optional).

    Returns:
        (identifier, reason) tuple. identifier is None if generation fails.
    """
    if sandbox:
        LOGGER.error("Onsite payments are NOT available in sandbox mode")
        return None, "Onsite payments require LIVE mode (sandbox=false)"

    host = get_validate_host(sandbox)

    # Build request data for the onsite transaction API
    # Required fields for onsite payments
    data = {
        "merchant_id": merchant_id,
        "merchant_key": merchant_key,
        "return_url": return_url,
        "cancel_url": cancel_url,
        "notify_url": notify_url,
        "amount": amount,
        "item_name": item_name,
    }

    # Add optional fields if provided
    if m_payment_id:
        data["m_payment_id"] = m_payment_id
    if name_first:
        data["name_first"] = name_first
    if name_last:
        data["name_last"] = name_last
    if email_address:
        data["email_address"] = email_address

    # Build signature using ALPHABETICAL order (required for onsite)
    sig = build_signature(data, passphrase, alphabetical=True)
    data["signature"] = sig

    post_body = urllib.parse.urlencode(data).encode()

    LOGGER.info(
        "PayFast onsite request for %s: data=%s, signature=%s",
        m_payment_id,
        {k: v for k, v in data.items() if k != "signature"},
        sig,
    )

    try:
        req = urllib.request.Request(
            f"https://{host}/onsite/process",
            data=post_body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read().decode().strip()

        # Log the raw response
        LOGGER.info("PayFast onsite response: %s", body)

        # PayFast returns either JSON with uuid field or UUID string directly
        try:
            result = json.loads(body)
            # Try different response formats
            uuid = result.get("uuid") or result.get("data", {}).get("uuid")
            if uuid:
                LOGGER.info("Generated onsite payment identifier for %s", m_payment_id)
                return uuid, "ok"
            else:
                reason = result.get("error") or result.get("message") or str(result)
                LOGGER.error(
                    "PayFast onsite identifier generation failed: %s (full response: %s)",
                    reason,
                    body,
                )
                return None, f"PayFast error: {reason}"
        except json.JSONDecodeError:
            # If not JSON, assume it's the UUID directly (UUID format is 36 chars)
            if body and len(body) == 36:
                LOGGER.info("Generated onsite payment identifier for %s", m_payment_id)
                return body, "ok"
            LOGGER.error(
                "PayFast returned unexpected response: %s (expected UUID or JSON)", body
            )
            return None, f"Unexpected response: {body}"

    except urllib.error.URLError as exc:
        LOGGER.error("PayFast onsite request failed: %s", exc)
        return None, f"Request failed: {exc}"
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("Unexpected error during onsite identifier generation: %s", exc)
        return None, f"Unexpected error: {exc}"
