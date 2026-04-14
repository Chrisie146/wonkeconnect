# Netcash 1Voucher Integration – Wonke Connect

## Overview

This guide covers integrating Netcash 1Voucher payments into the Wonke Connect hotspot
captive portal. When a customer pays with a 1Voucher PIN, your Node.js backend receives a
postback from Netcash and automatically provisions a MikroTik hotspot session.

### Payment Flow

```
Customer connects to WiFi
        ↓
Captive portal loads (package selector)
        ↓
Customer selects package (e.g. R10 / 3hr)
        ↓
Backend creates pending_order in DB + generates unique reference
        ↓
Form POST → https://paynow.netcash.co.za/site/paynow.aspx
        ↓
Customer enters 1Voucher 16-digit PIN on Netcash page
        ↓
Netcash POSTs postback to your server (m5 URL)
        ↓
Backend validates postback → creates MikroTik user via RouterOS API
        ↓
Customer browser redirected to success page with login credentials
```

---

## Prerequisites

In your Netcash account go to **Account Profile → NetConnector → Pay Now** and confirm:

- 1Voucher is **enabled** as a payment method
- You have your **Pay Now Service Key** (GUID)
- Your **postback URLs** are configured (see Step 3)

---

## Step 1 – The Payment Form POST

The captive portal sends an HTML form POST to Netcash. Do **not** use an iFrame — certain
payment services won't process unless opened in a parent window due to banking regulations.

```html
<!-- hotspot/login.html -->
<form method="POST" action="https://paynow.netcash.co.za/site/paynow.aspx" target="_top">
  <input type="hidden" name="m1" value="YOUR_PAY_NOW_SERVICE_KEY">
  <input type="hidden" name="m2" value="UNIQUE_ORDER_REF">
  <input type="hidden" name="p2" value="10.00">
  <input type="hidden" name="p3" value="Wonke Connect – 3hr WiFi">
  <input type="hidden" name="p4" value="wonke-3hr-001">
  <input type="hidden" name="m4" value="CUSTOMER_PHONE_OR_ID">
  <input type="hidden" name="m5" value="https://yourdomain.duckdns.org/payment/notify">
  <input type="hidden" name="m6" value="https://yourdomain.duckdns.org/payment/success">
  <input type="hidden" name="m7" value="https://yourdomain.duckdns.org/payment/cancel">
  <button type="submit">Pay with 1Voucher</button>
</form>
```

### Key Form Fields

| Field | Purpose |
|-------|---------|
| `m1` | Your Pay Now Service Key (GUID) |
| `m2` | Unique order reference (store in your DB) |
| `p2` | Amount in ZAR (e.g. `10.00`) |
| `p3` | Description shown to customer |
| `p4` | Your internal item/package code |
| `m5` | Postback URL – server-to-server payment notification |
| `m6` | Redirect URL on successful payment |
| `m7` | Redirect URL on cancel or failure |

---

## Step 2 – Create Pending Order Before Redirecting

Before the customer is sent to Netcash, your server must create a record so the postback
can look it up later.

```javascript
// POST /checkout
router.post('/checkout', async (req, res) => {
  const { package_id, user_ip } = req.body;

  const packages = {
    '1hr':   { price: '5.00',  hours: 1,  name: '1hr' },
    '3hr':   { price: '10.00', hours: 3,  name: '3hr' },
    'daily': { price: '20.00', hours: 24, name: 'daily' },
  };

  const pkg = packages[package_id];
  if (!pkg) return res.status(400).send('Invalid package');

  const reference = `WC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  await db.query(
    `INSERT INTO pending_orders
       (reference, package_name, duration_hours, hotspot_user_ip, status, created_at)
     VALUES ($1, $2, $3, $4, 'pending', NOW())`,
    [reference, pkg.name, pkg.hours, user_ip]
  );

  res.json({ reference, amount: pkg.price, description: `Wonke WiFi – ${pkg.name}` });
});
```

---

## Step 3 – Node.js Postback Handler

This is the critical piece. Netcash POSTs a server-to-server notification to your `m5` URL
when payment is confirmed. Your server must respond `200 OK` quickly, then provision the
MikroTik user asynchronously.

```javascript
// routes/payment.js (Express)
const express = require('express');
const router  = express.Router();
const MikroTik = require('./mikrotik');
const db       = require('./db');

// Server-to-server postback from Netcash
router.post('/payment/notify', express.urlencoded({ extended: true }), async (req, res) => {
  const {
    TransactionAccepted, // "true" or "false"
    PaymentType,         // "1Voucher"
    Amount,              // e.g. "10.00"
    Reference,           // your m2 order reference
    NetcashOrderId,      // Netcash's own transaction ID
  } = req.body;

  console.log('Netcash postback:', req.body);

  // Always respond 200 quickly so Netcash does not retry
  res.sendStatus(200);

  if (TransactionAccepted !== 'true') {
    console.log('Payment failed/cancelled for ref:', Reference);
    return;
  }

  try {
    // 1. Look up the pending order
    const order = await db.query(
      'SELECT * FROM pending_orders WHERE reference = $1', [Reference]
    );
    if (!order.rows.length) {
      console.error('Order not found:', Reference);
      return;
    }

    const { package_name, duration_hours } = order.rows[0];

    // 2. Create MikroTik hotspot user
    const username    = `wc-${Date.now()}`;
    const password    = Math.random().toString(36).slice(2, 8).toUpperCase();
    const limitUptime = `${duration_hours}h`;

    await MikroTik.addHotspotUser({
      name:           username,
      password:       password,
      profile:        package_name,    // e.g. "1hr", "3hr", "daily"
      'limit-uptime': limitUptime,
      comment:        `1Voucher:${NetcashOrderId}`,
    });

    // 3. Save credentials for the success page
    await db.query(
      `UPDATE pending_orders
       SET status='paid', mikrotik_user=$1, mikrotik_pass=$2, paid_at=NOW()
       WHERE reference=$3`,
      [username, password, Reference]
    );

    console.log(`Provisioned: ${username} / ${password} (${limitUptime})`);

  } catch (err) {
    console.error('Error provisioning hotspot user:', err);
  }
});

// Customer browser redirect after payment
router.get('/payment/success', async (req, res) => {
  const { Reference } = req.query;

  // Poll DB — postback may arrive slightly before browser redirect
  const order = await db.query(
    'SELECT * FROM pending_orders WHERE reference = $1 AND status = $2',
    [Reference, 'paid']
  );

  if (order.rows.length) {
    const { mikrotik_user, mikrotik_pass } = order.rows[0];
    res.send(`
      <h2>Payment successful! 🎉</h2>
      <p><strong>Username:</strong> ${mikrotik_user}</p>
      <p><strong>Password:</strong> ${mikrotik_pass}</p>
      <p><a href="http://192.168.88.1/login?username=${mikrotik_user}&password=${mikrotik_pass}">
        Tap here to connect automatically
      </a></p>
    `);
  } else {
    // Postback hasn't arrived yet — ask customer to wait
    res.send('<p>Processing… please wait 10 seconds and refresh.</p>');
  }
});

router.get('/payment/cancel', (req, res) => {
  res.redirect('http://192.168.88.1'); // back to hotspot portal
});

module.exports = router;
```

---

## Step 4 – Database Schema

```sql
CREATE TABLE pending_orders (
  id             SERIAL PRIMARY KEY,
  reference      VARCHAR(50)  UNIQUE NOT NULL,
  package_name   VARCHAR(20)  NOT NULL,
  duration_hours INT          NOT NULL,
  hotspot_user_ip VARCHAR(45),
  status         VARCHAR(20)  DEFAULT 'pending',
  mikrotik_user  VARCHAR(50),
  mikrotik_pass  VARCHAR(20),
  paid_at        TIMESTAMP,
  created_at     TIMESTAMP    DEFAULT NOW()
);
```

---

## Step 5 – MikroTik Walled Garden

The captive portal must allow Netcash domains through **before** authentication, otherwise
customers can't reach the payment page.

Add the following to your MikroTik Hotspot Walled Garden:

```
/ip hotspot walled-garden
add dst-host=paynow.netcash.co.za
add dst-host=*.netcash.co.za
add dst-host=cde.netcash.co.za
add dst-host=netcashcde.azurewebsites.net
add dst-host=*.digicert.com
add dst-host=*.newrelic.com
add dst-host=js-agent.newrelic.com
add dst-host=*.ozow.com
add dst-host=*.azurefd.net
add dst-host=*.trafficmanager.net
add dst-host=yourdomain.duckdns.org    # your postback server
```

---

## Notes for the Wonke Connect Setup

### DuckDNS + Port Forwarding
Your postback URLs (`m5`, `m6`, `m7`) must be publicly reachable. Ensure port 443 (or
whichever port your Express app runs on) is forwarded on your home router to your Node.js
server. Netcash strongly prefers HTTPS — set up a free certificate via Let's Encrypt /
Certbot with an Nginx reverse proxy.

### 1Voucher Fees
Customers pay zero transaction fees when redeeming a 1Voucher. You (the merchant) pay a
per-transaction fee to Netcash. Factor this into your package pricing.

### Default Transaction Limit
New Pay Now accounts have a default Credit Card limit of R100. This does **not** affect
1Voucher redemptions but contact your Netcash advisor if you need limits adjusted for
future payment methods.

### PM2 Process Management
Keep your Node.js server running across reboots:

```bash
pm2 start server.js --name wonke-backend
pm2 save
pm2 startup
```

---

## Quick Reference

| Item | Value |
|------|-------|
| Pay Now endpoint | `https://paynow.netcash.co.za/site/paynow.aspx` |
| Form method | `POST` with `target="_top"` |
| Service Key field | `m1` |
| Order reference field | `m2` |
| Amount field | `p2` |
| Postback (server-to-server) | `m5` |
| Success redirect | `m6` |
| Cancel redirect | `m7` |
| Postback success flag | `TransactionAccepted = "true"` |