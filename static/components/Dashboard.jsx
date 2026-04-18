/* global React */
const { useState, useEffect } = React;

/* ───────── HELPERS ───────── */
const fmtBytes = (b) => {
  if (!b || b === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + " " + units[i];
};

/* ───────── REVENUE CHART (static sparkline — no revenue endpoint) ───────── */
const RevenueChart = ({ voucherCounts }) => {
  const w = 680, h = 200, pad = 24;
  const data = voucherCounts.length >= 2 ? voucherCounts : [12,18,16,22,28,24,32,30,38,36,44,48,42,52];
  const max = Math.max(...data) || 60, min = 0, rng = max - min || 1;
  const xs = (i) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const ys = (v) => h - pad - ((v - min) / rng) * (h - pad * 2);
  const mkPath = (arr) => arr.map((v, i) => (i ? "L" : "M") + xs(i).toFixed(1) + "," + ys(v).toFixed(1)).join(" ");
  const mkArea = (arr) => mkPath(arr) + ` L ${xs(arr.length - 1)},${h - pad} L ${xs(0)},${h - pad} Z`;
  const days = data.map((_, i) => i % 4 === 0 ? `Day ${i+1}` : "");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <defs>
        <linearGradient id="gradBrand" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ff6a1a" stopOpacity="0.22"/>
          <stop offset="1" stopColor="#ff6a1a" stopOpacity="0"/>
        </linearGradient>
      </defs>
      {[0, Math.round(max*0.25), Math.round(max*0.5), Math.round(max*0.75), max].map((t, i) => (
        <g key={i}>
          <line x1={pad} x2={w-pad} y1={ys(t)} y2={ys(t)} stroke="var(--line)" strokeDasharray="2 3"/>
          <text x={8} y={ys(t)+3} fontSize="9" fill="var(--muted-2)" fontFamily="JetBrains Mono, monospace">{t}</text>
        </g>
      ))}
      <path d={mkArea(data)} fill="url(#gradBrand)"/>
      <path d={mkPath(data)} fill="none" stroke="#ff6a1a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      {data.map((v, i) => i === data.length - 1 && (
        <g key={i}>
          <circle cx={xs(i)} cy={ys(v)} r="5" fill="#ff6a1a" fillOpacity="0.2"/>
          <circle cx={xs(i)} cy={ys(v)} r="3" fill="#ff6a1a"/>
        </g>
      ))}
      {days.map((d, i) => d && <text key={i} x={xs(i)} y={h - 6} fontSize="9.5" fill="var(--muted)" textAnchor="middle">{d}</text>)}
    </svg>
  );
};

/* ───────── DASHBOARD ───────── */
const Dashboard = () => {
  const [stats, setStats] = useState(null);
  const [vouchers, setVouchers] = useState([]);
  const [activeSessions, setActiveSessions] = useState(null);
  const [routerStatus, setRouterStatus] = useState(null);
  const [routerSettings, setRouterSettings] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const loadData = () => {
    fetch("/stats").then(r => r.json()).then(setStats).catch(() => {});
    fetch("/vouchers?limit=8").then(r => r.json()).then(setVouchers).catch(() => {});
    fetch("/users/active").then(r => r.json()).then(setActiveSessions).catch(() => {});
    fetch("/settings/mikrotik").then(r => r.json()).then(setRouterSettings).catch(() => {});
    fetch("/settings/mikrotik/test", { method: "POST" })
      .then(r => r.json()).then(setRouterStatus).catch(() => setRouterStatus({ connected: false, message: "Unreachable" }));
  };

  useEffect(() => { loadData(); }, []);

  const syncMikrotik = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await fetch("/sync-status", { method: "POST" });
      const d = await r.json();
      setSyncMsg(d.message || "Synced.");
      loadData();
    } catch { setSyncMsg("Sync failed."); }
    finally { setSyncing(false); }
  };

  const totalVouchers = stats?.total ?? "—";
  const unusedVouchers = stats?.unused ?? "—";
  const usedVouchers = stats?.used ?? "—";
  const activeCount = activeSessions?.total_active ?? "—";
  const isOnline = routerStatus?.connected;

  const voucherSparkDummy = [8,12,11,16,20,17,22,21,26,25,30,33,29,36];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of voucher sales, active sessions, and router health.</p>
        </div>
        <div className="page-actions">
          {syncMsg && <span className="text-xs muted">{syncMsg}</span>}
          <button className="btn"><Icon name="refresh" size={13}/> {syncing ? "Syncing…" : "Sync MikroTik"}</button>
          <button className="btn brand" onClick={() => window.__wcSetScreen && window.__wcSetScreen("vouchers")}><Icon name="plus" size={13}/> New vouchers</button>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi feature label="Total vouchers" value={String(totalVouchers)} delta={`${unusedVouchers} unused`} spark={voucherSparkDummy}/>
        <Kpi label="Unused" value={String(unusedVouchers)} delta="available" spark={[8,10,12,11,14,16,15,18]}/>
        <Kpi label="Active sessions" value={String(activeCount)} delta="live now" spark={[30,34,28,36,42,38,44,40,46,47]}/>
        <Kpi label="Used / expired" value={String(usedVouchers)} delta="total" deltaDir="down" spark={[4,5,6,8,9,11,12]} sparkColor="#e1341a"/>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Voucher activity</h3>
              <p className="card-sub">Vouchers issued over time</p>
            </div>
            <div className="chart-legend">
              <span><span className="sw" style={{background:"#ff6a1a"}}/>Vouchers <span className="val">{totalVouchers}</span></span>
            </div>
          </div>
          <div className="chart-wrap"><RevenueChart voucherCounts={voucherSparkDummy}/></div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Router health</h3>
            {routerStatus
              ? <span className={`status-chip ${isOnline ? "" : "offline"}`}>
                  <span className={`status-dot ${isOnline ? "pulse" : ""}`}/>
                  {isOnline ? "Online" : "Offline"}
                </span>
              : <span className="text-xs muted">Checking…</span>
            }
          </div>
          <div className="card-body vstack" style={{ gap: 14 }}>
            <HealthRow label="Host" value={routerSettings?.host || "—"} mono/>
            <HealthRow label="API port" value={routerSettings ? String(routerSettings.port) : "—"} mono/>
            <HealthRow label="Username" value={routerSettings?.username || "—"}/>
            <HealthRow label="SSL" value={routerSettings ? (routerSettings.use_ssl ? "Enabled" : "Disabled") : "—"}/>
            <HealthRow label="Connection" value={routerStatus?.message || "—"} good={isOnline}/>
            <div>
              <div className="hstack" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <span className="text-xs muted fw-600" style={{ textTransform:"uppercase", letterSpacing:"0.05em" }}>Active sessions</span>
                <span className="text-xs mono fw-700">{activeCount}</span>
              </div>
              <div className="progress">
                <div className="progress-fill teal" style={{ width: activeSessions ? Math.min(100, (activeSessions.total_active / 120) * 100) + "%" : "0%" }}/>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Recent vouchers</h3>
              <p className="card-sub">Last 8 issued</p>
            </div>
            <button className="btn ghost btn-sm" onClick={() => window.__wcSetScreen && window.__wcSetScreen("vouchers")}>
              View all <Icon name="chevronRight" size={11}/>
            </button>
          </div>
          <div className="card-flush">
            {vouchers.length === 0
              ? <div className="empty">No vouchers yet.</div>
              : <table className="tbl">
                  <thead>
                    <tr>
                      <th>Code</th><th>Plan</th><th>Status</th><th>Created</th><th style={{textAlign:"right"}}>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr key={v.id}>
                        <td className="code">{v.code}</td>
                        <td>{v.plan_name || v.hotspot_user_profile}</td>
                        <td><Badge kind={v.status === "deactivated" ? "used" : v.status}>{v.status === "deactivated" ? "used" : v.status}</Badge></td>
                        <td className="muted text-xs">{v.created_at ? v.created_at.slice(0,16).replace("T"," ") : "—"}</td>
                        <td className="num" style={{textAlign:"right"}}>R{v.price ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
            }
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Active sessions</h3>
            <span className="status-chip"><span className="status-dot pulse"/>{activeCount} live</span>
          </div>
          <div className="feed">
            {activeSessions === null
              ? <div className="empty">Loading…</div>
              : activeSessions.users.length === 0
                ? <div className="empty">No active sessions.</div>
                : activeSessions.users.slice(0, 5).map((u, i) => (
                    <div className="feed-item" key={i}>
                      <div className="feed-avatar teal">{u.code.slice(0,2)}</div>
                      <div className="feed-body">
                        <span className="mono" style={{fontSize:11}}>{u.code}</span> · {u.profile}
                        <div className="feed-time">{u.address || "—"} · {fmtBytes(u.bytes_total)} used · up {u.uptime}</div>
                      </div>
                    </div>
                  ))
            }
          </div>
        </div>
      </div>

      <div className="grid-3">
        <MiniStat title="Total issued" value={String(totalVouchers)} sub="All time" bar={100}/>
        <MiniStat title="Currently unused" value={String(unusedVouchers)} sub="Available to sell" bar={stats ? Math.round((stats.unused / Math.max(stats.total,1)) * 100) : 0}/>
        <MiniStat title="Used / expired" value={String(usedVouchers)} sub="Deactivated" bar={stats ? Math.round((stats.used / Math.max(stats.total,1)) * 100) : 0} color="teal"/>
      </div>
    </>
  );
};

const HealthRow = ({ label, value, mono, good }) => (
  <div className="hstack" style={{ justifyContent: "space-between" }}>
    <span className="text-xs muted fw-600" style={{ textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</span>
    <span className={`text-sm fw-600 ${mono ? "mono" : ""}`} style={{ color: good ? "var(--teal)" : "var(--ink)" }}>{value}</span>
  </div>
);

const MiniStat = ({ title, value, sub, bar, color }) => (
  <div className="card">
    <div className="card-body">
      <div className="kpi-label" style={{ marginBottom: 8 }}>{title}</div>
      <div className="kpi-value" style={{ fontSize: 22, marginBottom: 10 }}>{value}</div>
      <div className="progress"><div className={`progress-fill ${color || ""}`} style={{ width: bar + "%" }}/></div>
      <div className="text-xs muted" style={{ marginTop: 8 }}>{sub}</div>
    </div>
  </div>
);

Object.assign(window, { Dashboard, RevenueChart, HealthRow, MiniStat, fmtBytes });
