/* global React */
const { useState, useEffect } = React;

/* ───────── VOUCHERS ───────── */
const Vouchers = () => {
  const [tab, setTab] = useState("all");
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState([]);
  const [genPlan, setGenPlan] = useState("");
  const [genQty, setGenQty] = useState("20");
  const [genLen, setGenLen] = useState("8");
  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState(null);

  const load = () => {
    setLoading(true);
    fetch("/vouchers?limit=200").then(r => r.json()).then(v => { setVouchers(v); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => {
    load();
    fetch("/plans?active_only=true").then(r => r.json()).then(ps => {
      setPlans(ps);
      if (ps.length > 0) setGenPlan(ps[0].hotspot_user_profile);
    }).catch(() => {});
  }, []);

  const filtered = tab === "all" ? vouchers : vouchers.filter(v => {
    if (tab === "used") return v.status === "deactivated";
    return v.status === tab;
  });

  const counts = {
    all: vouchers.length,
    unused: vouchers.filter(v => v.status === "unused").length,
    active: 0,
    used: vouchers.filter(v => v.status === "deactivated").length,
    expired: vouchers.filter(v => v.status === "expired").length,
  };

  const generate = async () => {
    if (!genPlan) return;
    setGenerating(true); setGenMsg(null);
    try {
      const r = await fetch("/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotspot_user_profile: genPlan, quantity: parseInt(genQty), code_length: parseInt(genLen) }),
      });
      const d = await r.json();
      if (r.ok) {
        setGenMsg(`Generated ${d.vouchers?.length || 0} vouchers. MikroTik synced: ${d.synced_count}.`);
        load();
      } else {
        setGenMsg(d.detail || "Generation failed.");
      }
    } catch { setGenMsg("Network error."); }
    finally { setGenerating(false); }
  };

  const today = new Date().toISOString().slice(0, 10);
  const todayVouchers = vouchers.filter(v => v.created_at && v.created_at.startsWith(today));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Vouchers</h1>
          <p className="page-subtitle">Issue, track, and reconcile every voucher sold on your network.</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => {
            const csv = ["Code,Plan,Status,Created,Expires"].concat(
              vouchers.map(v => `${v.code},${v.plan_name||v.hotspot_user_profile},${v.status},${v.created_at||""},${v.expires_at||""}`)
            ).join("\n");
            const a = document.createElement("a"); a.href = "data:text/csv," + encodeURIComponent(csv);
            a.download = "vouchers.csv"; a.click();
          }}><Icon name="download" size={13}/> Export CSV</button>
          <button className="btn" onClick={load}><Icon name="refresh" size={13}/> Refresh</button>
        </div>
      </div>

      <div className="tabs">
        {[["all","All"],["unused","Unused"],["used","Used"],["expired","Expired"]].map(([k,l]) => (
          <button key={k} className={`tab ${tab===k?"active":""}`} onClick={() => setTab(k)}>
            {l} <span className="muted" style={{marginLeft:4, fontWeight:500}}>{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: "1fr 380px" }}>
        <div className="card card-flush">
          <div className="card-head">
            <div>
              <h3 className="card-title">Voucher inventory</h3>
              <p className="card-sub">{vouchers.length} total · showing {filtered.length}</p>
            </div>
          </div>
          {loading
            ? <div className="empty">Loading…</div>
            : filtered.length === 0
              ? <div className="empty">No vouchers in this view.</div>
              : <table className="tbl">
                  <thead>
                    <tr>
                      <th>Code</th><th>Plan</th><th>Status</th><th>Created</th><th>Expires</th><th style={{textAlign:"right"}}>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 100).map((v) => (
                      <tr key={v.id}>
                        <td className="code">{v.code}</td>
                        <td>{v.plan_name || v.hotspot_user_profile}</td>
                        <td><Badge kind={v.status === "deactivated" ? "used" : v.status}>{v.status === "deactivated" ? "used" : v.status}</Badge></td>
                        <td className="muted text-xs mono">{v.created_at ? v.created_at.slice(0,16).replace("T"," ") : "—"}</td>
                        <td className="muted text-xs mono">{v.expires_at ? v.expires_at.slice(0,16).replace("T"," ") : "—"}</td>
                        <td className="num" style={{textAlign:"right"}}>{v.price != null ? `R${v.price}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          }
        </div>

        <div className="vstack" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head"><h3 className="card-title">Generate batch</h3></div>
            <div className="card-body">
              {genMsg && <div className="text-xs" style={{ marginBottom: 12, color: genMsg.includes("fail") || genMsg.includes("error") ? "var(--red)" : "var(--teal)" }}>{genMsg}</div>}
              <div className="form-grid">
                <div className="field field-full">
                  <label>Plan</label>
                  <select className="select" value={genPlan} onChange={e => setGenPlan(e.target.value)}>
                    {plans.map(p => <option key={p.id} value={p.hotspot_user_profile}>{p.name} · R{p.price}</option>)}
                    {plans.length === 0 && <option value="">No active plans</option>}
                  </select>
                </div>
                <div className="field">
                  <label>Quantity</label>
                  <input className="input" type="number" min="1" max="500" value={genQty} onChange={e => setGenQty(e.target.value)}/>
                </div>
                <div className="field">
                  <label>Code length</label>
                  <select className="select" value={genLen} onChange={e => setGenLen(e.target.value)}>
                    <option value="8">8</option><option value="7">7</option><option value="6">6</option>
                  </select>
                </div>
                <div className="field field-full" style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                  <button className="btn brand flex-1" onClick={generate} disabled={generating || !genPlan}>
                    <Icon name="plus" size={12}/> {generating ? "Generating…" : `Generate ${genQty}`}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3 className="card-title">Today</h3></div>
            <div className="card-body vstack" style={{ gap: 10 }}>
              <HealthRow label="Issued" value={String(todayVouchers.length)}/>
              <HealthRow label="Unused" value={String(todayVouchers.filter(v => v.status === "unused").length)}/>
              <HealthRow label="Used" value={String(todayVouchers.filter(v => v.status === "deactivated").length)}/>
              <HealthRow label="Total vouchers" value={String(vouchers.length)}/>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

/* ───────── PLAN MODAL ───────── */
const EMPTY_PLAN = { name: "", hotspot_user_profile: "", duration_label: "", badge_label: "", note: "Valid for Wonke Connect hotspot access.", price: 0, active: true };

const PlanModal = ({ plan, profiles, onSave, onDelete, onClose }) => {
  const isNew = !plan.id;
  const [form, setForm] = useState({ ...EMPTY_PLAN, ...plan });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const url = isNew ? "/plans" : `/plans/${plan.id}`;
      const method = isNew ? "POST" : "PUT";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const d = await r.json();
      if (r.ok) { onSave(d.plan); onClose(); }
      else setErr(d.detail || "Save failed.");
    } catch { setErr("Network error."); }
    finally { setSaving(false); }
  };

  const del = async () => {
    setDeleting(true); setErr(null);
    try {
      const r = await fetch(`/plans/${plan.id}`, { method: "DELETE" });
      const d = await r.json();
      if (r.ok) { onDelete(plan.id, d.message); onClose(); }
      else setErr(d.detail || "Delete failed.");
    } catch { setErr("Network error."); }
    finally { setDeleting(false); }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.6)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center" }}
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:"var(--surface)", border:"1px solid var(--line)", borderRadius:"var(--r-lg)", width:480, maxHeight:"90vh", overflowY:"auto", boxShadow:"var(--shadow-md)" }}>
        <div className="card-head">
          <h3 className="card-title">{isNew ? "New plan" : "Edit plan"}</h3>
          <button className="btn ghost btn-sm" onClick={onClose}><Icon name="x" size={13}/></button>
        </div>
        <div className="card-body">
          {err && <div className="text-xs" style={{ color:"var(--red)", marginBottom:12 }}>{err}</div>}
          <div className="form-grid">
            <div className="field field-full">
              <label>Plan name</label>
              <input className="input" value={form.name} onChange={e => set("name", e.target.value)} placeholder="e.g. 1 Day Browse"/>
            </div>
            <div className="field field-full">
              <label>HotSpot profile</label>
              {profiles.length > 0
                ? <select className="select" value={form.hotspot_user_profile} onChange={e => set("hotspot_user_profile", e.target.value)}>
                    <option value="">— select profile —</option>
                    {profiles.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                : <input className="input mono" value={form.hotspot_user_profile} onChange={e => set("hotspot_user_profile", e.target.value)} placeholder="e.g. 1day"/>
              }
              <span className="hint">Must match exactly the profile name in MikroTik HotSpot.</span>
            </div>
            <div className="field">
              <label>Duration label</label>
              <input className="input" value={form.duration_label} onChange={e => set("duration_label", e.target.value)} placeholder="e.g. 24 hours"/>
            </div>
            <div className="field">
              <label>Badge label</label>
              <input className="input" value={form.badge_label} onChange={e => set("badge_label", e.target.value)} placeholder="e.g. 1DAY"/>
            </div>
            <div className="field">
              <label>Price (ZAR)</label>
              <input className="input" type="number" min="0" step="0.01" value={form.price} onChange={e => set("price", parseFloat(e.target.value) || 0)}/>
            </div>
            <div className="field" style={{ justifyContent:"flex-end" }}>
              <label className="switch" style={{ marginTop:18 }}>
                <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)}/>
                <span className="switch-track"/>
                <span>Active</span>
              </label>
            </div>
            <div className="field field-full">
              <label>Note</label>
              <input className="input" value={form.note} onChange={e => set("note", e.target.value)} placeholder="Shown on voucher / portal"/>
            </div>
          </div>
        </div>
        <div className="card-head" style={{ borderTop:"1px solid var(--line)", borderBottom:0, justifyContent:"flex-end", gap:8 }}>
          {!isNew && !confirmDel && (
            <button className="btn ghost btn-sm" style={{ color:"var(--red)", marginRight:"auto" }} onClick={() => setConfirmDel(true)}>Delete plan</button>
          )}
          {confirmDel && (
            <span className="text-xs" style={{ color:"var(--red)", marginRight:"auto" }}>
              Sure? <button className="btn ghost btn-sm" style={{ color:"var(--red)" }} onClick={del} disabled={deleting}>{deleting ? "Deleting…" : "Yes, delete"}</button>
              <button className="btn ghost btn-sm" onClick={() => setConfirmDel(false)}>Cancel</button>
            </span>
          )}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn brand" onClick={save} disabled={saving}>{saving ? "Saving…" : (isNew ? "Create plan" : "Save changes")}</button>
        </div>
      </div>
    </div>
  );
};

/* ───────── PLANS ───────── */
const Plans = () => {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState([]);
  const [modal, setModal] = useState(null); // null | plan object (empty = new)
  const [toast, setToast] = useState(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const load = () => {
    setLoading(true);
    fetch("/plans").then(r => r.ok ? r.json() : []).then(p => { setPlans(Array.isArray(p) ? p : []); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => {
    load();
    fetch("/hotspot/available-profiles").then(r => r.ok ? r.json() : {}).then(d => {
      if (d?.profiles) setProfiles(d.profiles.map(p => p.name || p).filter(Boolean));
    }).catch(() => {});
  }, []);

  const onSave = (plan) => {
    setPlans(ps => ps.some(p => p.id === plan.id) ? ps.map(p => p.id === plan.id ? plan : p) : [...ps, plan]);
    showToast("Plan saved.");
  };

  const onDelete = (id, msg) => {
    setPlans(ps => ps.filter(p => p.id !== id));
    showToast(msg || "Plan deleted.");
  };

  const active = plans.filter(p => p.active);

  return (
    <>
      {modal && <PlanModal plan={modal} profiles={profiles} onSave={onSave} onDelete={onDelete} onClose={() => setModal(null)}/>}
      {toast && (
        <div style={{ position:"fixed", bottom:24, right:24, background:"var(--surface)", border:"1px solid var(--line)", borderRadius:"var(--r-md)", padding:"10px 16px", fontSize:12.5, boxShadow:"var(--shadow-md)", zIndex:100, color:"var(--teal)" }}>
          {toast}
        </div>
      )}

      <div className="page-head">
        <div>
          <h1 className="page-title">Plans</h1>
          <p className="page-subtitle">Map every HotSpot user profile to a price, duration, and usage policy.</p>
        </div>
        <div className="page-actions">
          <button className="btn brand" onClick={() => setModal(EMPTY_PLAN)}><Icon name="plus" size={13}/> New plan</button>
        </div>
      </div>

      {loading
        ? <div className="card"><div className="empty">Loading…</div></div>
        : <>
            {active.length > 0 && (
              <div className="grid-3" style={{ gridTemplateColumns: `repeat(${Math.min(active.length, 3)}, 1fr)` }}>
                {active.slice(0, 3).map(p => <PlanCard key={p.id} plan={p} onEdit={() => setModal(p)}/>)}
              </div>
            )}

            <div className="card card-flush">
              <div className="card-head">
                <h3 className="card-title">All plans</h3>
                <p className="card-sub">{plans.length} total · {active.length} active</p>
              </div>
              {plans.length === 0
                ? <div className="empty">No plans yet. Click "New plan" to add one.</div>
                : <table className="tbl">
                    <thead>
                      <tr>
                        <th>Plan</th><th>Duration</th><th>HotSpot profile</th><th>Price</th><th>Status</th><th style={{width:40}}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {plans.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <div className="hstack">
                              <span className="badge" style={{background:"var(--brand-soft)",color:"var(--brand-ink)",borderColor:"rgba(196,74,6,0.18)"}}>{p.badge_label || p.hotspot_user_profile}</span>
                              <span className="fw-600">{p.name}</span>
                            </div>
                          </td>
                          <td>{p.duration_label || "—"}</td>
                          <td className="mono text-xs muted">{p.hotspot_user_profile}</td>
                          <td className="num fw-600">R{p.price}</td>
                          <td><Badge kind={p.active ? "active" : "used"}>{p.active ? "active" : "inactive"}</Badge></td>
                          <td><button className="btn ghost btn-sm" style={{padding:"2px 8px"}} onClick={() => setModal(p)}>Edit</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </div>
          </>
      }
    </>
  );
};

const PlanCard = ({ plan, onEdit }) => (
  <div className="card" style={{ cursor: onEdit ? "pointer" : "default" }} onClick={onEdit}>
    <div className="card-body">
      <div className="hstack" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <span className="badge" style={{background:"var(--brand-soft)",color:"var(--brand-ink)",borderColor:"rgba(196,74,6,0.18)"}}>{plan.badge_label || plan.hotspot_user_profile}</span>
        {onEdit && <span className="text-xs muted">Click to edit</span>}
      </div>
      <div className="fw-700 text-md" style={{ marginBottom: 4 }}>{plan.name}</div>
      <div className="text-xs muted" style={{ marginBottom: 14 }}>{plan.duration_label || "—"}</div>
      <div className="kpi-value" style={{ fontSize: 28 }}>R{plan.price}<span className="unit">/ voucher</span></div>
      <div style={{ height: 1, background: "var(--line)", margin: "14px 0" }}/>
      <div className="text-xs muted">{plan.note || ""}</div>
    </div>
  </div>
);

/* ───────── SESSIONS ───────── */
const Sessions = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch("/users/active")
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d?.users ? d : { total_active: 0, users: [] }); setLoading(false); })
      .catch(() => { setData({ total_active: 0, users: [] }); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const users = data?.users || [];
  const totalBytes = users.reduce((s, u) => s + (u.bytes_total || 0), 0);
  const totalDown = users.reduce((s, u) => s + (u.bytes_in || 0), 0);
  const totalUp = users.reduce((s, u) => s + (u.bytes_out || 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Live sessions</h1>
          <p className="page-subtitle">Real-time view of active HotSpot users from MikroTik.</p>
        </div>
        <div className="page-actions">
          <span className="status-chip"><span className="status-dot pulse"/>Live</span>
          <button className="btn" onClick={load}><Icon name="refresh" size={13}/> Refresh</button>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi label="Active sessions" value={String(data?.total_active ?? "—")} delta="live now" spark={[30,34,28,36,42,38,44,40,46,47]}/>
        <Kpi label="Total download" value={fmtBytes(totalDown)} delta="this session" spark={[60,72,80,68,96,112,124]}/>
        <Kpi label="Total upload" value={fmtBytes(totalUp)} delta="this session" spark={[20,25,28,24,34,38,42]}/>
        <Kpi label="Total bandwidth" value={fmtBytes(totalBytes)} delta="all users" spark={[40,42,48,56,62,68,60,52]}/>
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <h3 className="card-title">Active users</h3>
          <p className="card-sub">{data?.total_active ?? "—"} sessions · {fmtBytes(totalBytes)} total</p>
        </div>
        {loading
          ? <div className="empty">Loading from MikroTik…</div>
          : users.length === 0
            ? <div className="empty">No active sessions. Make sure MikroTik is reachable.</div>
            : <table className="tbl">
                <thead>
                  <tr>
                    <th>Voucher</th><th>Profile</th><th>Uptime</th><th>IP</th><th>MAC</th><th>↓ Download</th><th>↑ Upload</th><th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={i}>
                      <td className="code">{u.code}</td>
                      <td>{u.profile}</td>
                      <td className="mono text-xs">{u.uptime || "—"}</td>
                      <td className="mono text-xs muted">{u.address || "—"}</td>
                      <td className="mono text-xs muted">{u.mac_address || "—"}</td>
                      <td className="num">{fmtBytes(u.bytes_in)}</td>
                      <td className="num">{fmtBytes(u.bytes_out)}</td>
                      <td className="num fw-600">{fmtBytes(u.bytes_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
        }
      </div>
    </>
  );
};

/* ───────── SETTINGS ───────── */
const Settings = () => {
  const [mk, setMk] = useState({ host: "", username: "", password: "", port: 8728, use_ssl: false, plaintext_login: true });
  const [pf, setPf] = useState({ merchant_id: "", merchant_key: "", passphrase: "", server_url: "", sandbox: false, mikrotik_sync_api_key: "" });
  const [mkStatus, setMkStatus] = useState(null);
  const [mkTesting, setMkTesting] = useState(false);
  const [mkSaving, setMkSaving] = useState(false);
  const [mkMsg, setMkMsg] = useState(null);
  const [pfSaving, setPfSaving] = useState(false);
  const [pfMsg, setPfMsg] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/settings/mikrotik").then(r => r.json()).then(setMk).catch(() => {});
    fetch("/settings/payfast").then(r => r.json()).then(setPf).catch(() => {});
    fetch("/settings/mikrotik/test", { method: "POST" })
      .then(r => r.json()).then(setMkStatus)
      .catch(() => setMkStatus({ connected: false, message: "Unreachable" }));
  }, []);

  const testMk = async () => {
    setMkTesting(true); setMkStatus(null);
    const r = await fetch("/settings/mikrotik/test", { method: "POST" });
    const d = await r.json(); setMkStatus(d); setMkTesting(false);
  };

  const saveMk = async () => {
    setMkSaving(true); setMkMsg(null);
    try {
      const r = await fetch("/settings/mikrotik", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: mk.host, username: mk.username, password: mk.password, port: Number(mk.port), use_ssl: mk.use_ssl, plaintext_login: mk.plaintext_login }),
      });
      if (r.ok) { setMkMsg("Saved."); } else { const d = await r.json(); setMkMsg(d.detail || "Save failed."); }
    } catch { setMkMsg("Network error."); }
    finally { setMkSaving(false); }
  };

  const savePf = async () => {
    setPfSaving(true); setPfMsg(null);
    try {
      const r = await fetch("/settings/payfast", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant_id: pf.merchant_id, merchant_key: pf.merchant_key, passphrase: pf.passphrase, server_url: pf.server_url, sandbox: pf.sandbox, mikrotik_sync_api_key: pf.mikrotik_sync_api_key }),
      });
      if (r.ok) { const d = await r.json(); setPf(d); setPfMsg("Saved."); }
      else { const d = await r.json(); setPfMsg(d.detail || "Save failed."); }
    } catch { setPfMsg("Network error."); }
    finally { setPfSaving(false); }
  };

  const copyKey = () => {
    navigator.clipboard.writeText(pf.mikrotik_sync_api_key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const isOnline = mkStatus?.connected;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Router & integrations</h1>
          <p className="page-subtitle">MikroTik connection, payment provider, and sync credentials.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">MikroTik connection</h3>
              <p className="card-sub">RouterOS API · saved credentials</p>
            </div>
            {mkStatus
              ? <span className={`status-chip ${isOnline ? "" : "offline"}`}><span className={`status-dot ${isOnline ? "pulse" : ""}`}/>{isOnline ? "Online" : "Offline"}</span>
              : <span className="text-xs muted">Checking…</span>
            }
          </div>
          <div className="card-body">
            {mkMsg && <div className="text-xs" style={{ marginBottom: 12, color: mkMsg === "Saved." ? "var(--teal)" : "var(--red)" }}>{mkMsg}</div>}
            {mkStatus && <div className="text-xs" style={{ marginBottom: 12, color: isOnline ? "var(--teal)" : "var(--red)" }}>{mkStatus.message}</div>}
            <div className="form-grid">
              <div className="field"><label>Host / IP</label><input className="input mono" value={mk.host} onChange={e => setMk({...mk, host: e.target.value})}/></div>
              <div className="field"><label>API port</label><input className="input mono" type="number" value={mk.port} onChange={e => setMk({...mk, port: e.target.value})}/></div>
              <div className="field"><label>Username</label><input className="input" value={mk.username} onChange={e => setMk({...mk, username: e.target.value})}/></div>
              <div className="field"><label>Password</label><input className="input" type="password" value={mk.password} onChange={e => setMk({...mk, password: e.target.value})}/></div>
              <div className="field">
                <label className="switch"><input type="checkbox" checked={mk.use_ssl} onChange={e => setMk({...mk, use_ssl: e.target.checked})}/><span className="switch-track"/><span>Use SSL</span></label>
              </div>
              <div className="field">
                <label className="switch"><input type="checkbox" checked={mk.plaintext_login} onChange={e => setMk({...mk, plaintext_login: e.target.checked})}/><span className="switch-track"/><span>Plaintext login</span></label>
              </div>
              <div className="field field-full" style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <button className="btn primary" onClick={saveMk} disabled={mkSaving}>{mkSaving ? "Saving…" : "Save settings"}</button>
                <button className="btn" onClick={testMk} disabled={mkTesting}>{mkTesting ? "Testing…" : "Test connection"}</button>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">PayFast</h3>
              <p className="card-sub">Customer payment provider</p>
            </div>
            <span className={`badge ${pf.configured ? "active" : "used"}`}><span className="badge-dot"/>{pf.configured ? "Configured" : "Not set"}</span>
          </div>
          <div className="card-body">
            {pfMsg && <div className="text-xs" style={{ marginBottom: 12, color: pfMsg === "Saved." ? "var(--teal)" : "var(--red)" }}>{pfMsg}</div>}
            <div className="form-grid">
              <div className="field"><label>Merchant ID</label><input className="input mono" value={pf.merchant_id} onChange={e => setPf({...pf, merchant_id: e.target.value})}/></div>
              <div className="field"><label>Merchant key</label><input className="input mono" value={pf.merchant_key} onChange={e => setPf({...pf, merchant_key: e.target.value})}/></div>
              <div className="field field-full"><label>Passphrase</label><input className="input" type="password" value={pf.passphrase} onChange={e => setPf({...pf, passphrase: e.target.value})}/></div>
              <div className="field field-full">
                <label>Server URL</label>
                <input className="input mono text-xs" value={pf.server_url} onChange={e => setPf({...pf, server_url: e.target.value})}/>
                <span className="hint">PayFast posts payment notifications (ITN) to this URL.</span>
              </div>
              <div className="field">
                <label className="switch"><input type="checkbox" checked={pf.sandbox} onChange={e => setPf({...pf, sandbox: e.target.checked})}/><span className="switch-track"/><span>Sandbox mode</span></label>
              </div>
              <div className="field field-full" style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <button className="btn primary" onClick={savePf} disabled={pfSaving}>{pfSaving ? "Saving…" : "Save"}</button>
                <button className="btn ghost" onClick={() => window.open("/portal", "_blank")}>Open customer portal ↗</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title">MikroTik sync API key</h3>
            <p className="card-sub">Paste into your router's sync script · auto-generated on first save</p>
          </div>
        </div>
        <div className="card-body">
          <div className="hstack" style={{ gap: 8 }}>
            <input className="input mono flex-1" readOnly value={pf.mikrotik_sync_api_key || "(save PayFast settings to generate)"}/>
            <button className="btn" onClick={copyKey}>{copied ? "Copied!" : "Copy"}</button>
          </div>
          <p className="text-xs muted" style={{ marginTop: 8 }}>Keep this secret. Used by the router to mark vouchers as used.</p>
        </div>
      </div>
    </>
  );
};

const Placeholder = ({ title, desc }) => (
  <>
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{desc}</p>
      </div>
    </div>
    <div className="card"><div className="empty">This screen is part of the same system — layout matches Dashboard.</div></div>
  </>
);

Object.assign(window, { Vouchers, Plans, Sessions, Settings, Placeholder });
