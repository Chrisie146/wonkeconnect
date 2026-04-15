'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    plans: [],
    selectedPlan: null,
};

// ── DOM references ────────────────────────────────────────────────────────────
const screens = {
    plans: document.getElementById('screen-plans'),
    details: document.getElementById('screen-details'),
    success: document.getElementById('screen-success'),
    cancel: document.getElementById('screen-cancel'),
    error: document.getElementById('screen-error'),
};

// ── Screen management ─────────────────────────────────────────────────────────
const stepMap = {
    plans: 0,
    details: 1,
    success: 3,
    cancel: 0,
    error: 0,
};

function updateStepBar(screenName) {
    const activeIdx = stepMap[screenName] ?? 0;
    const items = document.querySelectorAll('.step-item');
    const lines = document.querySelectorAll('.step-line');

    items.forEach((item, i) => {
        item.classList.toggle('is-done', i < activeIdx);
        item.classList.toggle('is-active', i === activeIdx);
    });
    lines.forEach((line, i) => {
        line.classList.toggle('is-done', i < activeIdx);
    });

    // Hide step bar on cancel/error screens
    const bar = document.getElementById('step-bar');
    if (bar) bar.style.display = (screenName === 'cancel' || screenName === 'error') ? 'none' : '';
}

function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('is-active'));
    screens[name].classList.add('is-active');
    updateStepBar(name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Plans ─────────────────────────────────────────────────────────────────────
async function loadPlans() {
    try {
        const res = await fetch('/portal/plans');
        if (!res.ok) throw new Error('Could not load packages.');
        const plans = await res.json();
        state.plans = plans;
        renderPlans(plans);
    } catch (err) {
        document.getElementById('plan-list').innerHTML =
            `<p class="portal-empty">${escHtml(err.message)}<br>Please ask staff for assistance.</p>`;
    }
}

function renderPlans(plans) {
    const container = document.getElementById('plan-list');
    if (!plans.length) {
        container.innerHTML =
            '<p class="portal-empty">No packages are available right now.<br>Please ask staff for assistance.</p>';
        return;
    }

    container.innerHTML = plans
        .map(
            (plan) => `
        <button class="plan-card" type="button" data-id="${plan.id}">
            <div class="plan-card-top">
                <span class="plan-badge">${escHtml(plan.badge_label)}</span>
                <span class="plan-price">R${Number(plan.price).toFixed(2)}</span>
            </div>
            <div class="plan-name">${escHtml(plan.name)}</div>
            <div class="plan-meta">${escHtml(plan.duration_label)}</div>
            <p class="plan-note">${escHtml(plan.note)}</p>
        </button>
    `,
        )
        .join('');

    document.querySelectorAll('.plan-card').forEach((card) => {
        card.addEventListener('click', () => {
            const plan = state.plans.find((p) => p.id === Number(card.dataset.id));
            if (plan) selectPlan(plan);
        });
    });
}

function selectPlan(plan) {
    state.selectedPlan = plan;

    document.getElementById('selected-plan-summary').innerHTML = `
        <div class="plan-summary-card">
            <span class="plan-summary-name">${escHtml(plan.name)}</span>
            <span class="plan-summary-price">R${Number(plan.price).toFixed(2)}</span>
        </div>`;

    const formatted = `R${Number(plan.price).toFixed(2)}`;
    document.querySelectorAll('.pay-amount').forEach((el) => { el.textContent = formatted; });
    showScreen('details');
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.getElementById('back-button').addEventListener('click', () => showScreen('plans'));
document.getElementById('try-again-button').addEventListener('click', () => showScreen('plans'));
document.getElementById('error-back-button').addEventListener('click', () => showScreen('plans'));

// ── Payment form ──────────────────────────────────────────────────────────────
async function initiatePayment(method, payButton) {
    const errorEl = document.getElementById('form-error');
    errorEl.style.display = 'none';

    const nameFirst = document.getElementById('buyer-first-name').value.trim();
    const nameLast  = document.getElementById('buyer-last-name').value.trim();
    const phone     = document.getElementById('buyer-phone').value.trim();

    if (!nameFirst || !nameLast || !phone) {
        errorEl.textContent = 'Please fill in all fields.';
        errorEl.style.display = 'block';
        return;
    }

    payButton.disabled = true;
    payButton.querySelector('.pay-btn-label').style.display = 'none';
    payButton.querySelector('.pay-btn-loading').style.display = '';

    // Advance step bar to "Payment"
    const items = document.querySelectorAll('.step-item');
    const lines = document.querySelectorAll('.step-line');
    items.forEach((item, i) => { item.classList.toggle('is-done', i < 2); item.classList.toggle('is-active', i === 2); });
    lines.forEach((line, i) => { line.classList.toggle('is-done', i < 2); });

    const endpoint = method === 'netcash' ? '/payment/netcash/initiate' : '/payment/initiate';

    try {
        const body = {
            plan_id: state.selectedPlan.id,
            name_first: nameFirst,
            name_last: nameLast,
            cell_number: phone,
        };
        if (method === 'payfast') body.pay_method = 'eft';

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const resBody = await res.json().catch(() => ({}));
            throw new Error(resBody.detail || 'Payment setup failed. Please try again.');
        }

        const data = await res.json();

        // Remember the payment ID so we can retrieve it after redirect/callback
        if (data.m_payment_id) {
            sessionStorage.setItem('wonke_m_payment_id', data.m_payment_id);
        }

        if (method === 'payfast' && data.redirect_url) {
            // Open payment in new browser window (escapes captive portal)
            window.open(data.redirect_url, '_blank');
        } else if (method === 'netcash') {
            // Netcash - redirect to hosted checkout
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = data.netcash_url;
            form.target = '_top';
            Object.entries(data.params).forEach(([key, value]) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = key;
                input.value = value;
                form.appendChild(input);
            });
            document.body.appendChild(form);
            form.submit();
        } else {
            throw new Error('Unexpected payment response. Please try again.');
        }
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        payButton.disabled = false;
        payButton.querySelector('.pay-btn-label').style.display = '';
        payButton.querySelector('.pay-btn-loading').style.display = 'none';
        updateStepBar('details');
    }
}

document.getElementById('pay-bank').addEventListener('click', () => {
    initiatePayment('payfast', document.getElementById('pay-bank'));
});

document.getElementById('pay-1voucher').addEventListener('click', () => {
    initiatePayment('netcash', document.getElementById('pay-1voucher'));
});

// ── Post-payment return ───────────────────────────────────────────────────────
function checkReturnState() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    // Try URL first, fall back to sessionStorage (Netcash strips query params).
    const mPaymentId = params.get('m_payment_id') || sessionStorage.getItem('wonke_m_payment_id');

    if (status === 'cancel') {
        showScreen('cancel');
        return true;
    }

    if (status === 'success' && mPaymentId) {
        pollForVoucher(mPaymentId);
        return true;
    }

    return false;
}

async function pollForVoucher(mPaymentId) {
    sessionStorage.removeItem('wonke_m_payment_id'); // Clean up
    showScreen('success');
    document.getElementById('voucher-reveal').style.display = 'none';
    document.getElementById('voucher-reveal').classList.remove('is-visible');
    document.getElementById('voucher-loading').style.display = 'block';

    // Reset progress bar
    const progressBar = document.getElementById('voucher-progress-bar');
    const waitHint = document.getElementById('voucher-wait-hint');
    if (progressBar) progressBar.style.width = '0%';
    if (waitHint) waitHint.style.display = 'none';

    let attempts = 0;
    const maxAttempts = 24; // 24 × 5 s = 2 minutes

    const statusMessages = [
        'Confirming payment…',
        'Confirming payment…',
        'Generating your voucher…',
        'Generating your voucher…',
        'Almost done…',
    ];

    function getStatusText(n) {
        if (n <= 2) return statusMessages[0];
        if (n <= 5) return statusMessages[2];
        return statusMessages[4];
    }

    async function attempt() {
        attempts++;
        // Update progress bar (max 95% until complete)
        if (progressBar) {
            const pct = Math.min(95, (attempts / maxAttempts) * 100);
            progressBar.style.width = pct + '%';
        }
        // Show progressive status text
        const loadingEl = document.getElementById('voucher-loading');
        if (loadingEl) {
            const statusHtml = `<div class="portal-spinner"></div>
                <p class="voucher-status-text">${getStatusText(attempts)}</p>
                <p class="voucher-attempt-counter">Step ${attempts} of ${maxAttempts}</p>`;
            const existingSpinner = loadingEl.querySelector('.portal-spinner');
            if (existingSpinner) {
                // Update text without replacing spinner
                const statusText = loadingEl.querySelector('.voucher-status-text');
                const counterText = loadingEl.querySelector('.voucher-attempt-counter');
                if (statusText) statusText.textContent = getStatusText(attempts);
                if (counterText) counterText.textContent = `Step ${attempts} of ${maxAttempts}`;
            } else {
                loadingEl.innerHTML = statusHtml;
            }
        }
        // After 3 attempts (~15s), show wait hint
        if (attempts >= 3 && waitHint) waitHint.style.display = '';

        try {
            const res = await fetch(`/payment/order/${encodeURIComponent(mPaymentId)}`);
            if (!res.ok) throw new Error('Order not found.');
            const order = await res.json();

            if (order.status === 'complete' && order.voucher_code) {
                // Fill progress to 100%
                if (progressBar) progressBar.style.width = '100%';

                document.getElementById('voucher-loading').style.display = 'none';
                document.getElementById('voucher-code').textContent = order.voucher_code;

                // Show plan info on success
                const planInfo = document.getElementById('voucher-plan-info');
                if (planInfo && order.plan_name) {
                    planInfo.innerHTML = `<div class="vpi-name">${escHtml(order.plan_name)}</div><div class="vpi-meta">R${Number(order.amount).toFixed(2)}</div>`;
                    planInfo.style.display = '';
                }

                // Animated reveal
                const reveal = document.getElementById('voucher-reveal');
                reveal.classList.add('is-visible');

                // Send code back to the login page (if still open) so it can auto-connect.
                if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(
                        { wonkeVoucher: order.voucher_code },
                        '*'
                    );
                    document.getElementById('autoconnect-status').style.display = 'block';
                }
                return;
            }

            if (order.status === 'failed') {
                showScreen('error');
                document.getElementById('error-message').textContent =
                    'Payment was unsuccessful. No charge was made. Please try again.';
                return;
            }

            if (order.status === 'cancelled') {
                showScreen('cancel');
                return;
            }
        } catch (_) {
            // Network hiccup — keep polling.
        }

        if (attempts < maxAttempts) {
            setTimeout(attempt, 5000);
        } else {
            document.getElementById('voucher-loading').innerHTML =
                '<p class="portal-error" style="display:block;">We couldn\'t confirm your voucher yet.<br>Your payment was received — please show this screen to staff, or contact us via WhatsApp for your voucher code.</p>';
        }
    }

    setTimeout(attempt, 2000); // Short initial delay for ITN to arrive.
}

// ── Copy voucher code ─────────────────────────────────────────────────────────
document.getElementById('copy-code-button').addEventListener('click', () => {
    const code = document.getElementById('voucher-code').textContent.trim();
    if (!code) return;

    navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById('copy-code-button');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = 'Copy code';
            btn.classList.remove('copied');
        }, 2000);
    }).catch(() => {
        // Clipboard not available (HTTP context) — silently ignore.
    });
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
updateStepBar('plans');
const didHandleReturn = checkReturnState();
if (!didHandleReturn) {
    loadPlans();
}
