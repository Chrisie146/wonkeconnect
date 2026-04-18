/* global React */
const { useState, useEffect, useMemo } = React;

/* ───────── ICONS ───────── */
const Icon = ({ name, className = "", size = 16 }) => {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    ticket: <><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M9 7v10" strokeDasharray="2 2"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></>,
    pulse: <path d="M3 12h4l3-9 4 18 3-9h4"/>,
    router: <><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 17h.01M11 17h.01"/><path d="M12 13V7"/><path d="M8 7a4 4 0 0 1 8 0"/><path d="M5 4a7 7 0 0 1 14 0"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    credit: <><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></>,
    bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></>,
    refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></>,
    more: <><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></>,
    chevronDown: <path d="m6 9 6 6 6-6"/>,
    chevronRight: <path d="m9 6 6 6-6 6"/>,
    arrowUp: <><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></>,
    arrowDown: <><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></>,
    check: <path d="M20 6 9 17l-5-5"/>,
    x: <><path d="M18 6 6 18"/><path d="M6 6l12 12"/></>,
    wifi: <><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M12 20h.01"/><path d="M2 9a15 15 0 0 1 20 0"/></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></>,
    help: <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 7.15-7.15"/><path d="m18 8 3-3"/><path d="m15 5 3-3"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {paths[name]}
    </svg>
  );
};

/* ───────── BRAND LOGO ───────── */
const BrandLogo = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M3 14c2.5-4 6-6 9-6s6.5 2 9 6" stroke="white" strokeWidth="2" strokeLinecap="round"/>
    <path d="M7 18c1.5-2 3-3 5-3s3.5 1 5 3" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.6"/>
    <circle cx="12" cy="20" r="1.6" fill="white"/>
  </svg>
);

/* ───────── SIDEBAR ───────── */
const Sidebar = ({ active, setActive }) => {
  const items = [
    { id: "dashboard", label: "Dashboard", icon: "grid" },
    { id: "vouchers",  label: "Vouchers",  icon: "ticket", badge: "24" },
    { id: "plans",     label: "Plans",     icon: "layers" },
    { id: "sessions",  label: "Sessions",  icon: "pulse" },
    { id: "customers", label: "Customers", icon: "users" },
    { id: "payments",  label: "Payments",  icon: "credit" },
  ];
  const settings = [
    { id: "router",   label: "Router",    icon: "router" },
    { id: "billing",  label: "Billing",   icon: "credit" },
    { id: "api",      label: "API keys",  icon: "key" },
    { id: "settings", label: "Settings",  icon: "settings" },
  ];

  return (
    <aside className="side">
      <div className="side-brand">
        <div className="side-logo"><BrandLogo/></div>
        <div className="side-wordmark">
          <span className="w1">Wonke Connect</span>
          <span className="w2">Operator</span>
        </div>
      </div>

      <div className="side-section-label">Workspace</div>
      <nav className="side-nav">
        {items.map(it => (
          <button key={it.id} className={`nav-item ${active === it.id ? "active" : ""}`} onClick={() => setActive(it.id)}>
            <Icon name={it.icon} className="nav-icon"/>
            <span className="nav-label">{it.label}</span>
            {it.badge && <span className="nav-badge">{it.badge}</span>}
          </button>
        ))}
      </nav>

      <div className="side-section-label">Setup</div>
      <nav className="side-nav">
        {settings.map(it => (
          <button key={it.id} className={`nav-item ${active === it.id ? "active" : ""}`} onClick={() => setActive(it.id)}>
            <Icon name={it.icon} className="nav-icon"/>
            <span className="nav-label">{it.label}</span>
          </button>
        ))}
      </nav>

      <div className="side-footer">
        <button className="side-org">
          <div className="side-org-avatar">BC</div>
          <div className="side-org-info">
            <div className="side-org-name">Blue Crane Café</div>
            <div className="side-org-plan">Pro plan · Stellenbosch</div>
          </div>
          <Icon name="chevronDown" className="side-org-caret" size={13}/>
        </button>
      </div>
    </aside>
  );
};

/* ───────── TOPBAR ───────── */
const Topbar = ({ crumb }) => (
  <header className="topbar">
    <div className="crumb">
      <span>{crumb[0]}</span>
      <span className="sep">/</span>
      <span className="cur">{crumb[1]}</span>
    </div>
    <div className="topbar-spacer"/>
    <div className="topbar-search">
      <Icon name="search" size={13}/>
      <span>Search vouchers, users, plans…</span>
      <span className="kbd">⌘K</span>
    </div>
    <div className="status-chip">
      <span className="status-dot pulse"/> Router online
    </div>
    <button className="icon-btn" aria-label="Notifications"><Icon name="bell" size={14}/></button>
    <button className="icon-btn" aria-label="Help"><Icon name="help" size={14}/></button>
    <div className="avatar-sm">TM</div>
  </header>
);

/* ───────── SPARKLINES ───────── */
const Sparkline = ({ data, color = "#ff6a1a", fill = true, height = 34 }) => {
  const w = 180;
  const h = height;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / rng) * (h - 4) - 2;
    return [x, y];
  });
  const path = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = `${path} L ${w},${h} L 0,${h} Z`;
  return (
    <svg className="kpi-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {fill && <path d={area} fill={color} opacity="0.14"/>}
      <path d={path} className="stroke" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
};

/* ───────── KPI ───────── */
const Kpi = ({ label, value, unit, delta, deltaDir = "up", spark, sparkColor, feature }) => (
  <div className={`kpi ${feature ? "tile-feature" : ""}`}>
    <div className="kpi-label">{label}</div>
    <div className="kpi-value">{value}{unit && <span className="unit">{unit}</span>}</div>
    <div className={`kpi-delta ${deltaDir === "down" ? "down" : ""}`}>
      <Icon name={deltaDir === "down" ? "arrowDown" : "arrowUp"} size={11}/>
      {delta}<span className="vs">vs last 7d</span>
    </div>
    {spark && <Sparkline data={spark} color={sparkColor || "#ff6a1a"}/>}
  </div>
);

/* ───────── STATUS BADGE ───────── */
const Badge = ({ kind = "used", children }) => (
  <span className={`badge ${kind}`}>
    <span className="badge-dot"/>
    {children}
  </span>
);

/* export */
Object.assign(window, { Icon, Sidebar, Topbar, Sparkline, Kpi, Badge, BrandLogo });
