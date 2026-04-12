from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import routeros_api
from database import get_settings

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"


def load_dotenv_file() -> None:
    if not ENV_PATH.exists():
        return

    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


class MikroTikConfigError(Exception):
    """Raised when required RouterOS connection settings are missing."""


class MikroTikConnectionError(Exception):
    """Raised when the RouterOS API call fails."""


@dataclass
class MikroTikSettings:
    host: str
    username: str
    password: str
    port: int = 8728
    use_ssl: bool = False
    plaintext_login: bool = True

    @classmethod
    def from_env(cls) -> "MikroTikSettings":
        load_dotenv_file()
        saved = get_settings(
            [
                "mikrotik_host",
                "mikrotik_username",
                "mikrotik_password",
                "mikrotik_port",
                "mikrotik_use_ssl",
                "mikrotik_plaintext_login",
            ]
        )
        host = os.getenv("MIKROTIK_HOST", saved.get("mikrotik_host", "")).strip()
        username = os.getenv("MIKROTIK_USERNAME", saved.get("mikrotik_username", "")).strip()
        password = os.getenv("MIKROTIK_PASSWORD", saved.get("mikrotik_password", ""))

        if not host or not username:
            raise MikroTikConfigError(
                "Save MikroTik host and username in Settings before using MikroTik sync."
            )

        return cls(
            host=host,
            username=username,
            password=password,
            port=int(os.getenv("MIKROTIK_PORT", saved.get("mikrotik_port", "8728"))),
            use_ssl=os.getenv("MIKROTIK_USE_SSL", saved.get("mikrotik_use_ssl", "false")).lower() == "true",
            plaintext_login=os.getenv(
                "MIKROTIK_PLAINTEXT_LOGIN",
                saved.get("mikrotik_plaintext_login", "true"),
            ).lower() == "true",
        )


class MikroTikClient:
    def __init__(self, settings: Optional[MikroTikSettings] = None) -> None:
        self.settings = settings or MikroTikSettings.from_env()
        self._pool: Optional[routeros_api.RouterOsApiPool] = None

    def __enter__(self) -> "MikroTikClient":
        try:
            self._pool = routeros_api.RouterOsApiPool(
                self.settings.host,
                username=self.settings.username,
                password=self.settings.password,
                port=self.settings.port,
                use_ssl=self.settings.use_ssl,
                plaintext_login=self.settings.plaintext_login,
            )
            return self
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Could not connect to MikroTik: {exc}") from exc

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._pool is not None:
            self._pool.disconnect()
            self._pool = None

    @property
    def api(self):
        if self._pool is None:
            raise MikroTikConnectionError("MikroTik client is not connected.")
        return self._pool.get_api()

    def create_hotspot_user(self, *, code: str, password: str, hotspot_user_profile: str) -> None:
        try:
            hotspot_users = self.api.get_resource("/ip/hotspot/user")
            existing = hotspot_users.get(name=code)
            if existing:
                hotspot_users.set(id=existing[0][".id"], password=password, profile=hotspot_user_profile)
            else:
                hotspot_users.add(name=code, password=password, profile=hotspot_user_profile)
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to create hotspot user '{code}': {exc}") from exc

    def create_hotspot_user_with_limits(
        self,
        *,
        code: str,
        password: str,
        hotspot_user_profile: str,
        rate_limit: Optional[str] = None,
        session_timeout: Optional[str] = None,
        idle_timeout: Optional[str] = None,
        limit_bytes_total: int = 0,
        limit_uptime: Optional[str] = None,
    ) -> None:
        """Create/update hotspot user with bandwidth and session limits.
        
        Note: rate_limit, session_timeout, and idle_timeout are profile-level settings
        and should be configured on the HotSpot User Profile, not individual users.
        Only limit_bytes_total and limit_uptime are valid per-user parameters.
        """
        try:
            hotspot_users = self.api.get_resource("/ip/hotspot/user")
            user_data = {
                "name": code,
                "password": password,
                "profile": hotspot_user_profile,
            }
            
            # Add per-user limits (these are the only valid user-level parameters)
            if limit_bytes_total > 0:
                user_data["limit-bytes-total"] = str(limit_bytes_total)
            if limit_uptime:
                user_data["limit-uptime"] = limit_uptime

            existing = hotspot_users.get(name=code)
            if existing:
                hotspot_users.set(id=existing[0][".id"], **user_data)
            else:
                hotspot_users.add(**user_data)
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to create hotspot user '{code}': {exc}") from exc

    def sync_hotspot_user_profile(self, *, hotspot_user_profile: str) -> None:
        try:
            profiles = self.api.get_resource("/ip/hotspot/user/profile")
            existing = profiles.get(name=hotspot_user_profile)
            if not existing:
                profiles.add(name=hotspot_user_profile)
            # Profile already exists — nothing to change.
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(
                f"Failed to sync HotSpot user profile '{hotspot_user_profile}': {exc}"
            ) from exc

    def configure_hotspot_profile(
        self,
        *,
        profile_name: str,
        rate_limit: Optional[str] = None,
        session_timeout: Optional[str] = None,
        idle_timeout: Optional[str] = None,
        keepalive_timeout: Optional[str] = None,
        login_by: Optional[str] = None,
    ) -> None:
        """Configure advanced HotSpot user profile settings."""
        try:
            profiles = self.api.get_resource("/ip/hotspot/user/profile")
            existing = profiles.get(name=profile_name)
            
            profile_data = {"name": profile_name}
            if rate_limit:
                profile_data["rate-limit"] = rate_limit
            if session_timeout:
                profile_data["session-timeout"] = session_timeout
            if idle_timeout:
                profile_data["idle-timeout"] = idle_timeout
            if keepalive_timeout:
                profile_data["keepalive-timeout"] = keepalive_timeout
            if login_by:
                profile_data["login-by"] = login_by

            if existing:
                profiles.set(id=existing[0][".id"], **profile_data)
            else:
                profiles.add(**profile_data)
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(
                f"Failed to configure HotSpot profile '{profile_name}': {exc}"
            ) from exc

    def add_walled_garden(
        self,
        *,
        dst_host: str,
        action: str = "allow",
        path: Optional[str] = None,
        method: Optional[str] = None,
    ) -> None:
        """Add walled garden rule for bypassing authentication on specific domains/paths."""
        try:
            walled_garden = self.api.get_resource("/ip/hotspot/walled-garden")
            rule_data = {"dst-host": dst_host, "action": action}
            if path:
                rule_data["path"] = path
            if method:
                rule_data["method"] = method
            walled_garden.add(**rule_data)
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to add walled garden rule for '{dst_host}': {exc}") from exc

    def add_ip_binding(
        self,
        *,
        src_address: str,
        mac_address: str,
        to_address: Optional[str] = None,
        binding_type: str = "regular",
    ) -> None:
        """Add IP binding for static NAT, bypass, or blocking."""
        try:
            ip_bindings = self.api.get_resource("/ip/hotspot/ip-binding")
            binding_data = {
                "address": src_address,
                "mac-address": mac_address,
                "type": binding_type,
            }
            if to_address:
                binding_data["to-address"] = to_address
            ip_bindings.add(**binding_data)
        except Exception as ex:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to add IP binding for '{src_address}': {ex}") from ex

    def disable_hotspot_user(self, *, code: str) -> None:
        """Disable/remove a hotspot user."""
        try:
            hotspot_users = self.api.get_resource("/ip/hotspot/user")
            existing = hotspot_users.get(name=code)
            if existing:
                hotspot_users.remove(id=existing[0][".id"])
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to disable hotspot user '{code}': {exc}") from exc

    def get_user_statistics(self, *, code: str) -> Optional[dict[str, Any]]:
        """Fetch bandwidth and session statistics for a specific user."""
        try:
            hotspot_users = self.api.get_resource("/ip/hotspot/user")
            users = hotspot_users.get(name=code)
            if users:
                return dict(users[0])
            return None
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to fetch statistics for user '{code}': {exc}") from exc

    def fetch_hotspot_users(self) -> list[dict[str, Any]]:
        try:
            return self.api.get_resource("/ip/hotspot/user").get()
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to fetch hotspot users: {exc}") from exc

    def fetch_active_users(self) -> list[dict[str, Any]]:
        try:
            return self.api.get_resource("/ip/hotspot/active").get()
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to fetch active hotspot users: {exc}") from exc

    def fetch_hotspot_profiles(self) -> list[dict[str, Any]]:
        """Fetch all available HotSpot user profiles from the router."""
        try:
            profiles = self.api.get_resource("/ip/hotspot/user/profile").get()
            return profiles if profiles else []
        except Exception as exc:  # pragma: no cover - depends on device/network
            raise MikroTikConnectionError(f"Failed to fetch hotspot profiles: {exc}") from exc


def create_hotspot_user(*, code: str, password: str, hotspot_user_profile: str) -> None:
    with MikroTikClient() as client:
        client.create_hotspot_user(
            code=code,
            password=password,
            hotspot_user_profile=hotspot_user_profile,
        )


def sync_hotspot_user_profile(*, hotspot_user_profile: str) -> None:
    with MikroTikClient() as client:
        client.sync_hotspot_user_profile(hotspot_user_profile=hotspot_user_profile)


def get_hotspot_usage() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with MikroTikClient() as client:
        return client.fetch_hotspot_users(), client.fetch_active_users()


def get_available_hotspot_profiles() -> list[str]:
    """Fetch available HotSpot profiles from MikroTik router."""
    try:
        with MikroTikClient() as client:
            profiles = client.fetch_hotspot_profiles()
            return [profile.get("name", "") for profile in profiles if profile.get("name")]
    except (MikroTikConfigError, MikroTikConnectionError):
        return []


def test_connection() -> None:
    with MikroTikClient() as client:
        client.fetch_hotspot_users()


def create_hotspot_user_with_limits(
    *,
    code: str,
    password: str,
    hotspot_user_profile: str,
    rate_limit: Optional[str] = None,
    session_timeout: Optional[str] = None,
    idle_timeout: Optional[str] = None,
    limit_bytes_total: int = 0,
    limit_uptime: Optional[str] = None,
) -> None:
    with MikroTikClient() as client:
        client.create_hotspot_user_with_limits(
            code=code,
            password=password,
            hotspot_user_profile=hotspot_user_profile,
            rate_limit=rate_limit,
            session_timeout=session_timeout,
            idle_timeout=idle_timeout,
            limit_bytes_total=limit_bytes_total,
            limit_uptime=limit_uptime,
        )


def configure_hotspot_profile(
    *,
    profile_name: str,
    rate_limit: Optional[str] = None,
    session_timeout: Optional[str] = None,
    idle_timeout: Optional[str] = None,
    keepalive_timeout: Optional[str] = None,
    login_by: Optional[str] = None,
) -> None:
    with MikroTikClient() as client:
        client.configure_hotspot_profile(
            profile_name=profile_name,
            rate_limit=rate_limit,
            session_timeout=session_timeout,
            idle_timeout=idle_timeout,
            keepalive_timeout=keepalive_timeout,
            login_by=login_by,
        )


def add_walled_garden(
    *,
    dst_host: str,
    action: str = "allow",
    path: Optional[str] = None,
    method: Optional[str] = None,
) -> None:
    with MikroTikClient() as client:
        client.add_walled_garden(dst_host=dst_host, action=action, path=path, method=method)


def add_ip_binding(
    *,
    src_address: str,
    mac_address: str,
    to_address: Optional[str] = None,
    binding_type: str = "regular",
) -> None:
    with MikroTikClient() as client:
        client.add_ip_binding(
            src_address=src_address,
            mac_address=mac_address,
            to_address=to_address,
            binding_type=binding_type,
        )


def disable_hotspot_user(*, code: str) -> None:
    with MikroTikClient() as client:
        client.disable_hotspot_user(code=code)


def get_user_statistics(*, code: str) -> Optional[dict[str, Any]]:
    with MikroTikClient() as client:
        return client.get_user_statistics(code=code)
