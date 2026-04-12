"""PayFast payment utility for Wonke Connect.

Handles signature generation and ITN (Instant Transaction Notification) validation
for one-time payments via the PayFast hosted checkout page.

Key rules (from PayFast docs):
- Payment initiation signature: PayFast documented field order (NOT alphabetical).
- ITN validation signature: alphabetical field order.
- Spaces → '+' (not %20).
- Passphrase appended last: &passphrase=VALUE.
- Always respond 200 to ITN immediately, then validate asynchronously.
"""

from __future__ import annotations

import hashlib
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
