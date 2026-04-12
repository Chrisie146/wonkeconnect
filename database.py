from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

BASE_DIR = Path(__file__).resolve().parent
# Allow overriding the DB path via env var (useful for Railway persistent disk)
_db_env = os.getenv("DATABASE_PATH")
DATABASE_PATH = Path(_db_env) if _db_env else BASE_DIR / "wonke_connect.db"
SCHEMA_PATH = BASE_DIR / "schema.sql"


@contextmanager
def get_connection() -> Iterable[sqlite3.Connection]:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def init_db() -> None:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with get_connection() as connection:
        connection.executescript(schema)
        # Run migrations for existing databases
        apply_migrations(connection)
        connection.executemany(
            """
            INSERT OR IGNORE INTO plans (name, profile, duration_label, badge_label, note, active)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("Starter", "1hr", "1 hour", "1HR", "Fast hotspot access. Valid for in-store WiFi use.", 1),
                ("Day Pass", "1day", "1 day", "1 DAY", "All-day hotspot access for customers in the area.", 1),
                ("Data Pass", "1GB", "1 GB", "1 GB", "Data-based hotspot access with a 1 GB allowance.", 1),
                ("Weekly Pass", "1week", "1 week", "1 WEEK", "Extended hotspot access for regular customers.", 1),
            ],
        )


def apply_migrations(connection: sqlite3.Connection) -> None:
    """Apply schema migrations to existing databases."""
    cursor = connection.cursor()
    
    # Check if vouchers table needs migration
    try:
        cursor.execute("SELECT expires_at FROM vouchers LIMIT 1")
        # If this succeeds, the column exists
    except sqlite3.OperationalError:
        # Column doesn't exist, need to migrate the table
        # Backup existing data
        cursor.execute("""
            CREATE TABLE vouchers_backup AS 
            SELECT id, code, password, profile, status, created_at 
            FROM vouchers
        """)
        
        # Drop old table
        cursor.execute("DROP TABLE vouchers")
        
        # Create new table with full schema
        cursor.executescript("""
            CREATE TABLE vouchers (
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
            
            CREATE INDEX idx_vouchers_status ON vouchers(status);
            CREATE INDEX idx_vouchers_profile ON vouchers(profile);
            CREATE INDEX idx_vouchers_created_at ON vouchers(created_at DESC);
        """)
        
        # Restore data
        cursor.execute("""
            INSERT INTO vouchers 
            (id, code, password, profile, status, created_at)
            SELECT id, code, password, profile, status, created_at 
            FROM vouchers_backup
        """)
        
        # Drop backup
        cursor.execute("DROP TABLE vouchers_backup")
        connection.commit()
    
    # Check if hotspot_profiles table exists (added in Phase 2)
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='hotspot_profiles'"
    )
    if not cursor.fetchone():
        cursor.executescript("""
            CREATE TABLE hotspot_profiles (
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
            
            CREATE TABLE walled_garden (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_name TEXT NOT NULL,
                dst_host TEXT NOT NULL,
                path TEXT,
                action TEXT DEFAULT 'allow' CHECK(action IN ('allow', 'deny')),
                method TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(profile_name, dst_host, path)
            );
            
            CREATE TABLE ip_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_name TEXT NOT NULL,
                src_address TEXT NOT NULL,
                mac_address TEXT,
                to_address TEXT,
                type TEXT DEFAULT 'regular' CHECK(type IN ('regular', 'bypassed', 'blocked')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX idx_hotspot_profiles_name ON hotspot_profiles(name);
            CREATE INDEX idx_walled_garden_profile ON walled_garden(profile_name);
            CREATE INDEX idx_ip_bindings_profile ON ip_bindings(profile_name);
        """)
        connection.commit()

    # Add price column to plans if missing
    try:
        cursor.execute("SELECT price FROM plans LIMIT 1")
    except sqlite3.OperationalError:
        cursor.execute("ALTER TABLE plans ADD COLUMN price REAL NOT NULL DEFAULT 0")
        connection.commit()

    # Create orders table if missing
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='orders'"
    )
    if not cursor.fetchone():
        cursor.executescript("""
            CREATE TABLE orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                m_payment_id TEXT NOT NULL UNIQUE,
                plan_id INTEGER NOT NULL REFERENCES plans(id),
                buyer_name_first TEXT NOT NULL,
                buyer_name_last TEXT NOT NULL,
                buyer_phone TEXT,
                amount REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'complete', 'failed', 'cancelled')),
                voucher_id INTEGER REFERENCES vouchers(id),
                pf_payment_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX idx_orders_m_payment_id ON orders(m_payment_id);
            CREATE INDEX idx_orders_status ON orders(status);
        """)
        connection.commit()

    # Add mikrotik_synced column to vouchers if missing
    try:
        cursor.execute("SELECT mikrotik_synced FROM vouchers LIMIT 1")
    except sqlite3.OperationalError:
        cursor.execute("ALTER TABLE vouchers ADD COLUMN mikrotik_synced INTEGER NOT NULL DEFAULT 0")
        connection.commit()


def fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with get_connection() as connection:
        rows = connection.execute(query, params).fetchall()
        return [dict(row) for row in rows]


def fetch_one(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with get_connection() as connection:
        row = connection.execute(query, params).fetchone()
        return dict(row) if row else None


def execute(query: str, params: tuple[Any, ...] = ()) -> int:
    with get_connection() as connection:
        cursor = connection.execute(query, params)
        return cursor.lastrowid


def executemany(query: str, params: list[tuple[Any, ...]]) -> None:
    with get_connection() as connection:
        connection.executemany(query, params)


def get_settings(keys: list[str]) -> dict[str, str]:
    if not keys:
        return {}

    placeholders = ",".join("?" for _ in keys)
    with get_connection() as connection:
        rows = connection.execute(
            f"SELECT key, value FROM app_settings WHERE key IN ({placeholders})",
            tuple(keys),
        ).fetchall()
        return {str(row["key"]): str(row["value"]) for row in rows}


def set_settings(settings: dict[str, str]) -> None:
    if not settings:
        return

    with get_connection() as connection:
        connection.executemany(
            """
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            """,
            [(key, value) for key, value in settings.items()],
        )
