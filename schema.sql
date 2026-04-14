CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    profile TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused', 'used', 'expired', 'deactivated')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    deactivated_at TEXT,
    rate_limit TEXT,
    session_timeout TEXT,
    idle_timeout TEXT,
    limit_bytes_total INTEGER DEFAULT 0,
    limit_uptime TEXT
);

CREATE TABLE IF NOT EXISTS hotspot_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    rate_limit TEXT,
    session_timeout TEXT,
    idle_timeout TEXT,
    keepalive_timeout TEXT,
    login_by TEXT DEFAULT 'http-chap,cookie',
    advertise INTEGER DEFAULT 0,
    transparent_proxy INTEGER DEFAULT 1,
    limit_bytes_default INTEGER DEFAULT 0,
    mac_cookie_timeout TEXT DEFAULT '3d',
    on_login TEXT,
    on_logout TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS walled_garden (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name TEXT NOT NULL,
    dst_host TEXT NOT NULL,
    path TEXT,
    action TEXT DEFAULT 'allow' CHECK(action IN ('allow', 'deny')),
    method TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_name, dst_host, path)
);

CREATE TABLE IF NOT EXISTS ip_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name TEXT NOT NULL,
    src_address TEXT NOT NULL,
    mac_address TEXT,
    to_address TEXT,
    type TEXT DEFAULT 'regular' CHECK(type IN ('regular', 'bypassed', 'blocked')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    profile TEXT NOT NULL UNIQUE,
    duration_label TEXT NOT NULL,
    badge_label TEXT NOT NULL,
    note TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    m_payment_id TEXT NOT NULL UNIQUE,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    buyer_name_first TEXT NOT NULL,
    buyer_name_last TEXT NOT NULL,
    buyer_phone TEXT,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'complete', 'failed', 'cancelled')),
    voucher_id INTEGER REFERENCES vouchers(id),
    pf_payment_id TEXT,
    payment_method TEXT NOT NULL DEFAULT 'payfast',
    netcash_order_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_profile ON vouchers(profile);
CREATE INDEX IF NOT EXISTS idx_vouchers_created_at ON vouchers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_active ON plans(active);
CREATE INDEX IF NOT EXISTS idx_orders_m_payment_id ON orders(m_payment_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_hotspot_profiles_name ON hotspot_profiles(name);
CREATE INDEX IF NOT EXISTS idx_walled_garden_profile ON walled_garden(profile_name);
CREATE INDEX IF NOT EXISTS idx_ip_bindings_profile ON ip_bindings(profile_name);
