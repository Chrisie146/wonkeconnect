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
function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('is-active'));
    screens[name].classList.add('is-active');
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

    document.getElementById('pay-amount').textContent = `R${Number(plan.price).toFixed(2)}`;
    showScreen('details');
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.getElementById('back-button').addEventListener('click', () => showScreen('plans'));
document.getElementById('try-again-button').addEventListener('click', () => showScreen('plans'));
document.getElementById('error-back-button').addEventListener('click', () => showScreen('plans'));

// ── Payment method toggle ────────────────────────────────────────────────────
function getSelectedPaymentMethod() {
    const el = document.querySelector('input[name="payment_method"]:checked');
    return el ? el.value : 'payfast';
}

document.querySelectorAll('input[name="payment_method"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        const method = getSelectedPaymentMethod();
        document.getElementById('secure-note-payfast').style.display = method === 'payfast' ? '' : 'none';
        document.getElementById('secure-note-netcash').style.display  = method === 'netcash'  ? '' : 'none';
    });
});

// ── Payment form ──────────────────────────────────────────────────────────────
document.getElementById('buyer-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const errorEl = document.getElementById('form-error');
    errorEl.style.display = 'none';

    const nameFirst = document.getElementById('buyer-first-name').value.trim();
    const nameLast = document.getElementById('buyer-last-name').value.trim();
    const phone = document.getElementById('buyer-phone').value.trim();

    if (!nameFirst || !nameLast || !phone) {
        errorEl.textContent = 'Please fill in all fields.';
        errorEl.style.display = 'block';
        return;
    }

    const payButton = document.getElementById('pay-button');
    payButton.disabled = true;
    payButton.textContent = 'Please wait…';

    const method = getSelectedPaymentMethod();
    const endpoint = method === 'netcash' ? '/payment/netcash/initiate' : '/payment/initiate';

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                plan_id: state.selectedPlan.id,
                name_first: nameFirst,
                name_last: nameLast,
                cell_number: phone,
            }),
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.detail || 'Payment setup failed. Please try again.');
        }

        const data = await res.json();
        const actionUrl = method === 'netcash' ? data.netcash_url : data.payfast_url;
        const params    = data.params;

        // Auto-submit POST form to payment provider.
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = actionUrl;
        form.target = '_top';
        Object.entries(params).forEach(([key, value]) => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = key;
            input.value = value;
            form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        payButton.disabled = false;
        payButton.innerHTML = `Pay <span id="pay-amount">R${Number(state.selectedPlan.price).toFixed(2)}</span>`;
    }
});

// ── Post-payment return ───────────────────────────────────────────────────────
function checkReturnState() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const mPaymentId = params.get('m_payment_id');

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
    showScreen('success');
    document.getElementById('voucher-reveal').style.display = 'none';
    document.getElementById('voucher-loading').style.display = 'block';

    let attempts = 0;
    const maxAttempts = 24; // 24 × 5 s = 2 minutes

    async function attempt() {
        attempts++;
        try {
            const res = await fetch(`/payment/order/${encodeURIComponent(mPaymentId)}`);
            if (!res.ok) throw new Error('Order not found.');
            const order = await res.json();

            if (order.status === 'complete' && order.voucher_code) {
                document.getElementById('voucher-loading').style.display = 'none';
                document.getElementById('voucher-code').textContent = order.voucher_code;
                document.getElementById('voucher-reveal').style.display = 'block';

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
                '<p class="portal-error" style="display:block;">Taking longer than expected.<br>Please show this screen to a staff member.</p>';
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
const didHandleReturn = checkReturnState();
if (!didHandleReturn) {
    loadPlans();
}
