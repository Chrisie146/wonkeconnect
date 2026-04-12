# PayFast Setup Guide

Complete documentation of how PayFast recurring subscription billing is integrated into FieldPay.

---

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Environment Setup](#environment-setup)
4. [Dependencies](#dependencies)
5. [Database Schema](#database-schema)
6. [Core Utilities](#core-utilities)
7. [API Endpoints](#api-endpoints)
8. [Subscription Plans](#subscription-plans)
9. [Payment Flow](#payment-flow)
10. [ITN (Instant Transaction Notification) Webhook](#itn-webhook)
11. [Email Notifications](#email-notifications)
12. [Testing & Sandbox](#testing--sandbox)

---

## Overview

FieldPay uses **PayFast** for South African subscription billing. The system handles:

- **Recurring subscriptions** (monthly and annual plans)
- **Payment collection** via PayFast's hosted payment page
- **Webhook validation** (ITN) for transaction confirmation
- **Subscription cancellation** via PayFast Merchant API
- **Grace periods** and renewal tracking

**Key points:**
- Subscriptions are **recurring** (PayFast handles renewal, we receive ITN on each charge)
- Users are **redirected to PayFast** for payment (hosted checkout)
- **ITN webhooks** confirm payment and upgrade the user
- The user's Pro access **persists until expiry** even after cancellation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React/Vite)                    │
│                   Upgrade screen form                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              POST /api/billing/initiate                      │
│  Generates PayFast params + signature                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼ (auto-submit form)
┌─────────────────────────────────────────────────────────────┐
│            PayFast Hosted Payment Page                       │
│       (user fills card, completes payment)                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   Success         Failure        Cancel
        │              │              │
        ▼              ▼              ▼
    Return URL    Return URL    Return URL
      (set by     (set by       (set by
     frontend)   frontend)     frontend)
    +ITN fired    +ITN fired
        │              │              │
        └──────────────┼──────────────┘
                       │
                       ▼
  POST /api/billing/notify (webhook)
  ┌────────────────────────────────┐
  │ 1. Validate ITN signature      │
  │ 2. Verify with PayFast         │
  │ 3. Check payment_status        │
  │ 4. Update subscriptions table  │
  │ 5. Upgrade user to Pro         │
  │ 6. Send email confirmation    │
  └────────────────────────────────┘
```

---

## Environment Setup

Add these variables to `.env`:

```bash
# PayFast credentials
PAYFAST_MERCHANT_ID=your_merchant_id_here
PAYFAST_MERCHANT_KEY=your_merchant_key_here
PAYFAST_PASSPHRASE=your_passphrase_or_empty_string
PAYFAST_SANDBOX=false  # or 'true' for testing

# Redirect URLs (used during payment initiation)
CLIENT_URL=https://your-frontend-domain.com    # for return/cancel URLs
API_URL=https://your-api-domain.com            # for ITN notify URL

# Email for confirmations
RESEND_API_KEY=your_resend_key
EMAIL_FROM="YourApp <noreply@yourdomain.com>"
```

### How to get PayFast credentials:

1. Sign up at [payfast.co.za](https://www.payfast.co.za) (merchant account)
2. Navigate to **Settings → API Credentials**
3. Copy:
   - **Merchant ID**
   - **Merchant Key**
   - **Passphrase** (optional, but recommended for security)
4. For testing, use **Sandbox** first — set `PAYFAST_SANDBOX=true`

---

## Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "pg": "^8.12.0",           // PostgreSQL driver
    "express": "^4.19.2",      // Web framework
    "jsonwebtoken": "^9.0.2",  // JWT for auth
    "bcrypt": "^5.1.1",        // Password hashing
    "resend": "^6.9.4"         // Email service
  }
}
```

**No additional PayFast SDK needed** — we build signatures and HTTP requests manually (see Core Utilities).

---

## Database Schema

### users table additions

Fields to track subscription state:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS (
  plan TEXT DEFAULT 'free',               -- 'free' | 'pro'
  plan_expires_at TIMESTAMPTZ,            -- when Pro access ends
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### subscriptions table (new)

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Plan
  plan TEXT NOT NULL,                    -- 'pro_monthly' | 'pro_annual'
  status TEXT DEFAULT 'pending',         -- 'pending' | 'active' | 'cancelled' | 'failed'

  -- PayFast identifiers
  m_payment_id TEXT UNIQUE NOT NULL,     -- our unique merchant payment ID
  pf_payment_id TEXT,                    -- PayFast's internal transaction ID
  payfast_token TEXT,                    -- recurring subscription token (from first ITN)

  -- Amounts
  amount NUMERIC(10,2) NOT NULL,         -- plan price (R79.00 or R699.00)

  -- Billing lifecycle
  billing_date TIMESTAMPTZ,              -- next payment date (from PayFast ITN)

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_m_payment_id ON subscriptions(m_payment_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
```

---

## Core Utilities

### File: `utils/payfast.js`

Three main functions: signature generation, ITN validation, and subscription cancellation.

#### 1. buildSignature(params, passphrase, opts = {})

Generates MD5 hash for PayFast authentication.

**Key rules:**
- **Payment initiation**: Use PayFast's documented field order (NOT alphabetical)
- **ITN validation**: Use alphabetical order (PayFast ITN spec)
- Spaces encoded as `+` (not `%20`)
- Passphrase appended at end: `&passphrase=VALUE`

```javascript
const crypto = require('crypto');

const PAYFAST_FIELD_ORDER = [
  'merchant_id', 'merchant_key', 'return_url', 'cancel_url', 'notify_url',
  'name_first', 'name_last', 'email_address', 'cell_number',
  'm_payment_id', 'amount', 'item_name', 'item_description',
  'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
  'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
  'email_confirmation', 'confirmation_address', 'payment_method',
  'subscription_type', 'billing_date', 'recurring_amount', 'frequency', 'cycles',
];

function buildSignature(params, passphrase, opts = {}) {
  const validKeys = Object.keys(params)
    .filter(k => k !== 'signature' && params[k] !== '' && params[k] != null);

  let orderedKeys;
  if (opts.alphabetical) {
    // For ITN validation
    orderedKeys = validKeys.sort();
  } else {
    // For payment initiation
    const knownKeys = PAYFAST_FIELD_ORDER.filter(k => validKeys.includes(k));
    const unknownKeys = validKeys.filter(k => !PAYFAST_FIELD_ORDER.includes(k)).sort();
    orderedKeys = [...knownKeys, ...unknownKeys];
  }

  let str = orderedKeys
    .map(k => `${k}=${encodeURIComponent(String(params[k]).trim()).replace(/%20/g, '+')}`)
    .join('&');

  if (passphrase) {
    str += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }

  return crypto.createHash('md5').update(str).digest('hex');
}
```

#### 2. validateITN(data, passphrase)

Validates incoming ITN (webhook) from PayFast.

```javascript
const querystring = require('querystring');
const https = require('https');

const SANDBOX_HOST = 'sandbox.payfast.co.za';
const PRODUCTION_HOST = 'www.payfast.co.za';

function getHost() {
  return process.env.PAYFAST_SANDBOX === 'true' ? SANDBOX_HOST : PRODUCTION_HOST;
}

async function validateITN(data, passphrase) {
  // Step 1 — signature check (ITN uses alphabetical order)
  const { signature, ...rest } = data;
  const expectedSig = buildSignature(rest, passphrase || '', { alphabetical: true });
  
  if (expectedSig !== signature) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  // Step 2 — server-side confirmation with PayFast
  const postData = querystring.stringify(data);
  const host = getHost();

  return new Promise((resolve) => {
    const options = {
      host,
      port: 443,
      path: '/eng/query/validate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (body.trim() === 'VALID') {
          resolve({ valid: true });
        } else {
          resolve({ valid: false, reason: `PayFast returned: ${body.trim()}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ valid: false, reason: `Validation request failed: ${err.message}` });
    });

    req.write(postData);
    req.end();
  });
}
```

#### 3. cancelSubscription(token)

Calls PayFast Merchant API to cancel a recurring subscription.

```javascript
async function cancelSubscription(token) {
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const passphrase = process.env.PAYFAST_PASSPHRASE || '';
  const host = getHost();

  // YYYY-MM-DDTHH:MM:SS format
  const timestamp = new Date().toISOString().slice(0, 19);

  // Build signature (alphabetical for API calls)
  const sigData = { 'merchant-id': merchantId, version: 'v1', timestamp };
  if (passphrase) sigData.passphrase = passphrase;

  const sigStr = Object.keys(sigData)
    .sort()
    .map(k => `${k}=${encodeURIComponent(sigData[k])}`)
    .join('&');
  const signature = crypto.createHash('md5').update(sigStr).digest('hex');

  return new Promise((resolve) => {
    const options = {
      host,
      port: 443,
      path: `/v1/subscriptions/${token}/cancel`,
      method: 'PUT',
      headers: {
        'merchant-id': merchantId,
        version: 'v1',
        timestamp,
        signature,
        'Content-Length': 0,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true });
        } else {
          resolve({ success: false, reason: `PayFast returned ${res.statusCode}: ${body.trim()}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, reason: err.message });
    });

    req.end();
  });
}

module.exports = { buildSignature, validateITN, getHost, cancelSubscription };
```

---

## API Endpoints

### 1. POST /api/billing/initiate

**Request:**
```json
{
  "plan": "pro_monthly"  // or "pro_annual"
}
```

**Response:**
```json
{
  "payfastUrl": "https://www.payfast.co.za/eng/process",
  "params": {
    "merchant_id": "12345",
    "merchant_key": "key123",
    "return_url": "https://app.mysite.com/upgrade/success",
    "cancel_url": "https://app.mysite.com/upgrade/cancel",
    "notify_url": "https://api.mysite.com/api/billing/notify",
    "name_first": "John",
    "name_last": "Doe",
    "email_address": "john@example.com",
    "m_payment_id": "FP-1710000000000-abc123de",
    "amount": "79.00",
    "item_name": "FieldPay Pro - Monthly",
    "subscription_type": "1",
    "billing_date": "2026-04-12",
    "recurring_amount": "79.00",
    "frequency": "3",
    "cycles": "0",
    "signature": "abc123def456..."
  }
}
```

**Frontend implementation (auto-submit form):**
```javascript
// In React component after receiving initiate response:
const form = document.createElement('form');
form.method = 'POST';
form.action = response.payfastUrl;

Object.keys(response.params).forEach(key => {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = key;
  input.value = response.params[key];
  form.appendChild(input);
});

document.body.appendChild(form);
form.submit();
```

### 2. POST /api/billing/notify

**ITN Webhook from PayFast (not called by frontend)**

No authentication required. PayFast POSTs here with transaction details.

**Expected fields in req.body:**
- `m_payment_id` — our merchant payment ID
- `pf_payment_id` — PayFast payment ID
- `payment_status` — 'COMPLETE', 'FAILED', 'CANCELLED', 'PENDING'
- `amount_gross` — payment amount
- `token` — recurring subscription token (first payment only)
- `billing_date` — next billing date
- `signature` — PayFast signature

**Handler logic:**
```javascript
router.post('/notify', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately
  
  const data = req.body;
  const passphrase = process.env.PAYFAST_PASSPHRASE || '';

  // 1. Validate ITN
  const { valid, reason } = await validateITN(data, passphrase);
  if (!valid) {
    console.error('[billing] ITN validation failed:', reason);
    return;
  }

  // 2. Find subscription
  const sub = await pool.query(
    'SELECT * FROM subscriptions WHERE m_payment_id = $1',
    [data.m_payment_id]
  );
  if (!sub.rows.length) {
    console.error('[billing] Unknown m_payment_id:', data.m_payment_id);
    return;
  }

  // 3. Handle payment status
  if (data.payment_status === 'COMPLETE') {
    // Update subscription & upgrade user
    const plan = sub.rows[0].plan;
    const expiryDays = PLAN_EXPIRY_DAYS[plan] || 35;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE subscriptions SET
         status = 'active',
         pf_payment_id = $1,
         payfast_token = COALESCE($2, payfast_token),
         billing_date = $3,
         updated_at = NOW()
       WHERE m_payment_id = $4`,
      [data.pf_payment_id, data.token || null, data.billing_date, data.m_payment_id]
    );

    await pool.query(
      `UPDATE users SET plan = 'pro', plan_expires_at = $1 
       WHERE id = $2`,
      [expiresAt.toISOString(), sub.rows[0].user_id]
    );

    console.log(`[billing] User ${sub.rows[0].user_id} upgraded to ${plan}`);
  }
});
```

### 3. GET /api/billing/subscription

**Request:** No body (auth required)

**Response:**
```json
{
  "plan": "pro",
  "plan_expires_at": "2026-05-12T15:30:00.000Z",
  "subscription": {
    "id": "uuid",
    "plan": "pro_monthly",
    "status": "active",
    "amount": "79.00",
    "billing_date": "2026-05-12T00:00:00.000Z",
    "created_at": "2026-04-12T14:15:00.000Z"
  }
}
```

### 4. POST /api/billing/cancel

**Request:** No body (auth required)

**Response:**
```json
{
  "success": true,
  "message": "Subscription cancelled. You keep Pro access until your current period ends.",
  "plan_expires_at": "2026-05-12T15:30:00.000Z"
}
```

**Logic:**
1. Find active subscription with PayFast token
2. Call `cancelSubscription(token)` on PayFast API
3. Mark subscription as 'cancelled' in DB
4. User keeps Pro access until `plan_expires_at` (no immediate downgrade)

---

## Subscription Plans

Configuration in `routes/billing.js`:

```javascript
const PLANS = {
  pro_monthly: {
    amount: 79.00,
    label: 'FieldPay Pro - Monthly',
    frequency: 3,      // 3 = monthly (PayFast code)
    cycles: 0,         // 0 = indefinite (until cancelled)
  },
  pro_annual: {
    amount: 699.00,
    label: 'FieldPay Pro - Annual',
    frequency: 6,      // 6 = annual (PayFast code)
    cycles: 0,
  },
};

const PLAN_EXPIRY_DAYS = {
  pro_monthly: 35,    // 31 days + 4-day grace period
  pro_annual: 370,    // 365 days + 5-day grace period
};
```

**Frequency codes (PayFast spec):**
- `1` = weekly
- `2` = fortnightly
- `3` = monthly
- `4` = quarterly
- `5` = semi-annually
- `6` = annually

**Modify for your plans:** Add new entries to `PLANS` and `PLAN_EXPIRY_DAYS`.

---

## Payment Flow

### Step 1: User clicks "Upgrade"

Frontend calls `POST /api/billing/initiate` with `{ plan: 'pro_monthly' }`.

### Step 2: Server generates PayFast form parameters

Backend:
1. Retrieves user details (name, email)
2. Generates unique `m_payment_id`
3. Builds payment parameters
4. Generates MD5 signature (PayFast field order)
5. Creates pending subscription record
6. Returns form params + PayFast URL

### Step 3: Frontend auto-submits to PayFast

Frontend builds a hidden form with all params and auto-submits to PayFast's payment page.

### Step 4: User enters payment details on PayFast

User (or their browser) handles payment on PayFast's hosted page.

### Step 5: User redirected back to app

After payment (success/failure/cancel), PayFast redirects to:
- Success: `{CLIENT_URL}/upgrade/success`
- Cancel: `{CLIENT_URL}/upgrade/cancel`
- Failure: `{CLIENT_URL}/upgrade/cancel`

**Note:** Frontend can show a loading state, but doesn't need to wait for ITN.

### Step 6: PayFast sends ITN webhook (async)

Within seconds, PayFast POSTs to `POST /api/billing/notify` with transaction details.

Backend:
1. Validates signature + PayFast confirmation
2. Updates subscription status to 'active'
3. Ups user plan to 'pro'
4. Sets plan expiry date
5. Stores PayFast token (for future cancellations)
6. Sends confirmation email

---

## ITN Webhook

### Why two-step validation?

PayFast requires **two confirmations**:

1. **Signature check** — verify the ITN came from PayFast (not spoofed)
  - Uses alphabetical field order (per PayFast ITN spec)
  - Computed MD5 must match `signature` field in ITN

2. **Server confirmation** — re-query PayFast with the ITN data
  - PayFast responds 'VALID' or 'INVALID'
  - Prevents replay attacks

### Webhook security

- **No auth header required** (PayFast can't send JWT)
- **Always respond 200 immediately** (so PayFast stops retrying)
- **Validate signature before trusting any fields**
- **Verify with PayFast before updating DB**
- **Idempotent**: if same ITN arrives twice, second update is harmless (sets same values)

### ITN retry logic

If webhook fails (server returns non-200):
- PayFast retries after 2 hours
- Retries again at 6 hours, 12 hours, 24 hours
- Stops after 48 hours

So even if your server is temporarily down, ITN will eventually succeed.

---

## Email Notifications

### sendUpgradeEmail(toEmail, fullName, plan, expiresAt)

Sent when payment succeeds.

**Template:**
```
Subject: Welcome to FieldPay Pro!

Hi [First name],

Your upgrade is confirmed. You now have Pro access until [Expiry date].

[Plan details & features]

Questions? Reply to this email.

—
FieldPay · Built for SA tradespeople
```

**Implementation:**
```javascript
const { Resend } = require('resend');

async function sendUpgradeEmail(toEmail, fullName, plan, expiresAt) {
  const client = new Resend(process.env.RESEND_API_KEY);
  
  const firstName = fullName.split(' ')[0];
  const planLabel = plan === 'pro_annual' ? 'Pro Annual' : 'Pro Monthly';
  const renewDate = new Date(expiresAt).toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return client.emails.send({
    from: process.env.EMAIL_FROM,
    to: toEmail,
    subject: 'Welcome to FieldPay Pro! ⚡',
    html: `...`, // HTML template
  });
}

// Called from ITN handler (fire-and-forget)
sendUpgradeEmail(email, fullName, plan, expiresAt).catch(err => {
  console.error('Upgrade email failed:', err);
});
```

### sendCancellationEmail(toEmail, fullName, expiresAt)

Sent when user cancels subscription.

**Template:**
```
Subject: Your FieldPay Pro subscription has been cancelled

Hi [First name],

We've received your cancellation request. Your Pro access will end on [Date].

You can re-subscribe at any time from the Upgrade screen.

Questions? Reply to this email.

—
FieldPay · Built for SA tradespeople
```

---

## Testing & Sandbox

### Sandbox environment

Set in `.env`:
```bash
PAYFAST_SANDBOX=true
```

This uses `sandbox.payfast.co.za` instead of `www.payfast.co.za`.

### Test cards (PayFast Sandbox)

| Type | Card Number | Expiry | CVC |
|---|---|---|---|
| Visa | 4111 1111 1111 1111 | Any future | Any 3 digits |
| Mastercard | 5200 0000 0000 0000 | Any future | Any 3 digits |

Use any name/address — sandbox doesn't validate.

### ITN testing

**Sandbox ITN endpoint:**
- Runs on `sandbox.payfast.co.za`
- Same validation & cancellation as production

**To test locally** (without public URL):
1. Use a tunnelling service (ngrok, localtunnel)
2. Point `notify_url` to your tunnel
3. Observe PayFast webhooks in your server logs

Or manually test by calling your webhook endpoint:
```bash
curl -X POST http://localhost:3001/api/billing/notify \
  -d "m_payment_id=test123&payment_status=COMPLETE&signature=..."
```

---

## Common Issues & Solutions

### Signature mismatch

**Cause:** Field order wrong, or spaces not properly encoded.

**Fix:**
- For payment initiation: use `PAYFAST_FIELD_ORDER` (NOT alphabetical)
- For ITN validation: use alphabetical order (set `opts.alphabetical: true`)
- Spaces must be encoded as `+` (not `%20`)

### ITN never arrives

**Cause:**
- `notify_url` in params is wrong
- Webhook endpoint returns non-200
- Firewall blocks incoming HTTPS

**Fix:**
- Verify `API_URL` in `.env` is correct
- Always return 200 immediately from ITN handler
- Check that API is publicly reachable (test with curl)

### "Invalid merchant" error

**Cause:** `PAYFAST_MERCHANT_ID` or `PAYFAST_MERCHANT_KEY` wrong.

**Fix:**
- Double-check credentials in PayFast dashboard
- Try sandbox first to confirm setup works
- Verify `.env` file is loaded (check `/api/health` endpoint)

### User not upgraded after payment

**Cause:** ITN never arrived or signature validation failed.

**Fix:**
- Check API error logs for ITN validation failures
- Manually verify ITN in PayFast dashboard (Merchant → Transactions)
- Re-trigger ITN from PayFast dashboard if needed
- Use `POST /api/billing/notify` endpoint to replay (with correct signature)

---

## Production Checklist

- [ ] Set `PAYFAST_SANDBOX=false`
- [ ] Use live merchant ID & key (not sandbox credentials)
- [ ] Set `PAYFAST_PASSPHRASE` to a strong random string
- [ ] Set `API_URL` to your production API domain
- [ ] Set `CLIENT_URL` to your production frontend domain
- [ ] Verify SSL certificate on both API and frontend
- [ ] Test full flow (initiate → redirect → ITN → upgrade) in production
- [ ] Monitor `/api/health` to confirm `payfast_configured: true`
- [ ] Set up error alerts for ITN failures
- [ ] Test cancellation flow (cancel → ITN → status update)

---

## References

- **PayFast Payment Form Docs:** https://developers.payfast.co.za/docs
- **PayFast ITN Docs:** https://developers.payfast.co.za/docs#step_5_instant_transaction_notification
- **PayFast Merchant API:** https://developers.payfast.co.za/api
- **FieldPay Implementation:** `apps/api/src/routes/billing.js` & `apps/api/src/utils/payfast.js`

---

*Last updated: April 12, 2026*
*FieldPay — South African trades platform*
