const state = {
    submitMode: "single",
    lastGeneratedBatch: [],
    plans: [],
    selectedPlanId: null,
    currentScreen: "dashboard",
    availableProfiles: [],
};

const SCREEN_META = {
    dashboard: { kicker: "Overview", title: "Dashboard" },
    vouchers: { kicker: "Operations", title: "Vouchers" },
    plans: { kicker: "Configuration", title: "Plans" },
    settings: { kicker: "Router", title: "MikroTik Settings" },
    reports: { kicker: "Analytics", title: "Reports" },
};

const elements = {
    navLinks: Array.from(document.querySelectorAll(".app-nav-link")),
    screens: Array.from(document.querySelectorAll(".app-screen")),
    screenKicker: document.getElementById("screen-kicker"),
    screenTitle: document.getElementById("screen-title"),
    globalRefreshButton: document.getElementById("global-refresh-button"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
    sidebarOverlay: document.getElementById("sidebar-overlay"),
    sidebar: document.querySelector(".app-sidebar"),
    settingsForm: document.getElementById("settings-form"),
    settingsHost: document.getElementById("mikrotik-host"),
    settingsUsername: document.getElementById("mikrotik-username"),
    settingsPassword: document.getElementById("mikrotik-password"),
    settingsPort: document.getElementById("mikrotik-port"),
    settingsUseSsl: document.getElementById("mikrotik-use-ssl"),
    settingsPlaintextLogin: document.getElementById("mikrotik-plaintext-login"),
    settingsMessageBox: document.getElementById("settings-message-box"),
    connectionStatusPill: document.getElementById("connection-status-pill"),
    testSettingsButton: document.getElementById("test-settings-button"),
    payfastForm: document.getElementById("payfast-form"),
    payfastMerchantId: document.getElementById("pf-merchant-id"),
    payfastMerchantKey: document.getElementById("pf-merchant-key"),
    payfastPassphrase: document.getElementById("pf-passphrase"),
    payfastServerUrl: document.getElementById("pf-server-url"),
    payfastSandbox: document.getElementById("pf-sandbox"),
    payfastSyncKey: document.getElementById("pf-sync-key"),
    copySyncKeyButton: document.getElementById("copy-sync-key-button"),
    payfastMessageBox: document.getElementById("payfast-message-box"),
    printSheetButton: document.getElementById("print-sheet-button"),
    planForm: document.getElementById("plan-form"),
    planId: document.getElementById("plan-id"),
    planName: document.getElementById("plan-name"),
    planHotspotUserProfile: document.getElementById("plan-hotspot-user-profile"),
    planDuration: document.getElementById("plan-duration"),
    planBadge: document.getElementById("plan-badge"),
    planNote: document.getElementById("plan-note"),
    planPrice: document.getElementById("plan-price"),
    planActive: document.getElementById("plan-active"),
    resetPlanButton: document.getElementById("reset-plan-button"),
    deletePlanButton: document.getElementById("delete-plan-button"),
    planMessageBox: document.getElementById("plan-message-box"),
    planTableBody: document.getElementById("plan-table-body"),
    form: document.getElementById("voucher-form"),
    advancedModeToggle: document.getElementById("advanced-mode-toggle"),
    advancedFields: document.getElementById("advanced-fields"),
    dataLimitGb: document.getElementById("data-limit-gb"),
    hotspotUserProfile: document.getElementById("hotspot-user-profile"),
    profileStatusIndicator: document.getElementById("profile-status-indicator"),
    codeLength: document.getElementById("code-length"),
    quantity: document.getElementById("quantity"),
    messageBox: document.getElementById("message-box"),
    recentResults: document.getElementById("recent-results"),
    voucherTableBody: document.getElementById("voucher-table-body"),
    statTotal: document.getElementById("stat-total"),
    statUsed: document.getElementById("stat-used"),
    statUnused: document.getElementById("stat-unused"),
    syncStatusButton: document.getElementById("sync-status-button"),
    refreshButton: document.getElementById("refresh-button"),
    refreshMonitorButton: document.getElementById("refresh-monitor-button"),
    statActiveUsers: document.getElementById("stat-active-users"),
    statTotalBandwidth: document.getElementById("stat-total-bandwidth"),
    statBytesIn: document.getElementById("stat-bytes-in"),
    statBytesOut: document.getElementById("stat-bytes-out"),
    activeUsersTableBody: document.getElementById("active-users-table-body"),
    monitorMessageBox: document.getElementById("monitor-message-box"),
    actionButtons: Array.from(document.querySelectorAll("button[type='submit'][data-mode]")),
};

boot();

function boot() {
    bindEvents();
    switchScreen(state.currentScreen);
    loadStoredBatch();
    refreshDashboard();
    loadMikroTikSettings();
    loadPlans();
    // Show loading state for profiles
    elements.hotspotUserProfile.innerHTML = '<option value="">Loading MikroTik profiles...</option>';
    loadAvailableProfiles();
    updatePrintButtonState();
    resetPlanForm();
    checkMikroTikConnection();
    // Auto-check connection every 30 seconds
    setInterval(checkMikroTikConnection, 30000);
}

function bindEvents() {
    // ── Sidebar toggle (mobile) ──────────────────────────────────────────────
    elements.sidebarToggle.addEventListener("click", () => {
        elements.sidebar.classList.toggle("is-open");
        elements.sidebarOverlay.classList.toggle("is-visible");
    });
    elements.sidebarOverlay.addEventListener("click", closeSidebar);

    elements.navLinks.forEach((button) => {
        button.addEventListener("click", () => {
            switchScreen(button.dataset.screen);
            closeSidebar();
        });
    });

    elements.globalRefreshButton.addEventListener("click", async () => {
        await Promise.all([refreshDashboard(), loadPlans(), loadMikroTikSettings(), loadPayFastSettings(), loadAvailableProfiles()]);
    });

    elements.settingsForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveMikroTikSettings();
    });

    elements.testSettingsButton.addEventListener("click", async () => {
        await testMikroTikConnection();
    });

    elements.payfastForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await savePayFastSettings();
    });

    elements.copySyncKeyButton.addEventListener("click", () => {
        const key = elements.payfastSyncKey.value;
        if (key) {
            navigator.clipboard.writeText(key);
            elements.copySyncKeyButton.textContent = "Copied!";
            setTimeout(() => { elements.copySyncKeyButton.textContent = "Copy"; }, 2000);
        }
    });

    elements.printSheetButton.addEventListener("click", openPrintSheet);

    elements.planForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await savePlan();
    });

    elements.resetPlanButton.addEventListener("click", resetPlanForm);
    elements.deletePlanButton.addEventListener("click", async () => {
        await deleteSelectedPlan();
    });

    elements.actionButtons.forEach((button) => {
        button.addEventListener("click", () => {
            state.submitMode = button.dataset.mode || "single";
        });
    });

    elements.advancedModeToggle.addEventListener("change", () => {
        elements.advancedFields.style.display = elements.advancedModeToggle.checked ? "block" : "none";
    });

    elements.hotspotUserProfile.addEventListener("change", () => {
        checkProfileStatus(elements.hotspotUserProfile.value);
    });

    elements.form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await submitVoucherRequest();
    });

    elements.syncStatusButton.addEventListener("click", async () => {
        await syncVoucherStatus();
    });

    elements.refreshButton.addEventListener("click", refreshDashboard);

    if (elements.refreshMonitorButton) {
        elements.refreshMonitorButton.addEventListener("click", loadMonitoringData);
    }
}

function switchScreen(screenName) {
    state.currentScreen = SCREEN_META[screenName] ? screenName : "dashboard";

    elements.navLinks.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.screen === state.currentScreen);
    });

    elements.screens.forEach((screen) => {
        screen.classList.toggle("is-active", screen.id === `screen-${state.currentScreen}`);
    });

    const meta = SCREEN_META[state.currentScreen];
    elements.screenKicker.textContent = meta.kicker;
    elements.screenTitle.textContent = meta.title;

    // Load data for specific screens
    if (state.currentScreen === "reports") {
        loadMonitoringData();
    }
    if (state.currentScreen === "settings") {
        loadPayFastSettings();
    }
}

async function refreshDashboard() {
    await Promise.all([loadStats(), loadVouchers()]);
}

async function loadMikroTikSettings() {
    try {
        const settings = await fetchJson("/settings/mikrotik");
        elements.settingsHost.value = settings.host || "";
        elements.settingsUsername.value = settings.username || "";
        elements.settingsPassword.value = settings.password || "";
        elements.settingsPort.value = settings.port || 8728;
        elements.settingsUseSsl.checked = Boolean(settings.use_ssl);
        elements.settingsPlaintextLogin.checked = Boolean(settings.plaintext_login);

        const configured = settings.host && settings.username;
        setSettingsMessage(
            configured ? "MikroTik settings loaded." : "Save your MikroTik host and username to enable router sync.",
            configured ? "success" : ""
        );
        setConnectionStatus("idle", configured ? "Ready to test" : "Not configured");
        updateConnectionIndicator(configured ? "idle" : "not-configured");
    } catch (error) {
        setSettingsMessage(`Could not load settings: ${error.message}`, "error");
        setConnectionStatus("fail", "Load failed");
        updateConnectionIndicator("error");
    }
}

async function loadPayFastSettings() {
    try {
        const s = await fetchJson("/settings/payfast");
        elements.payfastMerchantId.value = s.merchant_id || "";
        elements.payfastMerchantKey.value = s.merchant_key || "";
        elements.payfastPassphrase.value = s.passphrase || "";
        elements.payfastServerUrl.value = s.server_url || "";
        elements.payfastSandbox.checked = Boolean(s.sandbox);
        elements.payfastSyncKey.value = s.mikrotik_sync_api_key || "";
        if (s.configured) {
            setPayFastMessage(`PayFast settings loaded. ${s.sandbox ? "Sandbox mode." : "LIVE mode."}`, "success");
        }
    } catch (_) {
        // Non-critical — silently ignore.
    }
}

async function savePayFastSettings() {
    const payload = {
        merchant_id: elements.payfastMerchantId.value.trim(),
        merchant_key: elements.payfastMerchantKey.value.trim(),
        passphrase: elements.payfastPassphrase.value.trim(),
        server_url: elements.payfastServerUrl.value.trim(),
        sandbox: elements.payfastSandbox.checked,
        mikrotik_sync_api_key: elements.payfastSyncKey.value.trim(),
    };

    if (!payload.merchant_id || !payload.merchant_key) {
        setPayFastMessage("Merchant ID and Merchant Key are required.", "error");
        return;
    }
    if (!payload.server_url) {
        setPayFastMessage("Server URL is required so PayFast can confirm payments.", "error");
        return;
    }

    try {
        setPayFastMessage("Saving…", "");
        const saved = await sendJson("/settings/payfast", payload);
        elements.payfastSyncKey.value = saved.mikrotik_sync_api_key || "";
        setPayFastMessage(
            `PayFast settings saved. ${payload.sandbox ? "⚠ Sandbox mode is ON — switch to live before going live." : "✓ Live mode."}`,
            payload.sandbox ? "" : "success"
        );
    } catch (error) {
        setPayFastMessage(error.message, "error");
    }
}

function setPayFastMessage(msg, type) {
    const el = elements.payfastMessageBox;
    if (!el) return;
    el.textContent = msg;
    el.className = "wc-message" + (type ? ` wc-message-${type}` : "");
}


async function saveMikroTikSettings() {
    const payload = {
        host: elements.settingsHost.value.trim(),
        username: elements.settingsUsername.value.trim(),
        password: elements.settingsPassword.value,
        port: Number(elements.settingsPort.value),
        use_ssl: elements.settingsUseSsl.checked,
        plaintext_login: elements.settingsPlaintextLogin.checked,
    };

    if (!payload.host || !payload.username) {
        setSettingsMessage("Host and username are required.", "error");
        return;
    }

    try {
        setSettingsMessage("Saving settings...", "");
        await sendJson("/settings/mikrotik", payload);
        setSettingsMessage("MikroTik settings saved. New voucher sync requests will use these values.", "success");
        setConnectionStatus("idle", "Ready to test");
    } catch (error) {
        setSettingsMessage(error.message, "error");
        setConnectionStatus("fail", "Save failed");
    }
}

async function testMikroTikConnection() {
    const btn = elements.testSettingsButton;
    try {
        setButtonLoading(btn, true);
        setSettingsMessage("Testing MikroTik connection...", "");
        setConnectionStatus("idle", "Testing");
        const result = await sendJson("/settings/mikrotik/test", {});
        setSettingsMessage(result.message, result.connected ? "success" : "error");
        setConnectionStatus(result.connected ? "ok" : "fail", result.connected ? "Connected" : "Failed");
        updateConnectionIndicator(result.connected ? "ok" : "fail");
        showToast(result.connected ? "Router connected" : "Connection failed", result.connected ? "success" : "error");
    } catch (error) {
        setSettingsMessage(error.message, "error");
        setConnectionStatus("fail", "Failed");
        updateConnectionIndicator("error");
        showToast(error.message, "error");
    } finally {
        setButtonLoading(btn, false);
    }
}

async function checkMikroTikConnection() {
    try {
        const result = await sendJson("/settings/mikrotik/test", {});
        updateConnectionIndicator(result.connected ? "ok" : "fail");
    } catch (error) {
        updateConnectionIndicator("error");
    }
}

function updateConnectionIndicator(status) {
    const statusElement = document.getElementById("mikrotik-connection-status");
    const dotElement = document.getElementById("connection-dot");
    const textElement = document.getElementById("connection-text");
    
    const statusMap = {
        "ok": { class: "status-ok", text: "Connected" },
        "fail": { class: "status-error", text: "Disconnected" },
        "error": { class: "status-error", text: "Error" },
        "idle": { class: "status-warning", text: "Not tested" },
        "not-configured": { class: "status-warning", text: "Not configured" },
    };
    
    const statusInfo = statusMap[status] || statusMap["idle"];
    
    // Update classes
    Object.values(statusMap).forEach(info => {
        statusElement.classList.remove(info.class);
    });
    statusElement.classList.add(statusInfo.class);
    
    // Update text
    textElement.textContent = statusInfo.text;
}

async function loadPlans() {
    try {
        elements.planTableBody.innerHTML = skeletonRows(4, 3);
        const plans = await fetchJson("/plans");
        state.plans = plans;
        renderPlanTable();
        populateHotspotUserProfileSelect();
        syncSelectedPlanForm();
        setPlanMessage(`Loaded ${plans.length} plan(s).`, "success");
    } catch (error) {
        state.plans = [];
        elements.planTableBody.innerHTML = `<tr><td colspan="3" class="wc-table-empty">${escapeHtml(error.message)}</td></tr>`;
        populateHotspotUserProfileSelect();
        setPlanMessage(error.message, "error");
    }
}

async function savePlan() {
    const payload = {
        name: elements.planName.value.trim(),
        hotspot_user_profile: elements.planHotspotUserProfile.value.trim(),
        duration_label: elements.planDuration.value.trim(),
        badge_label: elements.planBadge.value.trim(),
        note: elements.planNote.value.trim(),
        price: Number(elements.planPrice.value) || 0,
        active: elements.planActive.checked,
    };

    if (!payload.name || !payload.hotspot_user_profile || !payload.duration_label || !payload.badge_label || !payload.note) {
        setPlanMessage("All plan fields are required.", "error");
        return;
    }

    const btn = document.getElementById("save-plan-button");
    try {
        setButtonLoading(btn, true);
        setPlanMessage("Saving plan...", "");
        let response;
        if (state.selectedPlanId) {
            response = await sendJson(`/plans/${state.selectedPlanId}`, payload, "PUT");
        } else {
            response = await sendJson("/plans", payload);
        }

        await loadPlans();
        const saved = state.plans.find((plan) => plan.hotspot_user_profile === payload.hotspot_user_profile) || null;
        if (saved) {
            selectPlan(saved.id);
        } else {
            resetPlanForm();
        }
        const syncMessage = response.mikrotik_synced
            ? " HotSpot user profile synced to MikroTik."
            : ` Saved locally. MikroTik sync failed: ${response.mikrotik_message}`;
        setPlanMessage(`Plan saved.${syncMessage}`, response.mikrotik_synced ? "success" : "error");
        showToast("Plan saved", response.mikrotik_synced ? "success" : "error");
    } catch (error) {
        setPlanMessage(error.message, "error");
        showToast(error.message, "error");
    } finally {
        setButtonLoading(btn, false);
    }
}

async function deleteSelectedPlan() {
    if (!state.selectedPlanId) {
        setPlanMessage("Select a plan first.", "error");
        return;
    }

    try {
        const result = await sendJson(`/plans/${state.selectedPlanId}`, {}, "DELETE");
        setPlanMessage(result.message || "Plan removed.", "success");
        resetPlanForm();
        await loadPlans();
    } catch (error) {
        setPlanMessage(error.message, "error");
    }
}

function renderPlanTable() {
    if (!state.plans.length) {
        elements.planTableBody.innerHTML = '<tr><td colspan="3" class="wc-table-empty">No plans yet.</td></tr>';
        return;
    }

    elements.planTableBody.innerHTML = state.plans
        .map((plan) => {
            const selectedClass = plan.id === state.selectedPlanId ? " is-selected" : "";
            const statusClass = plan.active ? "wc-status-unused" : "wc-status-used";
            const priceLabel = plan.price > 0 ? `R${Number(plan.price).toFixed(2)}` : `<span style="color:var(--wc-muted)">—</span>`;
            return `
                <tr class="wc-plan-row${selectedClass}" data-plan-id="${plan.id}">
                    <td><strong>${escapeHtml(plan.name)}</strong></td>
                    <td>${escapeHtml(plan.hotspot_user_profile)}</td>
                    <td>${priceLabel}</td>
                    <td><span class="wc-status-pill ${statusClass}">${plan.active ? "active" : "inactive"}</span></td>
                </tr>
            `;
        })
        .join("");

    Array.from(elements.planTableBody.querySelectorAll(".wc-plan-row")).forEach((row) => {
        row.addEventListener("click", () => {
            selectPlan(Number(row.dataset.planId));
        });
    });
}

function populateHotspotUserProfileSelect() {
    // Populate from available MikroTik profiles
    if (state.availableProfiles && state.availableProfiles.length > 0) {
        const currentValue = elements.hotspotUserProfile.value;
        
        // Build options from available profiles
        const options = state.availableProfiles
            .sort()
            .map((profile) => {
                // Try to find a matching plan for better labeling
                const plan = state.plans.find(p => p.hotspot_user_profile === profile);
                const label = plan ? `${plan.name} (${profile})` : profile;
                return `<option value="${escapeHtml(profile)}">${escapeHtml(label)}</option>`;
            })
            .join("");
        
        elements.hotspotUserProfile.innerHTML = options || '<option value="">No profiles available</option>';
        
        // Restore previous value if it still exists
        if (state.availableProfiles.includes(currentValue)) {
            elements.hotspotUserProfile.value = currentValue;
        } else if (state.availableProfiles.length > 0) {
            elements.hotspotUserProfile.value = state.availableProfiles[0];
        }
        
        checkProfileStatus(elements.hotspotUserProfile.value);
        return;
    }
    
    // Fallback to plan-based dropdown if no profiles loaded yet
    const activePlans = state.plans.filter((plan) => plan.active);
    if (!activePlans.length) {
        elements.hotspotUserProfile.innerHTML = '<option value="">No active plans (MikroTik profiles loading...)</option>';
        updateProfileStatusIndicator(null);
        return;
    }

    const currentValue = elements.hotspotUserProfile.value;
    elements.hotspotUserProfile.innerHTML = activePlans
        .map((plan) => `<option value="${escapeHtml(plan.hotspot_user_profile)}">${escapeHtml(plan.name)} (${escapeHtml(plan.hotspot_user_profile)})</option>`)
        .join("");

    const stillExists = activePlans.some((plan) => plan.hotspot_user_profile === currentValue);
    elements.hotspotUserProfile.value = stillExists ? currentValue : activePlans[0].hotspot_user_profile;
    
    // Check profile status
    checkProfileStatus(elements.hotspotUserProfile.value);
}

function selectPlan(planId) {
    state.selectedPlanId = planId;
    syncSelectedPlanForm();
    renderPlanTable();
}

function syncSelectedPlanForm() {
    const selected = state.plans.find((plan) => plan.id === state.selectedPlanId);
    if (!selected) {
        return;
    }

    elements.planId.value = String(selected.id);
    elements.planName.value = selected.name;
    elements.planHotspotUserProfile.value = selected.hotspot_user_profile;
    elements.planDuration.value = selected.duration_label;
    elements.planBadge.value = selected.badge_label;
    elements.planNote.value = selected.note;
    elements.planPrice.value = selected.price > 0 ? String(Number(selected.price).toFixed(2)) : "";
    elements.planActive.checked = Boolean(selected.active);
}

function resetPlanForm() {
    state.selectedPlanId = null;
    elements.planId.value = "";
    elements.planName.value = "";
    elements.planHotspotUserProfile.value = "";
    elements.planDuration.value = "";
    elements.planBadge.value = "";
    elements.planNote.value = "";
    elements.planPrice.value = "";
    elements.planActive.checked = true;
    renderPlanTable();
}

async function loadAvailableProfiles() {
    try {
        const data = await fetchJson("/hotspot/available-profiles");
        state.availableProfiles = data.profiles || [];
        
        // Update profile dropdown when profiles are loaded
        populateHotspotUserProfileSelect();
        
        if (state.availableProfiles.length === 0 && data.available) {
            // Connected but no profiles - show friendly message
            elements.profileStatusIndicator.innerHTML = `<span style="color: var(--wc-orange); font-weight: 600;">⚠ No HotSpot profiles found on router - create one first</span>`;
        }
    } catch (error) {
        // Silently fail - profiles are optional for basic functionality
        state.availableProfiles = [];
    }
}

function checkProfileStatus(profile) {
    if (!profile) {
        updateProfileStatusIndicator(null);
        return;
    }
    
    // Since we now populate dropdown from available profiles, if it's selected it must be available
    const exists = state.availableProfiles && state.availableProfiles.includes(profile);
    updateProfileStatusIndicator(exists ? "ok" : "missing");
}

function updateProfileStatusIndicator(status) {
    if (!status) {
        elements.profileStatusIndicator.innerHTML = "";
        return;
    }
    
    if (status === "ok") {
        elements.profileStatusIndicator.innerHTML = `<span style="color: var(--wc-success); font-weight: 600;">✓ Available on MikroTik router</span>`;
    } else if (status === "missing") {
        elements.profileStatusIndicator.innerHTML = `<span style="color: var(--wc-orange); font-weight: 600;">⚠ Profile not synced - may fail</span>`;
    }
}

async function submitVoucherRequest() {
    const payload = {
        hotspot_user_profile: elements.hotspotUserProfile.value.trim(),
        code_length: Number(elements.codeLength.value),
    };

    if (!payload.hotspot_user_profile) {
        setMessage("Select an active HotSpot user profile plan first.", "error");
        return;
    }

    // Check if advanced mode is enabled (only data limit per-user is supported)
    const isAdvancedMode = elements.advancedModeToggle.checked;
    if (isAdvancedMode) {
        // Convert GB to bytes: GB * 1024 * 1024 * 1024
        const dataLimitGb = Number(elements.dataLimitGb.value);
        payload.limit_bytes_total = dataLimitGb ? Math.floor(dataLimitGb * 1073741824) : 0;
    }

    try {
        setMessage("Processing request...", "");

        if (state.submitMode === "bulk") {
            const endpoint = isAdvancedMode ? "/bulk-create-with-limits" : "/bulk-create";
            const response = await sendJson(endpoint, {
                ...payload,
                quantity: Number(elements.quantity.value),
            });

            storeBatch(response.vouchers);
            renderRecentVouchers(response.vouchers);
            await refreshDashboard();

            const syncSummary = response.failed_sync_count
                ? ` ${response.failed_sync_count} voucher(s) were saved but not synced to MikroTik.`
                : " All vouchers synced to MikroTik.";
            setMessage(`Created ${response.vouchers.length} vouchers.${syncSummary}`, response.failed_sync_count ? "error" : "success");
            showToast(`Created ${response.vouchers.length} vouchers`, response.failed_sync_count ? "error" : "success");
            switchScreen("dashboard");
            return;
        }

        const endpoint = isAdvancedMode ? "/create-voucher-with-limits" : "/create-voucher";
        const response = await sendJson(endpoint, payload);
        storeBatch([response.voucher]);
        renderRecentVouchers([response.voucher]);
        await refreshDashboard();

        const syncSummary = response.mikrotik_synced
            ? "Voucher synced to MikroTik."
            : `Voucher saved locally. MikroTik sync failed: ${response.mikrotik_message}`;
        setMessage(`Created voucher ${response.voucher.code}. ${syncSummary}`, response.mikrotik_synced ? "success" : "error");
        showToast(`Voucher ${response.voucher.code} created`, response.mikrotik_synced ? "success" : "error");
        switchScreen("dashboard");
    } catch (error) {
        setMessage(error.message, "error");
        showToast(error.message, "error");
    }
}

async function loadStats() {
    try {
        const stats = await fetchJson("/stats");
        elements.statTotal.textContent = stats.total;
        elements.statUsed.textContent = stats.used;
        elements.statUnused.textContent = stats.unused;
    } catch (error) {
        setMessage(`Could not load stats: ${error.message}`, "error");
    }
}

async function loadVouchers() {
    try {
        elements.voucherTableBody.innerHTML = skeletonRows(6, 5);
        const vouchers = await fetchJson("/vouchers?limit=200");
        renderVoucherTable(vouchers);
    } catch (error) {
        elements.voucherTableBody.innerHTML = `<tr><td colspan="6" class="wc-table-empty">${escapeHtml(error.message)}</td></tr>`;
    }
}

async function syncVoucherStatus() {
    const btn = elements.syncStatusButton;
    try {
        setButtonLoading(btn, true);
        setMessage("Syncing voucher status from MikroTik...", "");
        const result = await sendJson("/sync-status", {});
        await refreshDashboard();
        setMessage(`${result.message} Updated ${result.updated} voucher(s); active users: ${result.active_users}.`, "success");
        showToast(`Synced — ${result.updated} updated`, "success");
    } catch (error) {
        setMessage(error.message, "error");
        showToast(error.message, "error");
    } finally {
        setButtonLoading(btn, false);
    }
}

function getStatusClass(status) {
    const statusMap = {
        "unused": "wc-status-unused",
        "used": "wc-status-used",
        "expired": "wc-status-expired",
        "deactivated": "wc-status-deactivated",
    };
    return statusMap[status] || "wc-status-unknown";
}

function formatDateShort(isoString) {
    if (!isoString) return "—";
    const date = new Date(isoString);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function renderVoucherTable(vouchers) {
    if (!vouchers.length) {
        elements.voucherTableBody.innerHTML = '<tr><td colspan="6" class="wc-table-empty">No vouchers yet.</td></tr>';
        return;
    }

    elements.voucherTableBody.innerHTML = vouchers
        .map((voucher) => {
            const createdDate = formatDate(voucher.created_at);
            const expiresDate = formatDateShort(voucher.expires_at);
            const statusClass = getStatusClass(voucher.status);
            const voucherId = voucher.id;
            const profileShort = voucher.hotspot_user_profile.substring(0, 12) + (voucher.hotspot_user_profile.length > 12 ? '…' : '');
            
            return `
                <tr>
                    <td><strong>${escapeHtml(voucher.code)}</strong></td>
                    <td title="${escapeHtml(voucher.hotspot_user_profile)}">${escapeHtml(profileShort)}</td>
                    <td><span class="wc-status-pill ${statusClass}">${escapeHtml(voucher.status)}</span></td>
                    <td>${escapeHtml(createdDate)}</td>
                    <td>${expiresDate}</td>
                    <td class="wc-actions-cell">
                        <div class="wc-action-menu">
                            <button class="wc-action-button" type="button" onclick="toggleActionMenu(${voucherId})" title="Actions">⋮</button>
                            <div class="wc-action-dropdown" id="menu-${voucherId}">
                                <button type="button" onclick="revokeVoucher(${voucherId})" class="wc-dropdown-item">Revoke</button>
                                <button type="button" onclick="deleteVoucher(${voucherId})" class="wc-dropdown-item wc-delete-item">Delete</button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join("");
    
    // Close any open menus when clicking elsewhere
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".wc-action-menu")) {
            document.querySelectorAll(".wc-action-dropdown.is-open").forEach(menu => {
                menu.classList.remove("is-open");
            });
        }
    });
}

function toggleActionMenu(voucherId) {
    const menu = document.getElementById(`menu-${voucherId}`);
    document.querySelectorAll(".wc-action-dropdown.is-open").forEach(m => {
        if (m !== menu) m.classList.remove("is-open");
    });
    menu.classList.toggle("is-open");
}

async function revokeVoucher(voucherId) {
    closeAllMenus();
    if (!confirm("Are you sure you want to revoke this voucher?")) return;
    try {
        setMessage("Revoking voucher...", "");
        const result = await sendJson(`/vouchers/${voucherId}/revoke`, {});
        setMessage(result.message, "success");
        await loadVouchers();
    } catch (error) {
        setMessage(error.message, "error");
    }
}

async function deleteVoucher(voucherId) {
    closeAllMenus();
    if (!confirm("Are you sure you want to delete this voucher permanently? This cannot be undone.")) return;
    try {
        setMessage("Deleting voucher...", "");
        await sendJson(`/vouchers/${voucherId}`, {}, "DELETE");
        setMessage("Voucher deleted successfully.", "success");
        await loadVouchers();
    } catch (error) {
        setMessage(error.message, "error");
    }
}

function closeAllMenus() {
    document.querySelectorAll(".wc-action-dropdown.is-open").forEach(menu => {
        menu.classList.remove("is-open");
    });
}

function renderRecentVouchers(vouchers) {
    if (!vouchers.length) {
        elements.recentResults.innerHTML = '<div class="wc-empty-state">No vouchers created.</div>';
        return;
    }

    elements.recentResults.innerHTML = `<section class="wc-vouchers">${vouchers
        .slice(0, 12)
        .map((voucher) => {
            const meta = getVoucherMeta(voucher);
            return `
                <article class="wc-voucher">
                    <div class="wc-voucher-top">
                        <div class="wc-brand wc-mini-brand">
                            <div class="wc-icon" aria-hidden="true">
                                <span class="wc-arc top"></span>
                                <span class="wc-arc mid"></span>
                                <span class="wc-dot"></span>
                                <span class="wc-accent left"></span>
                                <span class="wc-accent right"></span>
                            </div>
                            <div class="wc-wordmark">
                                <span class="wonke">Won<span class="k">k</span>e</span>
                                <span class="connect">Connect</span>
                            </div>
                        </div>
                        <span class="wc-badge">${escapeHtml(meta.badge_label)}</span>
                    </div>

                    <div class="wc-voucher-grid">
                        <div class="wc-field">
                            <span class="wc-field-label">Package</span>
                            <span class="wc-field-value">${escapeHtml(meta.plan_name)}</span>
                        </div>
                        <div class="wc-field">
                            <span class="wc-field-label">Duration</span>
                            <span class="wc-field-value">${escapeHtml(meta.duration_label)}</span>
                        </div>
                    </div>

                    <div class="wc-field">
                        <span class="wc-field-label">Voucher code</span>
                        <div class="wc-code">${escapeHtml(voucher.code)}</div>
                    </div>

                    <div class="wc-note">${escapeHtml(meta.note)}</div>
                </article>
            `;
        })
        .join("")}</section>`;
}

function getVoucherMeta(voucher) {
    return {
        plan_name: voucher.plan_name || getVoucherPackage(voucher.hotspot_user_profile),
        duration_label: voucher.duration_label || getVoucherDuration(voucher.hotspot_user_profile),
        badge_label: voucher.badge_label || getVoucherBadge(voucher.hotspot_user_profile),
        note: voucher.note || getVoucherNote(voucher.hotspot_user_profile),
    };
}

function storeBatch(vouchers) {
    state.lastGeneratedBatch = Array.isArray(vouchers) ? vouchers : [];
    localStorage.setItem("wonke-connect-last-batch", JSON.stringify(state.lastGeneratedBatch));
    updatePrintButtonState();
}

function loadStoredBatch() {
    try {
        const stored = localStorage.getItem("wonke-connect-last-batch");
        state.lastGeneratedBatch = stored ? JSON.parse(stored) : [];
        if (state.lastGeneratedBatch.length) {
            renderRecentVouchers(state.lastGeneratedBatch);
        }
    } catch (error) {
        state.lastGeneratedBatch = [];
        localStorage.removeItem("wonke-connect-last-batch");
    }
}

function updatePrintButtonState() {
    const hasBatch = state.lastGeneratedBatch.length > 0;
    elements.printSheetButton.disabled = !hasBatch;
    elements.printSheetButton.style.opacity = hasBatch ? "1" : "0.55";
    elements.printSheetButton.style.pointerEvents = hasBatch ? "auto" : "none";
}

function openPrintSheet() {
    if (!state.lastGeneratedBatch.length) {
        setMessage("Generate vouchers first, then print the latest batch.", "error");
        return;
    }

    window.open("/static/print.html", "_blank", "noopener,noreferrer");
}

function setMessage(message, tone) {
    elements.messageBox.textContent = message;
    elements.messageBox.classList.remove("is-success", "is-error");
    if (tone === "success") {
        elements.messageBox.classList.add("is-success");
    }
    if (tone === "error") {
        elements.messageBox.classList.add("is-error");
    }
}

function setSettingsMessage(message, tone) {
    elements.settingsMessageBox.textContent = message;
    elements.settingsMessageBox.classList.remove("is-success", "is-error");
    if (tone === "success") {
        elements.settingsMessageBox.classList.add("is-success");
    }
    if (tone === "error") {
        elements.settingsMessageBox.classList.add("is-error");
    }
}

function setPlanMessage(message, tone) {
    elements.planMessageBox.textContent = message;
    elements.planMessageBox.classList.remove("is-success", "is-error");
    if (tone === "success") {
        elements.planMessageBox.classList.add("is-success");
    }
    if (tone === "error") {
        elements.planMessageBox.classList.add("is-error");
    }
}

function setConnectionStatus(stateValue, label) {
    elements.connectionStatusPill.textContent = label;
    elements.connectionStatusPill.classList.remove("wc-connection-idle", "wc-connection-ok", "wc-connection-fail");

    if (stateValue === "ok") {
        elements.connectionStatusPill.classList.add("wc-connection-ok");
        return;
    }

    if (stateValue === "fail") {
        elements.connectionStatusPill.classList.add("wc-connection-fail");
        return;
    }

    elements.connectionStatusPill.classList.add("wc-connection-idle");
}

async function fetchJson(url) {
    const response = await fetch(url);
    return parseResponse(response);
}

async function sendJson(url, payload, method = "POST") {
    const response = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
        },
        body: method === "GET" ? undefined : JSON.stringify(payload),
    });
    return parseResponse(response);
}

async function parseResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok) {
        if (typeof payload === "object" && payload !== null) {
            throw new Error(payload.detail || JSON.stringify(payload));
        }
        throw new Error(String(payload));
    }

    return payload;
}

function formatDate(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        return isoString;
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function getVoucherPackage(hotspotUserProfile) {
    const key = String(hotspotUserProfile).toLowerCase();
    const mapping = {
        "1hr": "Starter",
        "1day": "Day Pass",
        "1gb": "Data Pass",
        "1week": "Weekly Pass",
    };
    return mapping[key] || hotspotUserProfile;
}

function getVoucherDuration(hotspotUserProfile) {
    const key = String(hotspotUserProfile).toLowerCase();
    const mapping = {
        "1hr": "1 hour",
        "1day": "1 day",
        "1gb": "1 GB",
        "1week": "1 week",
    };
    return mapping[key] || hotspotUserProfile;
}

function getVoucherBadge(hotspotUserProfile) {
    const key = String(hotspotUserProfile).toLowerCase();
    const mapping = {
        "1hr": "1HR",
        "1day": "1 DAY",
        "1gb": "1 GB",
        "1week": "1 WEEK",
    };
    return mapping[key] || hotspotUserProfile;
}

function getVoucherNote(hotspotUserProfile) {
    const key = String(hotspotUserProfile).toLowerCase();
    const mapping = {
        "1hr": "Fast hotspot access. Valid for in-store WiFi use.",
        "1day": "All-day hotspot access for customers in the area.",
        "1gb": "Data-based hotspot access with a 1 GB allowance.",
        "1week": "Extended hotspot access for regular customers.",
    };
    return mapping[key] || "Valid for Wonke Connect hotspot access.";
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function loadMonitoringData() {
    try {
        setMonitorMessage("Loading active users...", "");
        const data = await fetchJson("/users/active");
        renderMonitoringDashboard(data);
        setMonitorMessage("", "");
    } catch (error) {
        setMonitorMessage(error.message, "error");
        elements.activeUsersTableBody.innerHTML = `<tr><td colspan="7" class="wc-table-empty">Failed to load data: ${escapeHtml(error.message)}</td></tr>`;
    }
}

function renderMonitoringDashboard(data) {
    const users = data.users || [];
    
    // Calculate totals
    let totalBytesIn = 0;
    let totalBytesOut = 0;
    
    users.forEach(user => {
        totalBytesIn += user.bytes_in;
        totalBytesOut += user.bytes_out;
    });
    
    const totalBytes = totalBytesIn + totalBytesOut;
    
    // Update stat cards
    elements.statActiveUsers.textContent = String(data.total_active || 0);
    elements.statTotalBandwidth.textContent = formatBytes(totalBytes);
    elements.statBytesIn.textContent = formatBytes(totalBytesIn);
    elements.statBytesOut.textContent = formatBytes(totalBytesOut);
    
    // Render table
    if (!users.length) {
        elements.activeUsersTableBody.innerHTML = '<tr><td colspan="7" class="wc-table-empty">No active users.</td></tr>';
        return;
    }

    elements.activeUsersTableBody.innerHTML = users
        .map((user) => {
            return `
                <tr>
                    <td><strong>${escapeHtml(user.code)}</strong></td>
                    <td>${escapeHtml(user.profile)}</td>
                    <td>${escapeHtml(user.uptime)}</td>
                    <td>${formatBytes(user.bytes_in)}</td>
                    <td>${formatBytes(user.bytes_out)}</td>
                    <td>${formatBytes(user.bytes_total)}</td>
                    <td>${escapeHtml(user.address)}</td>
                </tr>
            `;
        })
        .join("");
}

function setMonitorMessage(text, type) {
    elements.monitorMessageBox.innerHTML = text
        ? `<div class="wc-message${type ? ` wc-message-${type}` : ''}">${escapeHtml(text)}</div>`
        : "";
}

// ── UX Helpers ────────────────────────────────────────────────────────────────

function closeSidebar() {
    elements.sidebar.classList.remove("is-open");
    elements.sidebarOverlay.classList.remove("is-visible");
}

// Toast notifications
function showToast(message, type = "") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `wc-toast${type ? ` wc-toast--${type}` : ""}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("is-leaving");
        toast.addEventListener("animationend", () => toast.remove());
    }, 3000);
}

// Skeleton table rows
function skeletonRows(cols, count = 4) {
    return Array.from({ length: count }, () =>
        `<tr class="wc-skeleton-row">${Array.from({ length: cols }, (_, i) =>
            `<td><div class="wc-skeleton-bar wc-skeleton-bar--${i === 0 ? "long" : "med"}"></div></td>`
        ).join("")}</tr>`
    ).join("");
}

// Button loading state helpers
function setButtonLoading(button, loading) {
    if (!button) return;
    if (loading) {
        button.classList.add("is-loading");
        button.disabled = true;
    } else {
        button.classList.remove("is-loading");
        button.disabled = false;
    }
}
