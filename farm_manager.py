"""
Local Phone Farm Manager - Phase 18

Run:
    py -3 farm_manager.py

This is a local-only ADB desktop controller. It intentionally starts small:
device discovery, basic health details, thumbnail grid, batch actions,
health checks, screenshots, APK install, and optional scrcpy launch for
manual control.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from tkinter import filedialog, messagebox
from typing import Any, Callable

try:
    import tkinter as tk
    from tkinter import ttk
except Exception as exc:  # pragma: no cover - only used when Tk is missing.
    raise SystemExit("Tkinter is required to run Farm Manager.") from exc


APP_NAME = "Farm Manager"
APP_VERSION = "0.18.0"
CONFIG_NAME = "farm_manager_config.json"
DEVICE_STATE_NAME = "farm_manager_devices.json"
EVENT_DB_NAME = "farm_manager_events.sqlite3"
APK_LIBRARY_DIR_NAME = "apk-library"
BACKUP_DIR_NAME = "backups"
NODE_SNAPSHOT_DIR_NAME = "node-snapshots"
DASHBOARD_DIR_NAME = "dashboard"
DEFAULT_COMMAND_TIMEOUT_SECONDS = 12
DEFAULT_THUMBNAIL_INTERVAL_SECONDS = 8
DEFAULT_AUTO_SCAN_INTERVAL_SECONDS = 15
DEFAULT_LOW_BATTERY_PERCENT = 20
DEFAULT_HIGH_TEMP_C = 42.0
DEFAULT_SETUP_TIMEOUT_MINUTES = 30
DEFAULT_SETUP_BRIGHTNESS = 120
THUMBNAIL_MAX_WIDTH = 170
THUMBNAIL_MAX_HEIGHT = 260
POLICY_MODE_LABELS = {
    "assisted": "Assisted allowed",
    "manual_only": "Manual only",
    "blocked": "Blocked / protected",
}
POLICY_LABEL_TO_MODE = {label: key for key, label in POLICY_MODE_LABELS.items()}
WORKFLOW_COMMANDS = {"wait", "keyevent", "open", "text", "screenshot", "back", "home", "recent", "wake", "sleep"}
WORKFLOW_KEY_ALIASES = {
    "back": "KEYCODE_BACK",
    "home": "KEYCODE_HOME",
    "recent": "KEYCODE_APP_SWITCH",
    "wake": "KEYCODE_WAKEUP",
    "sleep": "KEYCODE_SLEEP",
}
SCRCPY_PROFILES: dict[str, dict[str, Any]] = {
    "Low bandwidth": {"max_size": 720, "max_fps": 15, "bit_rate": "1M"},
    "Balanced": {"max_size": 1024, "max_fps": 30, "bit_rate": "2M"},
    "Quality": {"max_size": 1280, "max_fps": 60, "bit_rate": "4M"},
}
THEMES: dict[str, dict[str, str]] = {
    "dark": {
        "COLOR_BG": "#0a0d16",
        "COLOR_PANEL": "#121726",
        "COLOR_PANEL_ALT": "#1a2033",
        "COLOR_BORDER": "#262d44",
        "COLOR_TEXT": "#eef1f8",
        "COLOR_MUTED": "#8891a8",
        "COLOR_ACCENT": "#f5a524",
        "COLOR_ACCENT_SOFT": "#33270f",
        "COLOR_ACCENT_HOVER": "#ffbe55",
        "COLOR_ACCENT_TEXT": "#1a1203",
        "COLOR_SUCCESS": "#3ddc97",
        "COLOR_SUCCESS_SOFT": "#10291f",
        "COLOR_WARNING": "#f7c948",
        "COLOR_WARNING_SOFT": "#33290d",
        "COLOR_DANGER": "#ff6b6b",
        "COLOR_DANGER_SOFT": "#33161a",
        "COLOR_DARK": "#05070d",
        "COLOR_HEADER_BG": "#121726",
        "COLOR_SASH": "#0a0d16",
        "COLOR_NAV_BG": "#0a0d16",
        "COLOR_FIELD": "#0d1120",
        "COLOR_TAG_ONLINE_BG": "#10291f",
        "COLOR_TAG_OFFLINE_BG": "#1a2033",
    },
    "light": {
        "COLOR_BG": "#f3f4f8",
        "COLOR_PANEL": "#ffffff",
        "COLOR_PANEL_ALT": "#f3f5f9",
        "COLOR_BORDER": "#e1e4ec",
        "COLOR_TEXT": "#141824",
        "COLOR_MUTED": "#6b7386",
        "COLOR_ACCENT": "#f5a524",
        "COLOR_ACCENT_SOFT": "#fdf0d9",
        "COLOR_ACCENT_HOVER": "#e2930f",
        "COLOR_ACCENT_TEXT": "#1a1203",
        "COLOR_SUCCESS": "#0f8a5f",
        "COLOR_SUCCESS_SOFT": "#e1f5ec",
        "COLOR_WARNING": "#a16207",
        "COLOR_WARNING_SOFT": "#fdf3d7",
        "COLOR_DANGER": "#c62828",
        "COLOR_DANGER_SOFT": "#fde7e7",
        "COLOR_DARK": "#0f1420",
        "COLOR_HEADER_BG": "#ffffff",
        "COLOR_SASH": "#f3f4f8",
        "COLOR_NAV_BG": "#f3f4f8",
        "COLOR_FIELD": "#f8f9fc",
        "COLOR_TAG_ONLINE_BG": "#e1f5ec",
        "COLOR_TAG_OFFLINE_BG": "#f3f5f9",
    },
}
DEFAULT_THEME = "dark"
COLOR_BG = THEMES[DEFAULT_THEME]["COLOR_BG"]
COLOR_PANEL = THEMES[DEFAULT_THEME]["COLOR_PANEL"]
COLOR_PANEL_ALT = THEMES[DEFAULT_THEME]["COLOR_PANEL_ALT"]
COLOR_BORDER = THEMES[DEFAULT_THEME]["COLOR_BORDER"]
COLOR_TEXT = THEMES[DEFAULT_THEME]["COLOR_TEXT"]
COLOR_MUTED = THEMES[DEFAULT_THEME]["COLOR_MUTED"]
COLOR_ACCENT = THEMES[DEFAULT_THEME]["COLOR_ACCENT"]
COLOR_ACCENT_SOFT = THEMES[DEFAULT_THEME]["COLOR_ACCENT_SOFT"]
COLOR_ACCENT_HOVER = THEMES[DEFAULT_THEME]["COLOR_ACCENT_HOVER"]
COLOR_ACCENT_TEXT = THEMES[DEFAULT_THEME]["COLOR_ACCENT_TEXT"]
COLOR_SUCCESS = THEMES[DEFAULT_THEME]["COLOR_SUCCESS"]
COLOR_SUCCESS_SOFT = THEMES[DEFAULT_THEME]["COLOR_SUCCESS_SOFT"]
COLOR_WARNING = THEMES[DEFAULT_THEME]["COLOR_WARNING"]
COLOR_WARNING_SOFT = THEMES[DEFAULT_THEME]["COLOR_WARNING_SOFT"]
COLOR_DANGER = THEMES[DEFAULT_THEME]["COLOR_DANGER"]
COLOR_DANGER_SOFT = THEMES[DEFAULT_THEME]["COLOR_DANGER_SOFT"]
COLOR_DARK = THEMES[DEFAULT_THEME]["COLOR_DARK"]
COLOR_HEADER_BG = THEMES[DEFAULT_THEME]["COLOR_HEADER_BG"]
COLOR_SASH = THEMES[DEFAULT_THEME]["COLOR_SASH"]
COLOR_NAV_BG = THEMES[DEFAULT_THEME]["COLOR_NAV_BG"]
COLOR_FIELD = THEMES[DEFAULT_THEME]["COLOR_FIELD"]
COLOR_TAG_ONLINE_BG = THEMES[DEFAULT_THEME]["COLOR_TAG_ONLINE_BG"]
COLOR_TAG_OFFLINE_BG = THEMES[DEFAULT_THEME]["COLOR_TAG_OFFLINE_BG"]


def apply_theme(name: str) -> str:
    """Point the module COLOR_* names at the given palette. Returns the theme actually applied."""
    if name not in THEMES:
        name = DEFAULT_THEME
    globals().update(THEMES[name])
    return name


def app_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = app_base_dir()
CONFIG_FILE = BASE_DIR / CONFIG_NAME
DEVICE_STATE_FILE = BASE_DIR / DEVICE_STATE_NAME
EVENT_DB_FILE = BASE_DIR / EVENT_DB_NAME


def load_config() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_config(data: dict[str, Any]) -> None:
    CONFIG_FILE.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def load_device_state() -> dict[str, Any]:
    if not DEVICE_STATE_FILE.exists():
        return {"devices": {}}
    try:
        data = json.loads(DEVICE_STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("devices"), dict):
            return data
    except Exception:
        pass
    return {"devices": {}}


def save_device_state(data: dict[str, Any]) -> None:
    DEVICE_STATE_FILE.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def resolve_tool_path(tool_name: str, configured_path: str | None = None) -> str | None:
    if configured_path:
        path = Path(configured_path).expanduser()
        if path.exists():
            return str(path)

    from_path = shutil.which(tool_name)
    if from_path:
        return from_path

    candidates: list[Path] = []
    for env_name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        sdk_root = os.getenv(env_name)
        if sdk_root:
            candidates.append(Path(sdk_root) / "platform-tools" / f"{tool_name}.exe")
            candidates.append(Path(sdk_root) / "platform-tools" / tool_name)

    if tool_name == "adb":
        candidates.append(BASE_DIR.parent / "tools" / "android-sdk" / "platform-tools" / "adb.exe")
        candidates.append(BASE_DIR.parent / "tools" / "android-sdk" / "platform-tools" / "adb")
    elif tool_name == "scrcpy":
        candidates.append(BASE_DIR.parent / "tools" / "scrcpy" / "scrcpy.exe")
        candidates.append(BASE_DIR / "scrcpy" / "scrcpy.exe")

    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        candidates.append(Path(local_app_data) / "Android" / "Sdk" / "platform-tools" / f"{tool_name}.exe")

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def now_stamp() -> str:
    return time.strftime("%H:%M:%S")


def file_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def safe_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return safe or "node"


def parse_percent(value: str) -> int | None:
    digits = "".join(ch for ch in value if ch.isdigit())
    if not digits:
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def parse_temperature_c(value: str) -> float | None:
    cleaned = value.replace("C", "").replace("c", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


class EventStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._ready = False
        self._init_db()

    def _init_db(self) -> None:
        try:
            with sqlite3.connect(self.path) as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        created_at TEXT NOT NULL,
                        level TEXT NOT NULL,
                        message TEXT NOT NULL,
                        serial TEXT,
                        category TEXT
                    )
                    """
                )
                conn.execute("CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_events_serial ON events(serial)")
            self._ready = True
        except sqlite3.Error:
            self._ready = False

    def log(self, message: str, *, level: str = "info", serial: str | None = None, category: str | None = None) -> None:
        if not self._ready:
            return
        try:
            with self._lock, sqlite3.connect(self.path) as conn:
                conn.execute(
                    "INSERT INTO events (created_at, level, message, serial, category) VALUES (?, ?, ?, ?, ?)",
                    (time.strftime("%Y-%m-%d %H:%M:%S"), level, message, serial, category),
                )
        except sqlite3.Error:
            pass


@dataclass
class DeviceInfo:
    serial: str
    status: str
    raw: str = ""
    model: str = ""
    product: str = ""
    android: str = ""
    sdk: str = ""
    battery: str = ""
    charging: str = ""
    temperature: str = ""
    last_seen: float = field(default_factory=time.time)

    @property
    def online(self) -> bool:
        return self.status == "device"

    @property
    def display_status(self) -> str:
        if self.status == "device":
            return "online"
        return self.status or "unknown"


@dataclass(frozen=True)
class WorkflowStep:
    line_no: int
    command: str
    argument: str = ""


def parse_workflow_text(text: str) -> list[WorkflowStep]:
    steps: list[WorkflowStep] = []
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        command, _, argument = line.partition(" ")
        command = command.lower().strip()
        argument = argument.strip()
        if command not in WORKFLOW_COMMANDS:
            raise ValueError(f"Line {line_no}: unknown command '{command}'.")
        if command == "wait":
            if not argument.isdigit():
                raise ValueError(f"Line {line_no}: wait expects milliseconds, for example 'wait 500'.")
        elif command in {"keyevent", "open", "text"} and not argument:
            raise ValueError(f"Line {line_no}: {command} expects an argument.")
        elif command == "screenshot" and argument:
            raise ValueError(f"Line {line_no}: screenshot does not take an argument.")
        elif command in WORKFLOW_KEY_ALIASES and argument:
            raise ValueError(f"Line {line_no}: {command} does not take an argument.")
        steps.append(WorkflowStep(line_no=line_no, command=command, argument=argument))
    if not steps:
        raise ValueError("Workflow is empty.")
    return steps


def workflow_steps_to_text(raw: Any) -> str:
    if isinstance(raw, str):
        return raw.strip() + "\n"
    if not isinstance(raw, list):
        raise ValueError("Workflow steps must be a string or a list.")
    lines: list[str] = []
    for index, item in enumerate(raw, start=1):
        if isinstance(item, str):
            line = item.strip()
        elif isinstance(item, dict):
            command = str(item.get("command", "")).strip()
            argument = str(item.get("argument", "")).strip()
            line = f"{command} {argument}".strip()
        else:
            raise ValueError(f"Workflow step {index} must be a string or object.")
        if line:
            lines.append(line)
    text = "\n".join(lines).strip()
    if not text:
        raise ValueError("Workflow is empty.")
    parse_workflow_text(text)
    return text + "\n"


def workflow_import_map(data: Any) -> dict[str, str]:
    workflows: dict[str, str] = {}
    if isinstance(data, dict) and isinstance(data.get("workflows"), dict):
        for name, raw in data["workflows"].items():
            workflow_name = str(name).strip()
            if not workflow_name:
                continue
            workflows[workflow_name] = workflow_steps_to_text(raw)
    elif isinstance(data, dict):
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Workflow JSON needs a name.")
        raw_steps = data.get("steps", data.get("text", ""))
        workflows[name] = workflow_steps_to_text(raw_steps)
    else:
        raise ValueError("Workflow JSON must be an object.")
    if not workflows:
        raise ValueError("No workflows found in JSON.")
    return workflows


class AdbError(RuntimeError):
    pass


class AdbClient:
    def __init__(self, adb_path: str) -> None:
        self.adb_path = adb_path
        self._lock = threading.Lock()

    def run(
        self,
        args: list[str],
        *,
        serial: str | None = None,
        timeout: int = DEFAULT_COMMAND_TIMEOUT_SECONDS,
        capture_bytes: bool = False,
    ) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
        command = [self.adb_path]
        if serial:
            command.extend(["-s", serial])
        command.extend(args)

        try:
            with self._lock:
                if capture_bytes:
                    return subprocess.run(
                        command,
                        check=False,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=timeout,
                    )
                return subprocess.run(
                    command,
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=timeout,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
        except subprocess.TimeoutExpired as exc:
            raise AdbError(f"ADB command timed out after {timeout}s: {' '.join(command)}") from exc
        except OSError as exc:
            raise AdbError(str(exc)) from exc

    def text(self, args: list[str], *, serial: str | None = None, timeout: int = DEFAULT_COMMAND_TIMEOUT_SECONDS) -> str:
        result = self.run(args, serial=serial, timeout=timeout)
        if result.returncode != 0:
            stderr = result.stderr.strip() if isinstance(result.stderr, str) else ""
            stdout = result.stdout.strip() if isinstance(result.stdout, str) else ""
            raise AdbError(stderr or stdout or "ADB command failed")
        return result.stdout.strip() if isinstance(result.stdout, str) else ""

    def list_devices(self) -> list[DeviceInfo]:
        output = self.text(["devices", "-l"], timeout=8)
        devices: list[DeviceInfo] = []
        for line in output.splitlines()[1:]:
            raw = line.strip()
            if not raw:
                continue
            parts = raw.split()
            serial = parts[0]
            status = parts[1] if len(parts) > 1 else "unknown"
            product = self._extract_field(parts, "product")
            model = self._extract_field(parts, "model").replace("_", " ")
            devices.append(DeviceInfo(serial=serial, status=status, raw=raw, product=product, model=model))
        return devices

    def enrich_device(self, device: DeviceInfo) -> DeviceInfo:
        if not device.online:
            return device
        device.model = device.model or self.getprop(device.serial, "ro.product.model")
        device.product = device.product or self.getprop(device.serial, "ro.product.name")
        device.android = self.getprop(device.serial, "ro.build.version.release")
        device.sdk = self.getprop(device.serial, "ro.build.version.sdk")
        battery = self.read_battery(device.serial)
        device.battery = battery.get("level", "")
        device.charging = battery.get("charging", "")
        device.temperature = battery.get("temperature", "")
        device.last_seen = time.time()
        return device

    def getprop(self, serial: str, prop: str) -> str:
        try:
            return self.text(["shell", "getprop", prop], serial=serial, timeout=5).strip()
        except AdbError:
            return ""

    def read_battery(self, serial: str) -> dict[str, str]:
        try:
            output = self.text(["shell", "dumpsys", "battery"], serial=serial, timeout=6)
        except AdbError:
            return {}

        data: dict[str, str] = {}
        status_value = ""
        for raw in output.splitlines():
            if ":" not in raw:
                continue
            key, value = raw.split(":", 1)
            key = key.strip().lower()
            value = value.strip()
            if key == "level":
                data["level"] = f"{value}%"
            elif key == "status":
                status_value = value
            elif key == "temperature":
                try:
                    data["temperature"] = f"{int(value) / 10:.1f}C"
                except ValueError:
                    data["temperature"] = value

        data["charging"] = "yes" if status_value in {"2", "5"} else "no"
        return data

    def current_package(self, serial: str) -> str:
        commands = (
            ["shell", "dumpsys", "window"],
            ["shell", "dumpsys", "activity", "activities"],
        )
        for command in commands:
            try:
                output = self.text(command, serial=serial, timeout=8)
            except AdbError:
                continue
            package_name = self._extract_current_package(output)
            if package_name:
                return package_name
        return ""

    def keyevent(self, serial: str, key: str) -> str:
        return self.text(["shell", "input", "keyevent", key], serial=serial, timeout=5)

    def input_text(self, serial: str, value: str) -> str:
        safe_value = value.replace(" ", "%s")
        return self.text(["shell", "input", "text", safe_value], serial=serial, timeout=8)

    def open_package(self, serial: str, package_name: str) -> str:
        return self.text(
            ["shell", "monkey", "-p", package_name, "-c", "android.intent.category.LAUNCHER", "1"],
            serial=serial,
            timeout=10,
        )

    def list_packages(self, serial: str, *, include_system: bool = False) -> list[str]:
        args = ["shell", "pm", "list", "packages"]
        if not include_system:
            args.append("-3")
        output = self.text(args, serial=serial, timeout=25)
        packages: list[str] = []
        for raw in output.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("package:"):
                line = line[len("package:") :]
            if "=" in line:
                line = line.rsplit("=", 1)[-1]
            if line:
                packages.append(line)
        return sorted(set(packages))

    def package_info(self, serial: str, package_name: str) -> dict[str, str]:
        output = self.text(["shell", "dumpsys", "package", package_name], serial=serial, timeout=15)
        return self._parse_package_info(output)

    def clear_package_data(self, serial: str, package_name: str) -> str:
        return self.text(["shell", "pm", "clear", package_name], serial=serial, timeout=25)

    def uninstall_package(self, serial: str, package_name: str) -> str:
        return self.text(["uninstall", package_name], serial=serial, timeout=60)

    def settings_get(self, serial: str, namespace: str, key: str) -> str:
        return self.text(["shell", "settings", "get", namespace, key], serial=serial, timeout=6)

    def settings_put(self, serial: str, namespace: str, key: str, value: str | int) -> str:
        return self.text(["shell", "settings", "put", namespace, key, str(value)], serial=serial, timeout=6)

    def set_stay_awake(self, serial: str, enabled: bool) -> str:
        # Bitmask: 1=AC, 2=USB, 4=wireless. AC+USB is enough for a USB farm.
        return self.settings_put(serial, "global", "stay_on_while_plugged_in", 3 if enabled else 0)

    def disable_animations(self, serial: str) -> str:
        self.settings_put(serial, "global", "window_animation_scale", 0)
        self.settings_put(serial, "global", "transition_animation_scale", 0)
        return self.settings_put(serial, "global", "animator_duration_scale", 0)

    def set_screen_timeout(self, serial: str, minutes: int) -> str:
        millis = max(1, minutes) * 60 * 1000
        return self.settings_put(serial, "system", "screen_off_timeout", millis)

    def set_brightness(self, serial: str, brightness: int) -> str:
        value = min(255, max(1, brightness))
        self.settings_put(serial, "system", "screen_brightness_mode", 0)
        return self.settings_put(serial, "system", "screen_brightness", value)

    def install_apk(self, serial: str, apk_path: str) -> str:
        result = self.run(["install", "-r", apk_path], serial=serial, timeout=180)
        stdout = result.stdout.strip() if isinstance(result.stdout, str) else ""
        stderr = result.stderr.strip() if isinstance(result.stderr, str) else ""
        if result.returncode != 0:
            raise AdbError(stderr or stdout or "APK install failed")
        return stdout or "Installed"

    def screenshot(self, serial: str, output_path: Path) -> None:
        output_path.write_bytes(self.screenshot_bytes(serial))

    def screenshot_bytes(self, serial: str) -> bytes:
        result = self.run(["exec-out", "screencap", "-p"], serial=serial, timeout=20, capture_bytes=True)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise AdbError(stderr or "Screenshot failed")
        return result.stdout if isinstance(result.stdout, bytes) else b""

    def restart_server(self) -> None:
        self.run(["kill-server"], timeout=8)
        self.text(["start-server"], timeout=8)

    @staticmethod
    def _extract_field(parts: list[str], name: str) -> str:
        prefix = f"{name}:"
        for part in parts:
            if part.startswith(prefix):
                return part[len(prefix) :]
        return ""

    @staticmethod
    def _extract_current_package(output: str) -> str:
        interesting = ("mCurrentFocus", "mFocusedApp", "topResumedActivity", "ResumedActivity")
        for line in output.splitlines():
            if not any(marker in line for marker in interesting):
                continue
            match = re.search(r"\s([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/", line)
            if match:
                return match.group(1)
        return ""

    @staticmethod
    def _parse_package_info(output: str) -> dict[str, str]:
        fields = {
            "version_name": "",
            "version_code": "",
            "target_sdk": "",
            "first_install": "",
            "last_update": "",
            "installer": "",
            "flags": "",
        }
        for raw in output.splitlines():
            line = raw.strip()
            if line.startswith("versionName="):
                fields["version_name"] = line.partition("=")[2]
            elif line.startswith("versionCode="):
                match = re.search(r"versionCode=(\S+)", line)
                if match:
                    fields["version_code"] = match.group(1)
                target = re.search(r"targetSdk=(\S+)", line)
                if target:
                    fields["target_sdk"] = target.group(1)
            elif line.startswith("firstInstallTime="):
                fields["first_install"] = line.partition("=")[2]
            elif line.startswith("lastUpdateTime="):
                fields["last_update"] = line.partition("=")[2]
            elif line.startswith("installerPackageName="):
                fields["installer"] = line.partition("=")[2]
            elif line.startswith("pkgFlags=["):
                fields["flags"] = line.removeprefix("pkgFlags=").strip()
        return fields


class RoundedCard(tk.Canvas):
    """Canvas that paints a rounded panel and hosts child widgets in ``inner``."""

    def __init__(
        self,
        parent: tk.Misc,
        *,
        fill: str,
        outline: str,
        outer: str,
        radius: int = 16,
        padding: int | tuple[int, int] = 12,
        fit_width: bool = False,
        fit_height: bool = False,
    ) -> None:
        super().__init__(parent, highlightthickness=0, borderwidth=0, background=outer)
        self._fill = fill
        self._outline = outline
        self._line_width = 1
        self._radius = radius
        self._pad_x, self._pad_y = padding if isinstance(padding, tuple) else (padding, padding)
        self._fit_width = fit_width
        self._fit_height = fit_height
        self.inner = tk.Frame(self, background=fill)
        self._window = self.create_window(self._pad_x, self._pad_y, window=self.inner, anchor="nw")
        self.bind("<Configure>", self._on_configure)
        if fit_width or fit_height:
            self.inner.bind("<Configure>", self._on_inner_configure)

    def _on_inner_configure(self, _event: tk.Event[Any] | None = None) -> None:
        if self._fit_width:
            self.configure(width=self.inner.winfo_reqwidth() + 2 * self._pad_x)
        if self._fit_height:
            self.configure(height=self.inner.winfo_reqheight() + 2 * self._pad_y)

    def _on_configure(self, event: tk.Event[Any]) -> None:
        if not self._fit_width:
            self.itemconfigure(self._window, width=max(1, event.width - 2 * self._pad_x))
        if not self._fit_height:
            self.itemconfigure(self._window, height=max(1, event.height - 2 * self._pad_y))
        self._redraw(event.width, event.height)

    def _redraw(self, width: int | None = None, height: int | None = None) -> None:
        w = width or self.winfo_width()
        h = height or self.winfo_height()
        if w < 4 or h < 4:
            return
        self.delete("card")
        inset = self._line_width
        x0, y0, x1, y1 = inset, inset, w - inset - 1, h - inset - 1
        r = max(1, min(self._radius, (x1 - x0) // 2, (y1 - y0) // 2))
        points = [
            x0 + r, y0, x1 - r, y0, x1, y0, x1, y0 + r,
            x1, y1 - r, x1, y1, x1 - r, y1, x0 + r, y1,
            x0, y1, x0, y1 - r, x0, y0 + r, x0, y0,
        ]
        self.create_polygon(points, smooth=True, fill=self._fill, outline=self._outline, width=self._line_width, tags="card")
        self.tag_lower("card")

    def set_colors(self, *, fill: str | None = None, outline: str | None = None, line_width: int | None = None) -> None:
        if fill is not None:
            self._fill = fill
            self.inner.configure(background=fill)
        if outline is not None:
            self._outline = outline
        if line_width is not None:
            self._line_width = line_width
        self._redraw()


class FarmManagerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.config = load_config()
        self.theme = apply_theme(str(self.config.get("theme", DEFAULT_THEME)))
        self.device_state = load_device_state()
        self.ensure_node_identity()
        self.event_store = EventStore(EVENT_DB_FILE)
        self.adb_path = resolve_tool_path("adb", self.config.get("adb_path"))
        self.scrcpy_path = resolve_tool_path("scrcpy", self.config.get("scrcpy_path"))
        self.live_processes: dict[str, subprocess.Popen[Any]] = {}
        self.live_watchdog_after_id: str | None = None
        self.last_live_serials: list[str] = [str(serial) for serial in self.config.get("last_live_serials", []) if isinstance(serial, str)]
        self.adb = AdbClient(self.adb_path) if self.adb_path else None
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.devices: dict[str, DeviceInfo] = {}
        self.app_packages: list[str] = []
        self.app_packages_device: str | None = None
        self.apk_library_dir = self.resolve_apk_library_dir()
        self.apk_library_dir.mkdir(parents=True, exist_ok=True)
        self.backup_dir = BASE_DIR / BACKUP_DIR_NAME
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.node_snapshot_dir = BASE_DIR / NODE_SNAPSHOT_DIR_NAME
        self.node_snapshot_dir.mkdir(parents=True, exist_ok=True)
        self.dashboard_dir = BASE_DIR / DASHBOARD_DIR_NAME
        self.dashboard_dir.mkdir(parents=True, exist_ok=True)
        self.dashboard_snapshots: list[dict[str, Any]] = []
        self.apk_library_items: list[dict[str, Any]] = []
        self.selected_serial: str | None = None
        self.busy = False
        self.batch_running = False
        self.workflow_running = False
        self.setup_running = False
        self.app_batch_running = False
        self.auto_scan_after_id: str | None = None
        self.auto_scan_interval_seconds = self._read_int_config("auto_scan_interval_seconds", DEFAULT_AUTO_SCAN_INTERVAL_SECONDS, minimum=5)
        self.auto_restart_adb = bool(self.config.get("auto_restart_adb", True))
        self.low_battery_percent = self._read_int_config("low_battery_percent", DEFAULT_LOW_BATTERY_PERCENT, minimum=1)
        self.high_temp_c = self._read_float_config("high_temp_c", DEFAULT_HIGH_TEMP_C, minimum=25.0)
        self.health_alert_cache: set[str] = set()
        self.thumbnail_refreshing = False
        self.thumbnail_dir = Path(tempfile.gettempdir()) / "FarmManager" / "thumbnails"
        self.thumbnail_dir.mkdir(parents=True, exist_ok=True)
        self.thumbnail_interval_seconds = self._read_thumbnail_interval()
        self.thumbnail_images: dict[str, tk.PhotoImage] = {}
        self.thumbnail_source_images: dict[str, tk.PhotoImage] = {}
        self.thumbnail_cards: dict[str, dict[str, Any]] = {}
        self.thumbnail_errors: dict[str, str] = {}
        self.thumbnail_updated_at: dict[str, float] = {}
        self.thumbnail_after_id: str | None = None
        self.ensure_default_workflows()

        self.root.title(f"{APP_NAME}  ·  {APP_VERSION}")
        self.root.geometry("1480x900")
        self.root.minsize(1200, 740)

        self._configure_style()
        self._build_ui()
        self.root.after(150, self.set_initial_pane_sizes)
        self._poll_events()
        self.schedule_live_watchdog()

        if self.adb:
            self.refresh_devices()
            if self.auto_scan_var.get():
                self.schedule_auto_scan()
        else:
            self.log("ADB was not found. Install Android platform-tools or set adb_path in farm_manager_config.json.")

    def _read_int_config(self, key: str, default: int, *, minimum: int = 0) -> int:
        value = self.config.get(key, default)
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(minimum, parsed)

    def _read_float_config(self, key: str, default: float, *, minimum: float = 0.0) -> float:
        value = self.config.get(key, default)
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        return max(minimum, parsed)

    def _read_thumbnail_interval(self) -> int:
        return self._read_int_config("thumbnail_interval_seconds", DEFAULT_THUMBNAIL_INTERVAL_SECONDS, minimum=3)

    def ensure_node_identity(self) -> None:
        changed = False
        if not str(self.config.get("node_id", "")).strip():
            self.config["node_id"] = str(uuid.uuid4())
            changed = True
        if not str(self.config.get("node_name", "")).strip():
            self.config["node_name"] = os.getenv("COMPUTERNAME") or "Local Node"
            changed = True
        if changed:
            self.save_app_config_silent()

    def save_app_config_silent(self) -> None:
        try:
            save_config(self.config)
        except OSError:
            pass

    def resolve_apk_library_dir(self) -> Path:
        configured = str(self.config.get("apk_library_dir", "")).strip()
        if configured:
            return Path(configured).expanduser()
        return BASE_DIR / APK_LIBRARY_DIR_NAME

    def _configure_style(self) -> None:
        self.root.configure(background=COLOR_BG)
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        # Base
        style.configure(".", font=("Segoe UI", 10), background=COLOR_BG, foreground=COLOR_TEXT, borderwidth=0)

        # Frames
        style.configure("TFrame", background=COLOR_PANEL)
        style.configure("App.TFrame", background=COLOR_BG)
        style.configure("Panel.TFrame", background=COLOR_PANEL)
        style.configure("Header.TFrame", background=COLOR_HEADER_BG)
        style.configure("Sidebar.TFrame", background=COLOR_PANEL)
        style.configure("Toolbar.TFrame", background=COLOR_BG)

        # Labels
        style.configure("TLabel", background=COLOR_PANEL, foreground=COLOR_TEXT, padding=(0, 1))
        style.configure("HeaderTitle.TLabel",
            background=COLOR_HEADER_BG, foreground=COLOR_TEXT,
            font=("Segoe UI", 15, "bold"))
        style.configure("HeaderSub.TLabel",
            background=COLOR_HEADER_BG, foreground=COLOR_MUTED,
            font=("Segoe UI", 9))
        style.configure("Section.TLabel",
            background=COLOR_PANEL, foreground=COLOR_TEXT,
            font=("Segoe UI", 10, "bold"))
        style.configure("Muted.TLabel",
            background=COLOR_PANEL, foreground=COLOR_MUTED,
            font=("Segoe UI", 9))
        style.configure("Status.TLabel",
            background=COLOR_BG, foreground=COLOR_MUTED,
            font=("Segoe UI", 9), padding=(6, 3))
        style.configure("PanelStatus.TLabel",
            background=COLOR_PANEL, foreground=COLOR_MUTED,
            font=("Segoe UI", 9), padding=(4, 2))
        style.configure("ViewTitle.TLabel",
            background=COLOR_PANEL, foreground=COLOR_TEXT,
            font=("Segoe UI", 13, "bold"))
        style.configure("Nav.TFrame", background=COLOR_NAV_BG)
        style.configure("NavGroup.TLabel",
            background=COLOR_NAV_BG, foreground=COLOR_MUTED,
            font=("Segoe UI", 8, "bold"), padding=(14, 0))
        style.configure("Chip.TLabel",
            background=COLOR_ACCENT_SOFT, foreground=COLOR_ACCENT,
            font=("Segoe UI", 8, "bold"), padding=(6, 2))

        # Buttons — clean flat style with hover feedback
        style.configure("TButton",
            background=COLOR_PANEL_ALT, foreground=COLOR_TEXT,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_PANEL_ALT, darkcolor=COLOR_PANEL_ALT,
            relief=tk.FLAT,
            padding=(10, 6), font=("Segoe UI", 9),
            focusthickness=0, focuscolor="")
        style.map("TButton",
            background=[("active", COLOR_BORDER), ("pressed", COLOR_BORDER)],
            bordercolor=[("active", COLOR_ACCENT), ("focus", COLOR_ACCENT)],
            relief=[("active", tk.FLAT)])
        style.configure("Toolbar.TButton",
            background=COLOR_PANEL_ALT, foreground=COLOR_TEXT,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_PANEL_ALT, darkcolor=COLOR_PANEL_ALT,
            relief=tk.FLAT, padding=(12, 7), font=("Segoe UI", 9))
        style.map("Toolbar.TButton",
            background=[("active", COLOR_BORDER), ("pressed", COLOR_BORDER)])
        style.configure("Danger.TButton",
            background=COLOR_DANGER_SOFT, foreground=COLOR_DANGER,
            bordercolor=COLOR_DANGER_SOFT, lightcolor=COLOR_DANGER_SOFT, darkcolor=COLOR_DANGER_SOFT,
            relief=tk.FLAT, padding=(10, 6), font=("Segoe UI", 9, "bold"))
        style.map("Danger.TButton",
            background=[("active", COLOR_DANGER), ("pressed", COLOR_DANGER)],
            foreground=[("active", COLOR_PANEL), ("pressed", COLOR_PANEL)])
        style.configure("Toolbar.TMenubutton",
            background=COLOR_PANEL_ALT, foreground=COLOR_TEXT, arrowcolor=COLOR_MUTED,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_PANEL_ALT, darkcolor=COLOR_PANEL_ALT,
            relief=tk.FLAT, padding=(12, 7), font=("Segoe UI", 9))
        style.map("Toolbar.TMenubutton",
            background=[("active", COLOR_BORDER), ("pressed", COLOR_BORDER)])
        style.configure("Accent.TButton",
            background=COLOR_ACCENT, foreground=COLOR_ACCENT_TEXT,
            bordercolor=COLOR_ACCENT, lightcolor=COLOR_ACCENT, darkcolor=COLOR_ACCENT,
            relief=tk.FLAT, padding=(12, 7), font=("Segoe UI", 9, "bold"))
        style.map("Accent.TButton",
            background=[("active", COLOR_ACCENT_HOVER), ("pressed", COLOR_ACCENT_HOVER)])

        # Checkbutton
        style.configure("TCheckbutton",
            background=COLOR_PANEL, foreground=COLOR_TEXT,
            font=("Segoe UI", 9))
        style.configure("TCheckbutton",
            indicatorbackground=COLOR_FIELD, indicatorforeground=COLOR_ACCENT,
            upperbordercolor=COLOR_BORDER, lowerbordercolor=COLOR_BORDER)
        style.map("TCheckbutton",
            background=[("active", COLOR_PANEL)],
            indicatorbackground=[("selected", COLOR_ACCENT_SOFT)])
        style.configure("Header.TCheckbutton", background=COLOR_HEADER_BG, foreground=COLOR_TEXT)
        style.map("Header.TCheckbutton", background=[("active", COLOR_HEADER_BG)])

        # Combobox
        style.configure("TCombobox",
            background=COLOR_PANEL_ALT, foreground=COLOR_TEXT,
            fieldbackground=COLOR_FIELD, arrowcolor=COLOR_MUTED,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_FIELD, darkcolor=COLOR_FIELD,
            selectbackground=COLOR_FIELD, selectforeground=COLOR_TEXT,
            padding=(7, 5), font=("Segoe UI", 9))
        style.map("TCombobox",
            fieldbackground=[("readonly", COLOR_FIELD), ("disabled", COLOR_PANEL)],
            foreground=[("disabled", COLOR_MUTED)],
            bordercolor=[("focus", COLOR_ACCENT)])
        # Combobox dropdown is a classic Tk listbox, styled through the option database.
        self.root.option_add("*TCombobox*Listbox.background", COLOR_FIELD)
        self.root.option_add("*TCombobox*Listbox.foreground", COLOR_TEXT)
        self.root.option_add("*TCombobox*Listbox.selectBackground", COLOR_ACCENT)
        self.root.option_add("*TCombobox*Listbox.selectForeground", COLOR_ACCENT_TEXT)
        self.root.option_add("*TCombobox*Listbox.borderWidth", 0)

        # Entry
        style.configure("TEntry",
            background=COLOR_PANEL, foreground=COLOR_TEXT,
            fieldbackground=COLOR_FIELD, insertcolor=COLOR_ACCENT,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_FIELD, darkcolor=COLOR_FIELD,
            selectbackground=COLOR_ACCENT, selectforeground=COLOR_ACCENT_TEXT,
            padding=(6, 5))
        style.map("TEntry", bordercolor=[("focus", COLOR_ACCENT)])
        style.configure("TSpinbox",
            background=COLOR_PANEL_ALT, foreground=COLOR_TEXT,
            fieldbackground=COLOR_FIELD, arrowcolor=COLOR_MUTED,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_FIELD, darkcolor=COLOR_FIELD)
        style.configure("TRadiobutton", background=COLOR_PANEL, foreground=COLOR_TEXT,
            indicatorbackground=COLOR_FIELD, indicatorforeground=COLOR_ACCENT)
        style.map("TRadiobutton", background=[("active", COLOR_PANEL)])
        style.configure("TLabelframe", background=COLOR_PANEL, bordercolor=COLOR_BORDER,
            lightcolor=COLOR_BORDER, darkcolor=COLOR_BORDER)
        style.configure("TLabelframe.Label", background=COLOR_PANEL, foreground=COLOR_MUTED,
            font=("Segoe UI", 9, "bold"))
        style.configure("TPanedwindow", background=COLOR_BG)
        style.configure("Sash", sashthickness=8, gripcount=0, background=COLOR_BG)

        # Scale
        style.configure("TScale", background=COLOR_PANEL, troughcolor=COLOR_FIELD,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_PANEL_ALT, darkcolor=COLOR_PANEL_ALT)

        # Separator
        style.configure("TSeparator", background=COLOR_BORDER)

        # Notebook
        style.configure("TNotebook", background=COLOR_PANEL, borderwidth=0, tabmargins=0)
        style.configure("TNotebook.Tab",
            padding=(10, 7), font=("Segoe UI", 9),
            background=COLOR_BG, foreground=COLOR_MUTED)
        style.map("TNotebook.Tab",
            background=[("selected", COLOR_PANEL)],
            foreground=[("selected", COLOR_TEXT)])

        # Treeview
        style.configure("Treeview",
            rowheight=34, borderwidth=0,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_BORDER, darkcolor=COLOR_BORDER,
            background=COLOR_PANEL, fieldbackground=COLOR_PANEL,
            foreground=COLOR_TEXT, font=("Segoe UI", 9))
        style.configure("Treeview.Heading",
            font=("Segoe UI", 8, "bold"), foreground=COLOR_MUTED,
            background=COLOR_PANEL_ALT, padding=(6, 6),
            bordercolor=COLOR_PANEL_ALT, lightcolor=COLOR_PANEL_ALT, darkcolor=COLOR_PANEL_ALT,
            relief=tk.FLAT)
        style.map("Treeview.Heading", background=[("active", COLOR_BORDER)])
        style.map("Treeview",
            background=[("selected", COLOR_ACCENT_SOFT)],
            foreground=[("selected", COLOR_TEXT)])

        # Progressbar
        style.configure("Horizontal.TProgressbar",
            troughcolor=COLOR_PANEL_ALT, background=COLOR_ACCENT,
            bordercolor=COLOR_BORDER, lightcolor=COLOR_ACCENT,
            darkcolor=COLOR_ACCENT, borderwidth=0, thickness=6)

        # Scrollbar
        style.configure("TScrollbar",
            background=COLOR_PANEL_ALT, troughcolor=COLOR_PANEL,
            bordercolor=COLOR_PANEL, lightcolor=COLOR_PANEL_ALT, darkcolor=COLOR_PANEL_ALT,
            arrowcolor=COLOR_MUTED, relief=tk.FLAT, width=10)
        style.map("TScrollbar",
            background=[("active", COLOR_BORDER)])

        self._apply_titlebar_theme()

    def _apply_titlebar_theme(self) -> None:
        if sys.platform != "win32":
            return
        try:
            import ctypes

            self.root.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            value = ctypes.c_int(1 if self.theme == "dark" else 0)
            # DWMWA_USE_IMMERSIVE_DARK_MODE
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(value), ctypes.sizeof(value))
        except Exception:
            pass

    def toggle_theme(self) -> None:
        running = (
            self.busy or self.batch_running or self.workflow_running
            or self.setup_running or self.app_batch_running or self.thumbnail_refreshing
        )
        if running:
            self.status_var.set("Finish the running task before switching theme.")
            return
        self.theme = apply_theme("light" if self.theme == "dark" else "dark")
        self.config["theme"] = self.theme
        self.save_app_config_silent()
        self.rebuild_ui()

    def rebuild_ui(self) -> None:
        """Tear down and rebuild every widget so the new palette applies everywhere."""
        log_content = self.log_text.get("1.0", "end-1c")
        view = self.inspector_view_var.get()
        selection = list(self.device_tree.selection())
        if self.thumbnail_after_id:
            self.root.after_cancel(self.thumbnail_after_id)
            self.thumbnail_after_id = None
        for child in self.root.winfo_children():
            child.destroy()
        self.thumbnail_cards.clear()
        self._configure_style()
        self._build_ui()
        if log_content:
            self.log_text.configure(state=tk.NORMAL)
            self.log_text.insert(tk.END, log_content + "\n")
            self.log_text.see(tk.END)
            self.log_text.configure(state=tk.DISABLED)
        self.show_inspector_view(view)
        self.root.after(150, self.set_initial_pane_sizes)
        if self.devices:
            self.update_device_tree(list(self.devices.values()))
            kept = [serial for serial in selection if serial in self.devices]
            if kept:
                self.device_tree.selection_set(kept)

    def _build_ui(self) -> None:
        self.root.columnconfigure(1, weight=1)
        self.root.rowconfigure(1, weight=1)

        self.status_var = tk.StringVar(value="Ready")
        self.adb_var = tk.StringVar(value=f"ADB: {self.adb_path or 'not found'}")
        self.fleet_var = tk.StringVar(value="0 devices")
        self.header_status_var = tk.StringVar(value="No scan yet")

        # ── Header card ────────────────────────────────────────────────
        header_card = RoundedCard(
            self.root, fill=COLOR_PANEL, outline=COLOR_BORDER, outer=COLOR_BG,
            radius=18, padding=(20, 14), fit_height=True,
        )
        header_card.grid(row=0, column=0, columnspan=2, sticky="ew", padx=14, pady=(14, 6))
        toolbar = header_card.inner
        toolbar.columnconfigure(1, weight=1)

        logo = tk.Canvas(toolbar, width=44, height=44, highlightthickness=0, background=COLOR_PANEL)
        logo.create_polygon(
            [12, 1, 32, 1, 43, 1, 43, 12, 43, 32, 43, 43, 32, 43, 12, 43, 1, 43, 1, 32, 1, 12, 1, 1],
            smooth=True, fill=COLOR_ACCENT, outline="",
        )
        logo.create_text(22, 22, text="FM", fill=COLOR_ACCENT_TEXT, font=("Segoe UI", 12, "bold"))
        logo.grid(row=0, column=0, padx=(0, 14))

        title_box = tk.Frame(toolbar, background=COLOR_PANEL)
        title_box.grid(row=0, column=1, sticky="w")
        ttk.Label(title_box, text=APP_NAME, style="HeaderTitle.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
        self.header_dot = tk.Canvas(title_box, width=10, height=10, highlightthickness=0, background=COLOR_PANEL)
        self.header_dot.create_oval(1, 1, 9, 9, fill=COLOR_MUTED, outline="", tags="dot")
        self.header_dot.grid(row=1, column=0, sticky="w", padx=(0, 6))
        ttk.Label(title_box, textvariable=self.header_status_var, style="HeaderSub.TLabel").grid(row=1, column=1, sticky="w")

        # Global actions — rare ones live in the More menu, primary action last
        btn_frame = tk.Frame(toolbar, background=COLOR_PANEL)
        btn_frame.grid(row=0, column=2, sticky="e")
        self.auto_scan_var = tk.BooleanVar(value=bool(self.config.get("auto_scan_enabled", False)))
        ttk.Checkbutton(
            btn_frame,
            text=f"Auto scan  {self.auto_scan_interval_seconds}s",
            variable=self.auto_scan_var,
            command=self.on_auto_scan_toggle,
            style="Header.TCheckbutton",
        ).pack(side=tk.LEFT, padx=(0, 12))
        more_button = ttk.Menubutton(btn_frame, text="More", style="Toolbar.TMenubutton")
        more_menu = tk.Menu(
            more_button, tearoff=False, borderwidth=0,
            background=COLOR_PANEL_ALT, foreground=COLOR_TEXT,
            activebackground=COLOR_ACCENT, activeforeground=COLOR_ACCENT_TEXT,
        )
        more_menu.add_command(label="Refresh selected screen", command=self.refresh_selected_thumbnail)
        more_menu.add_command(label="Restart ADB", command=self.restart_adb)
        more_menu.add_separator()
        more_menu.add_command(label="Open config folder", command=self.open_config_folder)
        more_menu.add_command(label="Open event log", command=self.open_event_db)
        more_button.configure(menu=more_menu)
        more_button.pack(side=tk.LEFT, padx=4)
        ttk.Button(
            btn_frame,
            text="☀  Light" if self.theme == "dark" else "☾  Dark",
            style="Toolbar.TButton",
            command=self.toggle_theme,
        ).pack(side=tk.LEFT, padx=4)
        ttk.Button(btn_frame, text="↺  Refresh", style="Accent.TButton", command=self.refresh_devices).pack(side=tk.LEFT, padx=(4, 0))

        # ── Left navigation rail ──────────────────────────────────────
        nav = ttk.Frame(self.root, padding=(6, 4, 0, 10), style="Nav.TFrame", width=172)
        nav.grid(row=1, column=0, sticky="ns")
        nav.grid_propagate(False)
        nav.columnconfigure(0, weight=1)
        self._nav_parent = nav

        self.main_pane = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        self.main_pane.grid(row=1, column=1, sticky="nsew", padx=(4, 14), pady=(6, 4))

        left_card = RoundedCard(self.main_pane, fill=COLOR_PANEL, outline=COLOR_BORDER, outer=COLOR_BG, radius=18, padding=18)
        right_card = RoundedCard(self.main_pane, fill=COLOR_PANEL, outline=COLOR_BORDER, outer=COLOR_BG, radius=18, padding=18)
        self.main_pane.add(left_card, weight=3)
        self.main_pane.add(right_card, weight=2)
        left = left_card.inner
        right = right_card.inner

        # ── Devices pane: one list of devices, shown as cards or as a table ─
        left.rowconfigure(1, weight=1)
        left.columnconfigure(0, weight=1)

        dev_header = tk.Frame(left, background=COLOR_PANEL)
        dev_header.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        dev_header.columnconfigure(0, weight=1)
        self.summary_var = tk.StringVar(value="0 devices")
        ttk.Label(dev_header, text="Devices", style="ViewTitle.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(dev_header, textvariable=self.summary_var, style="Muted.TLabel").grid(row=1, column=0, sticky="w")

        dev_tools = tk.Frame(dev_header, background=COLOR_PANEL)
        dev_tools.grid(row=0, column=1, rowspan=2, sticky="e")
        self.thumbnail_status_var = tk.StringVar(value="Idle")
        ttk.Label(dev_tools, textvariable=self.thumbnail_status_var, style="PanelStatus.TLabel").pack(side=tk.LEFT, padx=(0, 8))
        self.thumbnail_auto_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            dev_tools,
            text="Auto",
            variable=self.thumbnail_auto_var,
            command=self.on_thumbnail_auto_toggle,
        ).pack(side=tk.LEFT, padx=(0, 8))
        ttk.Button(dev_tools, text="↺  Screens", style="Toolbar.TButton", command=self.refresh_thumbnails).pack(side=tk.LEFT, padx=(0, 10))

        segment = tk.Frame(dev_tools, background=COLOR_PANEL_ALT, padx=3, pady=3)
        segment.pack(side=tk.LEFT)
        self._device_view_buttons: dict[str, tk.Label] = {}
        for view_name in ("Cards", "List"):
            seg = tk.Label(segment, text=view_name, font=("Segoe UI", 9), cursor="hand2", padx=12, pady=4)
            seg.pack(side=tk.LEFT)
            seg.bind("<Button-1>", lambda _e, v=view_name: self.show_device_view(v))
            self._device_view_buttons[view_name] = seg

        device_stack = tk.Frame(left, background=COLOR_PANEL)
        device_stack.grid(row=1, column=0, sticky="nsew")
        device_stack.rowconfigure(0, weight=1)
        device_stack.columnconfigure(0, weight=1)

        list_shell = tk.Frame(device_stack, background=COLOR_PANEL)
        list_shell.grid(row=0, column=0, sticky="nsew")
        list_shell.rowconfigure(0, weight=1)
        list_shell.columnconfigure(0, weight=1)

        columns = ("slot", "group", "status", "model", "android", "battery", "serial")
        self.device_tree = ttk.Treeview(list_shell, columns=columns, show="headings", selectmode="extended")
        self.device_tree.heading("slot", text="Slot")
        self.device_tree.heading("group", text="Group")
        self.device_tree.heading("status", text="Status")
        self.device_tree.heading("model", text="Model")
        self.device_tree.heading("android", text="OS")
        self.device_tree.heading("battery", text="Battery")
        self.device_tree.heading("serial", text="Serial")
        self.device_tree.column("slot", width=58, minwidth=42, anchor="w")
        self.device_tree.column("group", width=92, minwidth=70, anchor="w")
        self.device_tree.column("status", width=86, minwidth=64, anchor="w")
        self.device_tree.column("model", width=170, minwidth=110, anchor="w")
        self.device_tree.column("android", width=58, minwidth=48, anchor="center")
        self.device_tree.column("battery", width=72, minwidth=56, anchor="center")
        self.device_tree.column("serial", width=130, minwidth=90, anchor="w")
        self.device_tree.grid(row=0, column=0, sticky="nsew")
        self.device_tree.bind("<<TreeviewSelect>>", self.on_select_device)
        self.device_tree.tag_configure("online", foreground=COLOR_SUCCESS)
        self.device_tree.tag_configure("offline", foreground=COLOR_MUTED)
        self.device_tree.tag_configure("unauthorized", foreground=COLOR_WARNING)
        self.device_tree.tag_configure("error", foreground=COLOR_DANGER)

        yscroll = ttk.Scrollbar(list_shell, orient=tk.VERTICAL, command=self.device_tree.yview)
        self.device_tree.configure(yscrollcommand=yscroll.set)
        yscroll.grid(row=0, column=1, sticky="ns")

        grid_shell = tk.Frame(device_stack, background=COLOR_PANEL)
        grid_shell.grid(row=0, column=0, sticky="nsew")
        grid_shell.rowconfigure(0, weight=1)
        grid_shell.columnconfigure(0, weight=1)
        self._device_view_frames = {"Cards": grid_shell, "List": list_shell}

        self.thumbnail_canvas = tk.Canvas(grid_shell, highlightthickness=0, background=COLOR_PANEL)
        self.thumbnail_canvas.grid(row=0, column=0, sticky="nsew")
        thumb_scroll = ttk.Scrollbar(grid_shell, orient=tk.VERTICAL, command=self.thumbnail_canvas.yview)
        thumb_scroll.grid(row=0, column=1, sticky="ns")
        self.thumbnail_canvas.configure(yscrollcommand=thumb_scroll.set)

        self.thumbnail_frame = tk.Frame(self.thumbnail_canvas, background=COLOR_PANEL)
        self.thumbnail_window = self.thumbnail_canvas.create_window((0, 0), window=self.thumbnail_frame, anchor="nw")
        self.thumbnail_frame.bind("<Configure>", self.on_thumbnail_frame_configure)
        self.thumbnail_canvas.bind("<Configure>", self.on_thumbnail_canvas_configure)
        self.thumbnail_canvas.bind("<Enter>", lambda _e: self.thumbnail_canvas.bind_all("<MouseWheel>", self.on_thumbnail_mousewheel))
        self.thumbnail_canvas.bind("<Leave>", lambda _e: self.thumbnail_canvas.unbind_all("<MouseWheel>"))

        self.render_thumbnail_cards()
        self.show_device_view(str(self.config.get("device_view", "Cards")), save=False)

        right.rowconfigure(1, weight=1)
        right.columnconfigure(0, weight=1)

        # ── Inspector header: title and one-line hint for the current view ──
        inspector_header = ttk.Frame(right, style="Panel.TFrame")
        inspector_header.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        inspector_header.columnconfigure(0, weight=1)
        self.inspector_title_var = tk.StringVar(value="Info")
        self.inspector_hint_var = tk.StringVar(value="")
        ttk.Label(inspector_header, textvariable=self.inspector_title_var, style="ViewTitle.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(inspector_header, textvariable=self.inspector_hint_var, style="Muted.TLabel").grid(row=1, column=0, sticky="w")

        self.inspector_views = (
            "Info",
            "Actions",
            "Live",
            "Setup",
            "Apps",
            "APK",
            "Batch",
            "Policy",
            "Workflow",
            "Node",
            "Dashboard",
            "Log",
        )
        self.inspector_view_var = tk.StringVar(value="Info")

        # Views grouped by scope: one device, the selected fleet, this controller
        self.inspector_hints = {
            "Info": "Details and naming for the selected device",
            "Actions": "Quick keys and text for the selected device",
            "Live": "scrcpy live control sessions",
            "Apps": "Packages installed on the selected device",
            "Setup": "Onboarding diagnostics and display settings",
            "Batch": "Run one action on every selected online device",
            "APK": "APK library and multi-device installs",
            "Workflow": "Saved step sequences, run on demand",
            "Policy": "Per-app rules for automation and capture",
            "Node": "This controller: identity, backup, restore",
            "Dashboard": "Compare snapshots from several controllers",
            "Log": "Activity log for this session",
        }
        nav_groups = (
            ("DEVICE", ("Info", "Actions", "Live", "Apps", "Setup")),
            ("FLEET", ("Batch", "APK", "Workflow", "Policy")),
            ("SYSTEM", ("Node", "Dashboard", "Log")),
        )
        self._tab_buttons: dict[str, tk.Label] = {}
        nav_row = 0
        for group_name, group_views in nav_groups:
            ttk.Label(self._nav_parent, text=group_name, style="NavGroup.TLabel").grid(
                row=nav_row, column=0, sticky="ew", pady=(10 if nav_row else 2, 4)
            )
            nav_row += 1
            for view_name in group_views:
                btn = tk.Label(
                    self._nav_parent,
                    text=view_name,
                    font=("Segoe UI", 10),
                    background=COLOR_NAV_BG,
                    foreground=COLOR_MUTED,
                    cursor="hand2",
                    anchor="w",
                    padx=14,
                    pady=7,
                    relief=tk.FLAT,
                )
                btn.grid(row=nav_row, column=0, sticky="ew", padx=8, pady=1)
                btn.bind("<Button-1>", lambda _e, v=view_name: self.show_inspector_view(v))
                btn.bind("<Enter>", lambda _e, v=view_name: self._hover_tab_button(v, True))
                btn.bind("<Leave>", lambda _e, v=view_name: self._hover_tab_button(v, False))
                self._tab_buttons[view_name] = btn
                nav_row += 1
        self._refresh_tab_buttons("Info")

        inspector_shell = ttk.Frame(right, style="Panel.TFrame")
        inspector_shell.grid(row=1, column=0, sticky="nsew")
        inspector_shell.rowconfigure(0, weight=1)
        inspector_shell.columnconfigure(0, weight=1)

        info_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        actions_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        live_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        setup_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        apps_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        apk_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        batch_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        policy_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        workflow_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        node_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        dashboard_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        log_tab = ttk.Frame(inspector_shell, padding=(0, 4, 0, 0))
        self.inspector_frames: dict[str, ttk.Frame] = {
            "Info": info_tab,
            "Actions": actions_tab,
            "Live": live_tab,
            "Setup": setup_tab,
            "Apps": apps_tab,
            "APK": apk_tab,
            "Batch": batch_tab,
            "Policy": policy_tab,
            "Workflow": workflow_tab,
            "Node": node_tab,
            "Dashboard": dashboard_tab,
            "Log": log_tab,
        }
        for frame in self.inspector_frames.values():
            frame.grid(row=0, column=0, sticky="nsew")

        info_tab.columnconfigure(1, weight=1)
        self.info_vars: dict[str, tk.StringVar] = {}
        for row, label in enumerate(("Serial", "Status", "Model", "Product", "Android", "SDK", "Battery", "Charging", "Temperature", "Last Seen")):
            ttk.Label(info_tab, text=f"{label}", style="Muted.TLabel").grid(row=row, column=0, sticky="w", pady=3, padx=(0, 12))
            var = tk.StringVar(value="—")
            self.info_vars[label.lower().replace(" ", "_")] = var
            ttk.Label(info_tab, textvariable=var).grid(row=row, column=1, sticky="ew", pady=3)

        metadata_row = len(self.info_vars)
        ttk.Separator(info_tab).grid(row=metadata_row, column=0, columnspan=2, sticky="ew", pady=(12, 8))
        ttk.Label(info_tab, text="Name:").grid(row=metadata_row + 1, column=0, sticky="w", pady=4)
        self.name_input = ttk.Entry(info_tab)
        self.name_input.grid(row=metadata_row + 1, column=1, sticky="ew", pady=4)
        ttk.Label(info_tab, text="Group:").grid(row=metadata_row + 2, column=0, sticky="w", pady=4)
        self.info_group_input = ttk.Entry(info_tab)
        self.info_group_input.grid(row=metadata_row + 2, column=1, sticky="ew", pady=4)
        ttk.Label(info_tab, text="Slot:").grid(row=metadata_row + 3, column=0, sticky="w", pady=4)
        self.slot_input = ttk.Entry(info_tab)
        self.slot_input.grid(row=metadata_row + 3, column=1, sticky="ew", pady=4)
        ttk.Button(info_tab, text="Save Metadata", command=self.save_selected_metadata).grid(
            row=metadata_row + 4,
            column=0,
            columnspan=2,
            sticky="ew",
            pady=(8, 0),
        )

        for col in range(3):
            actions_tab.columnconfigure(col, weight=1)

        action_buttons = [
            ("Back", lambda: self.run_selected_action("Back", lambda serial: self.adb_required().keyevent(serial, "KEYCODE_BACK"))),
            ("Home", lambda: self.run_selected_action("Home", lambda serial: self.adb_required().keyevent(serial, "KEYCODE_HOME"))),
            ("Recent", lambda: self.run_selected_action("Recent", lambda serial: self.adb_required().keyevent(serial, "KEYCODE_APP_SWITCH"))),
            ("Wake", lambda: self.run_selected_action("Wake", lambda serial: self.adb_required().keyevent(serial, "KEYCODE_WAKEUP"))),
            ("Sleep", lambda: self.run_selected_action("Sleep", lambda serial: self.adb_required().keyevent(serial, "KEYCODE_SLEEP"))),
            ("Screenshot", self.take_screenshot),
            ("Install APK", self.install_apk),
            ("Open App", self.open_app_prompt),
            ("Open Live", self.open_scrcpy),
            ("Reboot", self.reboot_selected),
        ]
        for index, (label, command) in enumerate(action_buttons):
            ttk.Button(actions_tab, text=label, command=command, style="Danger.TButton" if label == "Reboot" else "TButton").grid(
                row=index // 3,
                column=index % 3,
                sticky="ew",
                padx=4,
                pady=4,
            )

        ttk.Separator(actions_tab).grid(row=4, column=0, columnspan=3, sticky="ew", pady=12)
        ttk.Label(actions_tab, text="Send Text").grid(row=5, column=0, sticky="w", padx=4)
        self.text_input = ttk.Entry(actions_tab)
        self.text_input.grid(row=5, column=1, sticky="ew", padx=4)
        ttk.Button(actions_tab, text="Send", command=self.send_text).grid(row=5, column=2, sticky="ew", padx=4)

        self._build_batch_tab(batch_tab)
        self._build_live_tab(live_tab)
        self._build_setup_tab(setup_tab)
        self._build_apps_tab(apps_tab)
        self._build_apk_tab(apk_tab)
        self._build_policy_tab(policy_tab)
        self._build_workflow_tab(workflow_tab)
        self._build_node_tab(node_tab)
        self._build_dashboard_tab(dashboard_tab)

        self.log_text = tk.Text(
            log_tab,
            height=12,
            wrap=tk.WORD,
            state=tk.DISABLED,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=10,
            pady=8,
            selectbackground=COLOR_ACCENT_SOFT,
            insertbackground=COLOR_ACCENT,
            spacing1=2,
        )
        self.log_text.grid(row=0, column=0, sticky="nsew")
        log_tab.rowconfigure(0, weight=1)
        log_tab.columnconfigure(0, weight=1)
        log_scroll = ttk.Scrollbar(log_tab, orient=tk.VERTICAL, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)
        log_scroll.grid(row=0, column=1, sticky="ns")
        self.show_inspector_view("Info")

        footer = ttk.Frame(self.root, padding=(20, 0, 20, 8), style="App.TFrame")
        footer.grid(row=2, column=0, columnspan=2, sticky="ew")
        footer.columnconfigure(1, weight=1)
        ttk.Label(footer, textvariable=self.status_var, style="Status.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(footer, textvariable=self.adb_var, style="Status.TLabel").grid(row=0, column=1, sticky="e")

    def set_initial_pane_sizes(self) -> None:
        if not hasattr(self, "main_pane"):
            return
        width = max(self.main_pane.winfo_width(), self.root.winfo_width() - 196)
        if width <= 100:
            return
        try:
            self.main_pane.sashpos(0, max(460, int(width * 0.54)))
        except tk.TclError:
            pass

    def show_device_view(self, view: str, *, save: bool = True) -> None:
        if view not in self._device_view_frames:
            view = "Cards"
        self._device_view_frames[view].tkraise()
        for name, button in self._device_view_buttons.items():
            active = name == view
            button.configure(
                background=COLOR_PANEL if active else COLOR_PANEL_ALT,
                foreground=COLOR_TEXT if active else COLOR_MUTED,
                font=("Segoe UI", 9, "bold") if active else ("Segoe UI", 9),
            )
        if save and self.config.get("device_view") != view:
            self.config["device_view"] = view
            self.save_app_config_silent()

    def _refresh_tab_buttons(self, active_view: str) -> None:
        if not hasattr(self, "_tab_buttons"):
            return
        for view_name, btn in self._tab_buttons.items():
            if view_name == active_view:
                btn.configure(
                    background=COLOR_ACCENT,
                    foreground=COLOR_ACCENT_TEXT,
                    font=("Segoe UI", 10, "bold"),
                )
            else:
                btn.configure(
                    background=COLOR_NAV_BG,
                    foreground=COLOR_MUTED,
                    font=("Segoe UI", 10),
                )

    def _hover_tab_button(self, view_name: str, entering: bool) -> None:
        if view_name == self.inspector_view_var.get():
            return
        self._tab_buttons[view_name].configure(
            background=COLOR_PANEL_ALT if entering else COLOR_NAV_BG,
            foreground=COLOR_TEXT if entering else COLOR_MUTED,
        )

    def show_inspector_view(self, view: str | tk.Event[Any] | None = None) -> None:
        if not hasattr(self, "inspector_frames"):
            return
        view_name = view if isinstance(view, str) else self.inspector_view_var.get()
        if view_name not in self.inspector_frames:
            view_name = "Info"
        self.inspector_view_var.set(view_name)
        self.inspector_frames[view_name].tkraise()
        self._refresh_tab_buttons(view_name)
        if hasattr(self, "inspector_title_var"):
            self.inspector_title_var.set(view_name)
            self.inspector_hint_var.set(self.inspector_hints.get(view_name, ""))

    def _build_batch_tab(self, batch_tab: ttk.Frame) -> None:
        for col in range(3):
            batch_tab.columnconfigure(col, weight=1)

        self.batch_selected_var = tk.StringVar(value="0 selected")
        ttk.Label(batch_tab, textvariable=self.batch_selected_var, style="Section.TLabel").grid(
            row=0,
            column=0,
            columnspan=3,
            sticky="w",
            pady=(0, 8),
        )

        batch_buttons = [
            ("Back", lambda: self.run_batch_keyevent("Back", "KEYCODE_BACK")),
            ("Home", lambda: self.run_batch_keyevent("Home", "KEYCODE_HOME")),
            ("Recent", lambda: self.run_batch_keyevent("Recent", "KEYCODE_APP_SWITCH")),
            ("Wake", lambda: self.run_batch_keyevent("Wake", "KEYCODE_WAKEUP")),
            ("Sleep", lambda: self.run_batch_keyevent("Sleep", "KEYCODE_SLEEP")),
            ("Open App", self.batch_open_app_prompt),
            ("Install APK", self.batch_install_apk),
            ("Reboot", self.batch_reboot),
        ]
        for index, (label, command) in enumerate(batch_buttons):
            ttk.Button(batch_tab, text=label, command=command, style="Danger.TButton" if label == "Reboot" else "TButton").grid(
                row=1 + index // 3,
                column=index % 3,
                sticky="ew",
                padx=4,
                pady=4,
            )

        ttk.Separator(batch_tab).grid(row=4, column=0, columnspan=3, sticky="ew", pady=12)
        ttk.Label(batch_tab, text="Group").grid(row=5, column=0, sticky="w", padx=4)
        self.group_input = ttk.Entry(batch_tab)
        self.group_input.grid(row=5, column=1, sticky="ew", padx=4)
        ttk.Button(batch_tab, text="Set", command=self.apply_group_to_selection).grid(row=5, column=2, sticky="ew", padx=4)

        self.batch_progress = ttk.Progressbar(batch_tab, mode="determinate", maximum=1)
        self.batch_progress.grid(row=6, column=0, columnspan=3, sticky="ew", padx=4, pady=(18, 4))
        self.batch_progress_var = tk.StringVar(value="Idle")
        ttk.Label(batch_tab, textvariable=self.batch_progress_var, style="PanelStatus.TLabel").grid(
            row=7,
            column=0,
            columnspan=3,
            sticky="w",
        )

    def _build_live_tab(self, live_tab: ttk.Frame) -> None:
        live_tab.columnconfigure(1, weight=1)

        self.scrcpy_status_var = tk.StringVar(value=self.scrcpy_status_text())
        ttk.Label(live_tab, text="scrcpy:").grid(row=0, column=0, sticky="w", pady=4)
        ttk.Label(live_tab, textvariable=self.scrcpy_status_var, style="PanelStatus.TLabel", wraplength=320).grid(
            row=0,
            column=1,
            sticky="ew",
            pady=4,
        )
        ttk.Button(live_tab, text="Locate", command=self.locate_scrcpy).grid(row=0, column=2, sticky="ew", padx=(6, 0), pady=4)

        ttk.Label(live_tab, text="Profile:").grid(row=1, column=0, sticky="w", pady=4)
        default_profile = str(self.config.get("scrcpy_profile", "Balanced"))
        if default_profile not in SCRCPY_PROFILES:
            default_profile = "Balanced"
        self.live_profile_var = tk.StringVar(value=default_profile)
        self.live_profile_combo = ttk.Combobox(
            live_tab,
            textvariable=self.live_profile_var,
            values=list(SCRCPY_PROFILES.keys()),
            state="readonly",
        )
        self.live_profile_combo.grid(row=1, column=1, columnspan=2, sticky="ew", pady=4)
        self.live_profile_combo.bind("<<ComboboxSelected>>", lambda _event: self.update_live_profile_preview())

        self.live_profile_preview_var = tk.StringVar(value="")
        ttk.Label(live_tab, textvariable=self.live_profile_preview_var, style="PanelStatus.TLabel").grid(
            row=2,
            column=1,
            columnspan=2,
            sticky="ew",
            pady=(0, 8),
        )

        live_open_buttons = ttk.Frame(live_tab)
        live_open_buttons.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(6, 4))
        live_open_buttons.columnconfigure(0, weight=1)
        live_open_buttons.columnconfigure(1, weight=1)
        ttk.Button(live_open_buttons, text="Open Live", command=self.open_scrcpy).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(live_open_buttons, text="Open Default", command=self.open_scrcpy_default).grid(row=0, column=1, sticky="ew", padx=(4, 0))
        ttk.Button(live_tab, text="Open Low", command=lambda: self.open_scrcpy_with_profile("Low bandwidth")).grid(
            row=4,
            column=0,
            sticky="ew",
            pady=4,
            padx=(0, 4),
        )
        ttk.Button(live_tab, text="Open Balanced", command=lambda: self.open_scrcpy_with_profile("Balanced")).grid(
            row=4,
            column=1,
            sticky="ew",
            pady=4,
            padx=4,
        )
        ttk.Button(live_tab, text="Open Quality", command=lambda: self.open_scrcpy_with_profile("Quality")).grid(
            row=4,
            column=2,
            sticky="ew",
            pady=4,
            padx=(4, 0),
        )

        live_default_buttons = ttk.Frame(live_tab)
        live_default_buttons.grid(row=5, column=0, columnspan=3, sticky="ew", pady=(4, 8))
        for col in range(3):
            live_default_buttons.columnconfigure(col, weight=1)
        ttk.Button(live_default_buttons, text="Set Device", command=self.set_live_profile_for_selected_device).grid(
            row=0,
            column=0,
            sticky="ew",
            padx=(0, 4),
        )
        ttk.Button(live_default_buttons, text="Set Group", command=self.set_live_profile_for_selected_group).grid(
            row=0,
            column=1,
            sticky="ew",
            padx=4,
        )
        ttk.Button(live_default_buttons, text="Open Selected", command=self.open_selected_live).grid(
            row=0,
            column=2,
            sticky="ew",
            padx=(4, 0),
        )

        self.live_default_var = tk.StringVar(value="Default: current profile")
        ttk.Label(live_tab, textvariable=self.live_default_var, style="PanelStatus.TLabel", wraplength=360).grid(
            row=6,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(0, 8),
        )

        ttk.Separator(live_tab).grid(row=7, column=0, columnspan=3, sticky="ew", pady=(4, 10))
        self.live_session_var = tk.StringVar(value="No active live sessions.")
        ttk.Label(live_tab, textvariable=self.live_session_var, style="PanelStatus.TLabel", wraplength=360).grid(
            row=8,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(0, 6),
        )

        live_session_buttons = ttk.Frame(live_tab)
        live_session_buttons.grid(row=9, column=0, columnspan=3, sticky="ew", pady=(0, 8))
        for col in range(3):
            live_session_buttons.columnconfigure(col, weight=1)
        ttk.Button(live_session_buttons, text="Status", command=self.update_live_session_status).grid(
            row=0,
            column=0,
            sticky="ew",
            padx=(0, 4),
        )
        ttk.Button(live_session_buttons, text="Close Selected", command=self.close_selected_live).grid(
            row=0,
            column=1,
            sticky="ew",
            padx=4,
        )
        ttk.Button(live_session_buttons, text="Close All", command=self.close_all_live).grid(
            row=0,
            column=2,
            sticky="ew",
            padx=(4, 0),
        )

        live_reopen_buttons = ttk.Frame(live_tab)
        live_reopen_buttons.grid(row=10, column=0, columnspan=3, sticky="ew", pady=(0, 8))
        for col in range(3):
            live_reopen_buttons.columnconfigure(col, weight=1)
        ttk.Button(live_reopen_buttons, text="Reopen Last", command=self.reopen_last_live).grid(
            row=0,
            column=0,
            sticky="ew",
            padx=(0, 4),
        )
        self.live_watchdog_var = tk.BooleanVar(value=bool(self.config.get("live_watchdog_enabled", True)))
        ttk.Checkbutton(
            live_reopen_buttons,
            text="Watchdog",
            variable=self.live_watchdog_var,
            command=self.on_live_watchdog_toggle,
        ).grid(row=0, column=1, columnspan=2, sticky="w", padx=4)

        self.live_status_var = tk.StringVar(value="Select an online device, then open live control.")
        ttk.Label(live_tab, textvariable=self.live_status_var, style="PanelStatus.TLabel", wraplength=360).grid(
            row=11,
            column=0,
            columnspan=3,
            sticky="ew",
        )
        self.update_live_profile_preview()
        self.update_live_default_status()
        self.update_live_session_status()

    def _build_setup_tab(self, setup_tab: ttk.Frame) -> None:
        setup_tab.columnconfigure(1, weight=1)
        setup_tab.rowconfigure(1, weight=1)

        self.setup_selected_var = tk.StringVar(value="0 selected")
        ttk.Label(setup_tab, textvariable=self.setup_selected_var, font=("Segoe UI", 10, "bold")).grid(
            row=0,
            column=0,
            columnspan=3,
            sticky="w",
            pady=(0, 8),
        )

        self.setup_diagnostics_text = tk.Text(
            setup_tab,
            height=8,
            wrap=tk.WORD,
            state=tk.DISABLED,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=8,
            pady=8,
        )
        self.setup_diagnostics_text.grid(row=1, column=0, columnspan=3, sticky="nsew", pady=(0, 10))

        ttk.Button(setup_tab, text="Run Diagnostics", command=self.run_setup_diagnostics).grid(
            row=2,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(0, 12),
        )

        self.setup_stay_awake_var = tk.BooleanVar(value=True)
        self.setup_disable_animations_var = tk.BooleanVar(value=True)
        self.setup_timeout_var = tk.BooleanVar(value=True)
        self.setup_brightness_var = tk.BooleanVar(value=False)
        self.setup_wake_var = tk.BooleanVar(value=True)

        ttk.Checkbutton(setup_tab, text="Stay awake while charging", variable=self.setup_stay_awake_var).grid(
            row=3,
            column=0,
            columnspan=3,
            sticky="w",
            pady=3,
        )
        ttk.Checkbutton(setup_tab, text="Disable animations", variable=self.setup_disable_animations_var).grid(
            row=4,
            column=0,
            columnspan=3,
            sticky="w",
            pady=3,
        )
        ttk.Checkbutton(setup_tab, text="Set screen timeout", variable=self.setup_timeout_var).grid(row=5, column=0, sticky="w", pady=3)
        self.setup_timeout_input = ttk.Entry(setup_tab, width=8)
        self.setup_timeout_input.insert(0, str(self._read_int_config("setup_timeout_minutes", DEFAULT_SETUP_TIMEOUT_MINUTES, minimum=1)))
        self.setup_timeout_input.grid(row=5, column=1, sticky="w", pady=3)
        ttk.Label(setup_tab, text="minutes", style="Muted.TLabel").grid(row=5, column=2, sticky="w", pady=3)

        ttk.Checkbutton(setup_tab, text="Set brightness", variable=self.setup_brightness_var).grid(row=6, column=0, sticky="w", pady=3)
        self.setup_brightness_scale = ttk.Scale(setup_tab, from_=1, to=255, orient=tk.HORIZONTAL, command=self.on_setup_brightness_change)
        self.setup_brightness_scale.set(self._read_int_config("setup_brightness", DEFAULT_SETUP_BRIGHTNESS, minimum=1))
        self.setup_brightness_scale.grid(row=6, column=1, sticky="ew", pady=3)
        self.setup_brightness_label_var = tk.StringVar(value=str(DEFAULT_SETUP_BRIGHTNESS))
        ttk.Label(setup_tab, textvariable=self.setup_brightness_label_var, style="Muted.TLabel").grid(row=6, column=2, sticky="w", pady=3)

        ttk.Checkbutton(setup_tab, text="Wake device after setup", variable=self.setup_wake_var).grid(
            row=7,
            column=0,
            columnspan=3,
            sticky="w",
            pady=3,
        )

        self.setup_progress = ttk.Progressbar(setup_tab, mode="determinate", maximum=1)
        self.setup_progress.grid(row=8, column=0, columnspan=3, sticky="ew", pady=(14, 4))
        self.setup_status_var = tk.StringVar(value="Idle")
        ttk.Label(setup_tab, textvariable=self.setup_status_var, style="PanelStatus.TLabel").grid(
            row=9,
            column=0,
            columnspan=3,
            sticky="ew",
        )
        ttk.Button(setup_tab, text="Apply to Selected", command=self.apply_setup_to_selected).grid(
            row=10,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(12, 0),
        )

    def _build_apps_tab(self, apps_tab: ttk.Frame) -> None:
        apps_tab.columnconfigure(0, weight=1)
        apps_tab.rowconfigure(2, weight=1)
        apps_tab.rowconfigure(5, weight=1)

        top = ttk.Frame(apps_tab)
        top.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        top.columnconfigure(1, weight=1)
        ttk.Label(top, text="Search").grid(row=0, column=0, sticky="w", padx=(0, 6))
        self.apps_search_var = tk.StringVar()
        self.apps_search_entry = ttk.Entry(top, textvariable=self.apps_search_var)
        self.apps_search_entry.grid(row=0, column=1, sticky="ew")
        self.apps_search_entry.bind("<KeyRelease>", lambda _event: self.filter_apps_tree())
        self.apps_include_system_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(top, text="System", variable=self.apps_include_system_var).grid(row=0, column=2, padx=6)
        ttk.Button(top, text="Refresh", command=self.refresh_apps).grid(row=0, column=3, sticky="e")

        self.apps_status_var = tk.StringVar(value="Select a device, then refresh apps.")
        ttk.Label(apps_tab, textvariable=self.apps_status_var, style="PanelStatus.TLabel").grid(row=1, column=0, sticky="ew")

        columns = ("package",)
        self.apps_tree = ttk.Treeview(apps_tab, columns=columns, show="headings", selectmode="browse", height=8)
        self.apps_tree.heading("package", text="Package")
        self.apps_tree.column("package", width=280, anchor="w")
        self.apps_tree.grid(row=2, column=0, sticky="nsew", pady=(6, 8))
        self.apps_tree.bind("<<TreeviewSelect>>", self.on_app_select)
        apps_scroll = ttk.Scrollbar(apps_tab, orient=tk.VERTICAL, command=self.apps_tree.yview)
        self.apps_tree.configure(yscrollcommand=apps_scroll.set)
        apps_scroll.grid(row=2, column=1, sticky="ns", pady=(6, 8))

        buttons = ttk.Frame(apps_tab)
        buttons.grid(row=3, column=0, sticky="ew", pady=(0, 8))
        for col in range(4):
            buttons.columnconfigure(col, weight=1)
        ttk.Button(buttons, text="Open", command=self.open_selected_package).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(buttons, text="Install APK", command=self.install_apk_from_apps).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(buttons, text="Clear Data", style="Danger.TButton", command=self.clear_selected_package_data).grid(row=0, column=2, sticky="ew", padx=4)
        ttk.Button(buttons, text="Uninstall", style="Danger.TButton", command=self.uninstall_selected_package).grid(row=0, column=3, sticky="ew", padx=(4, 0))

        ttk.Label(apps_tab, text="Details", style="Section.TLabel").grid(row=4, column=0, sticky="w", pady=(4, 4))
        self.apps_detail_text = tk.Text(
            apps_tab,
            height=8,
            wrap=tk.WORD,
            state=tk.DISABLED,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=8,
            pady=8,
        )
        self.apps_detail_text.grid(row=5, column=0, sticky="nsew")

    def _build_apk_tab(self, apk_tab: ttk.Frame) -> None:
        apk_tab.columnconfigure(0, weight=1)
        apk_tab.rowconfigure(2, weight=1)
        apk_tab.rowconfigure(9, weight=1)

        path_row = ttk.Frame(apk_tab)
        path_row.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        path_row.columnconfigure(1, weight=1)
        ttk.Label(path_row, text="Library").grid(row=0, column=0, sticky="w", padx=(0, 6))
        self.apk_library_path_var = tk.StringVar(value=str(self.apk_library_dir))
        ttk.Label(path_row, textvariable=self.apk_library_path_var, style="PanelStatus.TLabel", wraplength=300).grid(
            row=0,
            column=1,
            sticky="ew",
        )
        ttk.Button(path_row, text="Open", command=self.open_apk_library_folder).grid(row=0, column=2, sticky="ew", padx=(6, 0))
        ttk.Button(path_row, text="Scan", command=lambda: self.scan_apk_library(announce=True)).grid(row=0, column=3, sticky="ew", padx=(6, 0))

        self.apk_status_var = tk.StringVar(value="Drop APK files into the library folder, then scan.")
        ttk.Label(apk_tab, textvariable=self.apk_status_var, style="PanelStatus.TLabel", wraplength=360).grid(
            row=1,
            column=0,
            sticky="ew",
            pady=(0, 6),
        )

        columns = ("name", "size", "modified")
        self.apk_tree = ttk.Treeview(apk_tab, columns=columns, show="headings", selectmode="browse", height=5)
        self.apk_tree.heading("name", text="APK")
        self.apk_tree.heading("size", text="Size")
        self.apk_tree.heading("modified", text="Modified")
        self.apk_tree.column("name", width=190, anchor="w")
        self.apk_tree.column("size", width=72, anchor="e")
        self.apk_tree.column("modified", width=118, anchor="center")
        self.apk_tree.grid(row=2, column=0, sticky="nsew", pady=(0, 6))
        self.apk_tree.bind("<<TreeviewSelect>>", self.on_apk_select)
        apk_scroll = ttk.Scrollbar(apk_tab, orient=tk.VERTICAL, command=self.apk_tree.yview)
        self.apk_tree.configure(yscrollcommand=apk_scroll.set)
        apk_scroll.grid(row=2, column=1, sticky="ns", pady=(0, 6))

        install_row = ttk.Frame(apk_tab)
        install_row.grid(row=3, column=0, sticky="ew", pady=(0, 10))
        for col in range(2):
            install_row.columnconfigure(col, weight=1)
        ttk.Button(install_row, text="Install Library APK", command=self.install_selected_library_apk).grid(
            row=0,
            column=0,
            sticky="ew",
            padx=(0, 4),
        )
        ttk.Button(install_row, text="Choose APK", command=self.install_chosen_apk_to_selected).grid(
            row=0,
            column=1,
            sticky="ew",
            padx=(4, 0),
        )

        ttk.Separator(apk_tab).grid(row=4, column=0, sticky="ew", pady=(2, 10))

        package_row = ttk.Frame(apk_tab)
        package_row.grid(row=5, column=0, sticky="ew", pady=(0, 8))
        package_row.columnconfigure(1, weight=1)
        ttk.Label(package_row, text="Package").grid(row=0, column=0, sticky="w", padx=(0, 6))
        self.apk_package_var = tk.StringVar()
        ttk.Entry(package_row, textvariable=self.apk_package_var).grid(row=0, column=1, sticky="ew")
        ttk.Button(package_row, text="Use Selected", command=self.set_apk_package_from_selected_app).grid(
            row=0,
            column=2,
            sticky="ew",
            padx=(6, 0),
        )

        package_buttons = ttk.Frame(apk_tab)
        package_buttons.grid(row=6, column=0, sticky="ew", pady=(0, 8))
        for col in range(3):
            package_buttons.columnconfigure(col, weight=1)
        ttk.Button(package_buttons, text="Compare", command=self.compare_package_on_selected_devices).grid(
            row=0,
            column=0,
            sticky="ew",
            padx=(0, 4),
        )
        ttk.Button(package_buttons, text="Clear Data", style="Danger.TButton", command=self.batch_clear_package_data).grid(
            row=0,
            column=1,
            sticky="ew",
            padx=4,
        )
        ttk.Button(package_buttons, text="Uninstall", style="Danger.TButton", command=self.batch_uninstall_package).grid(
            row=0,
            column=2,
            sticky="ew",
            padx=(4, 0),
        )

        self.apk_progress = ttk.Progressbar(apk_tab, mode="determinate", maximum=1)
        self.apk_progress.grid(row=7, column=0, sticky="ew", pady=(6, 4))

        ttk.Label(apk_tab, text="Result", style="Section.TLabel").grid(row=8, column=0, sticky="w", pady=(4, 4))
        self.apk_detail_text = tk.Text(
            apk_tab,
            height=8,
            wrap=tk.WORD,
            state=tk.DISABLED,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=8,
            pady=8,
        )
        self.apk_detail_text.grid(row=9, column=0, sticky="nsew")
        self.scan_apk_library(announce=False)

    def _build_policy_tab(self, policy_tab: ttk.Frame) -> None:
        policy_tab.columnconfigure(1, weight=1)

        self.current_package_var = tk.StringVar(value="-")
        ttk.Label(policy_tab, text="Current App:").grid(row=0, column=0, sticky="w", pady=4)
        ttk.Label(policy_tab, textvariable=self.current_package_var).grid(row=0, column=1, sticky="ew", pady=4)
        ttk.Button(policy_tab, text="Detect", command=self.detect_current_app).grid(row=0, column=2, sticky="ew", padx=(6, 0))

        ttk.Label(policy_tab, text="Package:").grid(row=1, column=0, sticky="w", pady=4)
        self.policy_package_input = ttk.Entry(policy_tab)
        self.policy_package_input.grid(row=1, column=1, columnspan=2, sticky="ew", pady=4)

        ttk.Label(policy_tab, text="Mode:").grid(row=2, column=0, sticky="w", pady=4)
        self.policy_mode_var = tk.StringVar(value=POLICY_MODE_LABELS["assisted"])
        self.policy_mode_combo = ttk.Combobox(
            policy_tab,
            textvariable=self.policy_mode_var,
            values=list(POLICY_MODE_LABELS.values()),
            state="readonly",
        )
        self.policy_mode_combo.grid(row=2, column=1, columnspan=2, sticky="ew", pady=4)

        self.policy_capture_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(policy_tab, text="Allow screenshots/thumbnails", variable=self.policy_capture_var).grid(
            row=3,
            column=1,
            columnspan=2,
            sticky="w",
            pady=4,
        )

        ttk.Label(policy_tab, text="Notes:").grid(row=4, column=0, sticky="w", pady=4)
        self.policy_notes_input = ttk.Entry(policy_tab)
        self.policy_notes_input.grid(row=4, column=1, columnspan=2, sticky="ew", pady=4)

        ttk.Button(policy_tab, text="Load", command=self.load_policy_from_package_input).grid(row=5, column=0, sticky="ew", pady=(10, 0), padx=(0, 4))
        ttk.Button(policy_tab, text="Save Policy", command=self.save_policy_from_form).grid(row=5, column=1, sticky="ew", pady=(10, 0), padx=4)
        ttk.Button(policy_tab, text="Clear Policy", command=self.clear_policy_from_form).grid(row=5, column=2, sticky="ew", pady=(10, 0), padx=(4, 0))

        self.policy_status_var = tk.StringVar(value="No package selected.")
        ttk.Label(policy_tab, textvariable=self.policy_status_var, style="PanelStatus.TLabel", wraplength=320).grid(
            row=6,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(12, 0),
        )

    def _build_workflow_tab(self, workflow_tab: ttk.Frame) -> None:
        workflow_tab.columnconfigure(1, weight=1)
        workflow_tab.rowconfigure(2, weight=1)

        ttk.Label(workflow_tab, text="Preset:").grid(row=0, column=0, sticky="w", pady=4)
        self.workflow_select_var = tk.StringVar()
        self.workflow_combo = ttk.Combobox(workflow_tab, textvariable=self.workflow_select_var, state="readonly")
        self.workflow_combo.grid(row=0, column=1, sticky="ew", pady=4)
        ttk.Button(workflow_tab, text="Load", command=self.load_selected_workflow).grid(row=0, column=2, sticky="ew", padx=(6, 0), pady=4)

        ttk.Label(workflow_tab, text="Name:").grid(row=1, column=0, sticky="w", pady=4)
        self.workflow_name_input = ttk.Entry(workflow_tab)
        self.workflow_name_input.grid(row=1, column=1, columnspan=2, sticky="ew", pady=4)

        ttk.Label(workflow_tab, text="Steps:").grid(row=2, column=0, sticky="nw", pady=4)
        editor_frame = ttk.Frame(workflow_tab)
        editor_frame.grid(row=2, column=1, columnspan=2, sticky="nsew", pady=4)
        editor_frame.rowconfigure(0, weight=1)
        editor_frame.columnconfigure(0, weight=1)
        self.workflow_text = tk.Text(
            editor_frame,
            height=10,
            wrap=tk.NONE,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=8,
            pady=8,
        )
        self.workflow_text.grid(row=0, column=0, sticky="nsew")
        workflow_scroll = ttk.Scrollbar(editor_frame, orient=tk.VERTICAL, command=self.workflow_text.yview)
        workflow_scroll.grid(row=0, column=1, sticky="ns")
        self.workflow_text.configure(yscrollcommand=workflow_scroll.set)

        workflow_actions = ttk.Frame(workflow_tab)
        workflow_actions.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(10, 0))
        for col in range(6):
            workflow_actions.columnconfigure(col, weight=1)
        ttk.Button(workflow_actions, text="Save", command=self.save_workflow_from_form).grid(row=0, column=0, sticky="ew", padx=(0, 3))
        ttk.Button(workflow_actions, text="Delete", style="Danger.TButton", command=self.delete_workflow_from_form).grid(row=0, column=1, sticky="ew", padx=3)
        ttk.Button(workflow_actions, text="Import", command=self.import_workflow_json).grid(row=0, column=2, sticky="ew", padx=3)
        ttk.Button(workflow_actions, text="Export", command=self.export_workflow_json).grid(row=0, column=3, sticky="ew", padx=3)
        ttk.Button(workflow_actions, text="Preview", command=self.preview_workflow_from_form).grid(row=0, column=4, sticky="ew", padx=3)
        ttk.Button(workflow_actions, text="Run", style="Accent.TButton", command=self.run_workflow_on_selected).grid(row=0, column=5, sticky="ew", padx=(3, 0))

        workflow_options = ttk.Frame(workflow_tab)
        workflow_options.grid(row=4, column=0, columnspan=3, sticky="ew", pady=(8, 0))
        self.workflow_confirm_var = tk.BooleanVar(value=bool(self.config.get("workflow_confirm_each_step", False)))
        self.workflow_dry_run_var = tk.BooleanVar(value=bool(self.config.get("workflow_dry_run", False)))
        ttk.Checkbutton(
            workflow_options,
            text="Confirm each step",
            variable=self.workflow_confirm_var,
            command=self.save_workflow_runtime_options,
        ).grid(row=0, column=0, sticky="w", padx=(0, 10))
        ttk.Checkbutton(
            workflow_options,
            text="Dry run",
            variable=self.workflow_dry_run_var,
            command=self.save_workflow_runtime_options,
        ).grid(row=0, column=1, sticky="w")

        self.workflow_progress = ttk.Progressbar(workflow_tab, mode="determinate", maximum=1)
        self.workflow_progress.grid(row=5, column=0, columnspan=3, sticky="ew", pady=(16, 4))
        self.workflow_status_var = tk.StringVar(value="Idle")
        ttk.Label(workflow_tab, textvariable=self.workflow_status_var, style="PanelStatus.TLabel").grid(row=6, column=0, columnspan=3, sticky="ew")

        self.refresh_workflow_selector()
        names = self.workflow_names()
        if names:
            self.workflow_select_var.set(names[0])
            self.load_workflow_into_form(names[0])

    def _build_node_tab(self, node_tab: ttk.Frame) -> None:
        node_tab.columnconfigure(1, weight=1)
        node_tab.rowconfigure(7, weight=1)

        ttk.Label(node_tab, text="Node Name:").grid(row=0, column=0, sticky="w", pady=4)
        self.node_name_var = tk.StringVar(value=str(self.config.get("node_name", "")))
        ttk.Entry(node_tab, textvariable=self.node_name_var).grid(row=0, column=1, sticky="ew", pady=4)
        ttk.Button(node_tab, text="Save", command=self.save_node_name).grid(row=0, column=2, sticky="ew", padx=(6, 0), pady=4)

        ttk.Label(node_tab, text="Node ID:").grid(row=1, column=0, sticky="w", pady=4)
        self.node_id_var = tk.StringVar(value=str(self.config.get("node_id", "")))
        ttk.Label(node_tab, textvariable=self.node_id_var, style="PanelStatus.TLabel", wraplength=300).grid(
            row=1,
            column=1,
            columnspan=2,
            sticky="ew",
            pady=4,
        )

        self.node_summary_var = tk.StringVar(value="")
        ttk.Label(node_tab, textvariable=self.node_summary_var, style="PanelStatus.TLabel", wraplength=360).grid(
            row=2,
            column=0,
            columnspan=3,
            sticky="ew",
            pady=(4, 10),
        )

        first_row = ttk.Frame(node_tab)
        first_row.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(0, 8))
        for col in range(3):
            first_row.columnconfigure(col, weight=1)
        ttk.Button(first_row, text="Backup", command=self.backup_node_from_ui).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(first_row, text="Restore", style="Danger.TButton", command=self.restore_backup_from_ui).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(first_row, text="Export Snapshot", command=self.export_node_snapshot_from_ui).grid(row=0, column=2, sticky="ew", padx=(4, 0))

        second_row = ttk.Frame(node_tab)
        second_row.grid(row=4, column=0, columnspan=3, sticky="ew", pady=(0, 10))
        for col in range(3):
            second_row.columnconfigure(col, weight=1)
        ttk.Button(second_row, text="View Snapshot", command=self.view_node_snapshot_from_ui).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(second_row, text="Backups", command=self.open_backup_folder).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(second_row, text="Snapshots", command=self.open_snapshot_folder).grid(row=0, column=2, sticky="ew", padx=(4, 0))

        ttk.Label(node_tab, text="Node Detail", style="Section.TLabel").grid(row=6, column=0, columnspan=3, sticky="w", pady=(4, 4))
        self.node_detail_text = tk.Text(
            node_tab,
            height=10,
            wrap=tk.WORD,
            state=tk.DISABLED,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=8,
            pady=8,
        )
        self.node_detail_text.grid(row=7, column=0, columnspan=3, sticky="nsew")
        self.update_node_summary()

    def _build_dashboard_tab(self, dashboard_tab: ttk.Frame) -> None:
        dashboard_tab.columnconfigure(0, weight=1)
        dashboard_tab.rowconfigure(2, weight=1)
        dashboard_tab.rowconfigure(5, weight=1)

        toolbar = ttk.Frame(dashboard_tab)
        toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        for col in range(4):
            toolbar.columnconfigure(col, weight=1)
        ttk.Button(toolbar, text="Add Current", command=self.add_current_node_to_dashboard).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(toolbar, text="Import", command=self.import_dashboard_snapshot_from_ui).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(toolbar, text="Refresh", command=self.refresh_dashboard_snapshots).grid(row=0, column=2, sticky="ew", padx=4)
        ttk.Button(toolbar, text="Folder", command=self.open_dashboard_folder).grid(row=0, column=3, sticky="ew", padx=(4, 0))

        self.dashboard_status_var = tk.StringVar(value="No snapshots loaded.")
        ttk.Label(dashboard_tab, textvariable=self.dashboard_status_var, style="PanelStatus.TLabel", wraplength=360).grid(
            row=1,
            column=0,
            sticky="ew",
            pady=(0, 6),
        )

        columns = ("node", "online", "total", "created")
        self.dashboard_tree = ttk.Treeview(dashboard_tab, columns=columns, show="headings", selectmode="browse", height=6)
        self.dashboard_tree.heading("node", text="Node")
        self.dashboard_tree.heading("online", text="Online")
        self.dashboard_tree.heading("total", text="Total")
        self.dashboard_tree.heading("created", text="Snapshot")
        self.dashboard_tree.column("node", width=150, anchor="w")
        self.dashboard_tree.column("online", width=70, anchor="center")
        self.dashboard_tree.column("total", width=60, anchor="center")
        self.dashboard_tree.column("created", width=130, anchor="center")
        self.dashboard_tree.grid(row=2, column=0, sticky="nsew", pady=(0, 8))
        self.dashboard_tree.bind("<<TreeviewSelect>>", self.on_dashboard_select)
        dashboard_scroll = ttk.Scrollbar(dashboard_tab, orient=tk.VERTICAL, command=self.dashboard_tree.yview)
        self.dashboard_tree.configure(yscrollcommand=dashboard_scroll.set)
        dashboard_scroll.grid(row=2, column=1, sticky="ns", pady=(0, 8))

        ttk.Button(dashboard_tab, text="Compare Snapshots", command=self.compare_dashboard_snapshots).grid(
            row=3,
            column=0,
            sticky="ew",
            pady=(0, 10),
        )

        ttk.Label(dashboard_tab, text="Dashboard Detail", style="Section.TLabel").grid(row=4, column=0, sticky="w", pady=(4, 4))
        self.dashboard_detail_text = tk.Text(
            dashboard_tab,
            height=8,
            wrap=tk.WORD,
            state=tk.DISABLED,
            background=COLOR_PANEL_ALT,
            foreground=COLOR_TEXT,
            relief=tk.FLAT,
            font=("Consolas", 9),
            padx=8,
            pady=8,
        )
        self.dashboard_detail_text.grid(row=5, column=0, sticky="nsew")
        self.refresh_dashboard_snapshots()

    def adb_required(self) -> AdbClient:
        if not self.adb:
            raise AdbError("ADB is not configured.")
        return self.adb

    def device_meta(self, serial: str) -> dict[str, str]:
        devices = self.device_state.setdefault("devices", {})
        raw = devices.setdefault(serial, {})
        if not isinstance(raw, dict):
            raw = {}
            devices[serial] = raw
        return raw

    def device_group(self, serial: str) -> str:
        group = str(self.device_meta(serial).get("group", "")).strip()
        return group or "Default"

    def device_slot(self, serial: str) -> str:
        return str(self.device_meta(serial).get("slot", "")).strip()

    def device_label(self, device: DeviceInfo) -> str:
        custom_name = str(self.device_meta(device.serial).get("name", "")).strip()
        return custom_name or device.model or device.serial

    def device_status_tag(self, device: DeviceInfo) -> str:
        if device.status == "device":
            return "online"
        if device.status == "unauthorized":
            return "unauthorized"
        if device.status in {"offline", "unknown"}:
            return "offline"
        return "error"

    def device_status_color(self, device: DeviceInfo) -> str:
        tag = self.device_status_tag(device)
        if tag == "online":
            return COLOR_SUCCESS
        if tag == "unauthorized":
            return COLOR_WARNING
        if tag == "error":
            return COLOR_DANGER
        return COLOR_MUTED

    def save_device_meta(self) -> None:
        try:
            save_device_state(self.device_state)
        except OSError as exc:
            self.log(f"Unable to save device metadata: {exc}")

    def save_app_config(self) -> None:
        try:
            save_config(self.config)
        except OSError as exc:
            self.log(f"Unable to save config: {exc}")

    def node_name(self) -> str:
        return str(self.config.get("node_name", "")).strip() or "Local Node"

    def node_id(self) -> str:
        return str(self.config.get("node_id", "")).strip()

    def write_node_details(self, text: str) -> None:
        if not hasattr(self, "node_detail_text"):
            return
        self.node_detail_text.configure(state=tk.NORMAL)
        self.node_detail_text.delete("1.0", tk.END)
        self.node_detail_text.insert("1.0", text)
        self.node_detail_text.configure(state=tk.DISABLED)

    def update_node_summary(self) -> None:
        online_count = sum(1 for device in self.devices.values() if device.online)
        total_count = len(self.devices)
        summary = f"{self.node_name()}  |  {online_count} online / {total_count} total  |  Local USB node"
        if hasattr(self, "node_summary_var"):
            self.node_summary_var.set(summary)
        if hasattr(self, "node_name_var"):
            self.node_name_var.set(self.node_name())
        if hasattr(self, "node_id_var"):
            self.node_id_var.set(self.node_id())
        if hasattr(self, "node_detail_text"):
            self.write_node_details(self.node_detail_text.get("1.0", tk.END).strip() or self.node_snapshot_summary_text(self.build_node_snapshot()))

    def save_node_name(self) -> None:
        name = self.node_name_var.get().strip() if hasattr(self, "node_name_var") else ""
        if not name:
            messagebox.showinfo(APP_NAME, "Enter a node name first.")
            return
        self.config["node_name"] = name
        self.save_app_config()
        self.update_node_summary()
        self.log(f"Saved node name: {name}.")

    def build_node_snapshot(self) -> dict[str, Any]:
        devices: list[dict[str, Any]] = []
        for device in sorted(self.devices.values(), key=lambda item: self.device_label(item).lower()):
            devices.append(
                {
                    "serial": device.serial,
                    "label": self.device_label(device),
                    "group": self.device_group(device.serial),
                    "slot": self.device_slot(device.serial),
                    "status": device.display_status,
                    "model": device.model,
                    "android": device.android,
                    "sdk": device.sdk,
                    "battery": device.battery,
                    "charging": device.charging,
                    "temperature": device.temperature,
                    "last_seen": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(device.last_seen)),
                }
            )
        online_count = sum(1 for device in self.devices.values() if device.online)
        return {
            "schema": "farm-manager.node-snapshot.v1",
            "app": APP_NAME,
            "app_version": APP_VERSION,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "node": {
                "id": self.node_id(),
                "name": self.node_name(),
                "host": os.getenv("COMPUTERNAME") or "",
            },
            "counts": {
                "online": online_count,
                "total": len(self.devices),
            },
            "devices": devices,
        }

    def node_snapshot_summary_text(self, snapshot: dict[str, Any]) -> str:
        node = snapshot.get("node", {}) if isinstance(snapshot.get("node"), dict) else {}
        counts = snapshot.get("counts", {}) if isinstance(snapshot.get("counts"), dict) else {}
        lines = [
            f"Node: {node.get('name', '-')}",
            f"ID: {node.get('id', '-')}",
            f"Created: {snapshot.get('created_at', '-')}",
            f"Devices: {counts.get('online', 0)} online / {counts.get('total', 0)} total",
            "",
        ]
        for device in snapshot.get("devices", []):
            if not isinstance(device, dict):
                continue
            lines.append(
                f"- {device.get('label') or device.get('serial')}  "
                f"{device.get('status', '-')}  "
                f"{device.get('model', '-')}  "
                f"{device.get('android', '-')}"
            )
            if device.get("serial"):
                lines.append(f"  {device.get('serial')}")
        return "\n".join(lines)

    def create_node_backup(self, output_dir: Path | None = None) -> Path:
        output_dir = output_dir or self.backup_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        backup_path = output_dir / f"farm-manager-backup-{safe_filename(self.node_name())}-{file_stamp()}.zip"
        snapshot = self.build_node_snapshot()
        manifest = {
            "schema": "farm-manager.backup.v1",
            "created_at": snapshot["created_at"],
            "app_version": APP_VERSION,
            "node": snapshot["node"],
            "files": [CONFIG_NAME, DEVICE_STATE_NAME, EVENT_DB_NAME],
        }
        with zipfile.ZipFile(backup_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("backup_manifest.json", json.dumps(manifest, indent=2))
            archive.writestr("node_snapshot.json", json.dumps(snapshot, indent=2))
            for path in (CONFIG_FILE, DEVICE_STATE_FILE, EVENT_DB_FILE):
                if path.exists():
                    archive.write(path, arcname=path.name)
        return backup_path

    def backup_node_from_ui(self) -> None:
        try:
            path = self.create_node_backup()
        except OSError as exc:
            messagebox.showerror(APP_NAME, f"Backup failed: {exc}")
            return
        self.write_node_details(f"Backup created:\n{path}")
        self.log(f"Node backup created: {path}.")

    def export_node_snapshot(self, output_dir: Path | None = None) -> Path:
        output_dir = output_dir or self.node_snapshot_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        snapshot = self.build_node_snapshot()
        path = output_dir / f"node-snapshot-{safe_filename(self.node_name())}-{file_stamp()}.json"
        path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        return path

    def export_node_snapshot_from_ui(self) -> None:
        try:
            path = self.export_node_snapshot()
            snapshot = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            messagebox.showerror(APP_NAME, f"Snapshot export failed: {exc}")
            return
        self.write_node_details(f"Snapshot exported:\n{path}\n\n{self.node_snapshot_summary_text(snapshot)}")
        self.log(f"Node snapshot exported: {path}.")

    def restore_backup_file(self, backup_path: Path) -> list[str]:
        restored: list[str] = []
        with zipfile.ZipFile(backup_path, "r") as archive:
            names = set(archive.namelist())
            if CONFIG_NAME in names:
                config_data = json.loads(archive.read(CONFIG_NAME).decode("utf-8"))
                if not isinstance(config_data, dict):
                    raise ValueError("Backup config is not an object.")
                save_config(config_data)
                restored.append(CONFIG_NAME)
            if DEVICE_STATE_NAME in names:
                state_data = json.loads(archive.read(DEVICE_STATE_NAME).decode("utf-8"))
                if not isinstance(state_data, dict):
                    raise ValueError("Backup device state is not an object.")
                save_device_state(state_data)
                restored.append(DEVICE_STATE_NAME)
        if not restored:
            raise ValueError("Backup did not contain restorable config/state files.")
        return restored

    def reload_after_restore(self) -> None:
        self.config = load_config()
        self.device_state = load_device_state()
        self.ensure_node_identity()
        self.adb_path = resolve_tool_path("adb", self.config.get("adb_path"))
        self.scrcpy_path = resolve_tool_path("scrcpy", self.config.get("scrcpy_path"))
        self.adb = AdbClient(self.adb_path) if self.adb_path else None
        self.adb_var.set(f"ADB: {self.adb_path or 'not found'}")
        self.refresh_scrcpy_status()
        self.refresh_workflow_selector()
        self.update_node_summary()
        self.update_info(self.devices.get(self.selected_serial) if self.selected_serial else None)

    def restore_backup_from_ui(self) -> None:
        path = filedialog.askopenfilename(
            title="Restore Farm Manager Backup",
            initialdir=str(self.backup_dir),
            filetypes=(("Farm Manager backup", "*.zip"), ("All files", "*.*")),
        )
        if not path:
            return
        if not messagebox.askyesno(APP_NAME, "Restore config and device state from this backup?"):
            return
        try:
            restored = self.restore_backup_file(Path(path))
            self.reload_after_restore()
        except (OSError, zipfile.BadZipFile, json.JSONDecodeError, ValueError) as exc:
            messagebox.showerror(APP_NAME, f"Restore failed: {exc}")
            return
        message = f"Restored: {', '.join(restored)}"
        self.write_node_details(f"{message}\n\nFrom:\n{path}")
        self.log(message)

    def view_node_snapshot_from_ui(self) -> None:
        path = filedialog.askopenfilename(
            title="View Node Snapshot",
            initialdir=str(self.node_snapshot_dir),
            filetypes=(("Node snapshot", "*.json"), ("All files", "*.*")),
        )
        if not path:
            return
        try:
            snapshot = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            messagebox.showerror(APP_NAME, f"Unable to read snapshot: {exc}")
            return
        self.write_node_details(self.node_snapshot_summary_text(snapshot))

    def open_backup_folder(self) -> None:
        try:
            self.backup_dir.mkdir(parents=True, exist_ok=True)
            os.startfile(str(self.backup_dir))  # type: ignore[attr-defined]
        except OSError as exc:
            self.log(f"Unable to open backup folder: {exc}")

    def open_snapshot_folder(self) -> None:
        try:
            self.node_snapshot_dir.mkdir(parents=True, exist_ok=True)
            os.startfile(str(self.node_snapshot_dir))  # type: ignore[attr-defined]
        except OSError as exc:
            self.log(f"Unable to open snapshot folder: {exc}")

    def write_dashboard_details(self, text: str) -> None:
        if not hasattr(self, "dashboard_detail_text"):
            return
        self.dashboard_detail_text.configure(state=tk.NORMAL)
        self.dashboard_detail_text.delete("1.0", tk.END)
        self.dashboard_detail_text.insert("1.0", text)
        self.dashboard_detail_text.configure(state=tk.DISABLED)

    def load_node_snapshot_file(self, path: Path) -> dict[str, Any]:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Snapshot is not an object.")
        if data.get("schema") != "farm-manager.node-snapshot.v1":
            raise ValueError("Unsupported snapshot schema.")
        node = data.get("node")
        devices = data.get("devices")
        if not isinstance(node, dict) or not isinstance(devices, list):
            raise ValueError("Snapshot is missing node or devices.")
        data["_path"] = str(path)
        return data

    def dashboard_snapshot_files(self) -> list[Path]:
        self.dashboard_dir.mkdir(parents=True, exist_ok=True)
        return sorted(self.dashboard_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)

    def refresh_dashboard_snapshots(self) -> None:
        snapshots: list[dict[str, Any]] = []
        failed = 0
        for path in self.dashboard_snapshot_files():
            try:
                snapshots.append(self.load_node_snapshot_file(path))
            except (OSError, json.JSONDecodeError, ValueError):
                failed += 1
        self.dashboard_snapshots = snapshots
        self.render_dashboard_tree()
        total_online = sum(int((snapshot.get("counts") or {}).get("online", 0)) for snapshot in snapshots if isinstance(snapshot.get("counts"), dict))
        total_devices = sum(int((snapshot.get("counts") or {}).get("total", 0)) for snapshot in snapshots if isinstance(snapshot.get("counts"), dict))
        suffix = f" / {failed} unreadable" if failed else ""
        if hasattr(self, "dashboard_status_var"):
            self.dashboard_status_var.set(f"{len(snapshots)} snapshot(s), {total_online} online / {total_devices} total{suffix}")
        if snapshots:
            self.write_dashboard_details(self.dashboard_summary_text(snapshots))
        elif hasattr(self, "dashboard_detail_text"):
            self.write_dashboard_details(f"No dashboard snapshots yet.\n\nFolder:\n{self.dashboard_dir}")

    def render_dashboard_tree(self) -> None:
        if not hasattr(self, "dashboard_tree"):
            return
        current = self.dashboard_tree.selection()[0] if self.dashboard_tree.selection() else ""
        for item in self.dashboard_tree.get_children():
            self.dashboard_tree.delete(item)
        for snapshot in self.dashboard_snapshots:
            path = str(snapshot.get("_path", ""))
            node = snapshot.get("node", {}) if isinstance(snapshot.get("node"), dict) else {}
            counts = snapshot.get("counts", {}) if isinstance(snapshot.get("counts"), dict) else {}
            self.dashboard_tree.insert(
                "",
                tk.END,
                iid=path,
                values=(
                    node.get("name", "-"),
                    counts.get("online", 0),
                    counts.get("total", 0),
                    snapshot.get("created_at", "-"),
                ),
            )
        if current and current in self.dashboard_tree.get_children():
            self.dashboard_tree.selection_set(current)
            self.dashboard_tree.focus(current)

    def dashboard_summary_text(self, snapshots: list[dict[str, Any]]) -> str:
        lines = ["Local Dashboard", ""]
        total_online = 0
        total_devices = 0
        serial_map: dict[str, list[str]] = {}
        for snapshot in snapshots:
            node = snapshot.get("node", {}) if isinstance(snapshot.get("node"), dict) else {}
            counts = snapshot.get("counts", {}) if isinstance(snapshot.get("counts"), dict) else {}
            online = int(counts.get("online", 0))
            total = int(counts.get("total", 0))
            total_online += online
            total_devices += total
            lines.append(f"- {node.get('name', '-')}  {online} online / {total} total  {snapshot.get('created_at', '-')}")
            for device in snapshot.get("devices", []):
                if not isinstance(device, dict):
                    continue
                serial = str(device.get("serial", "")).strip()
                if serial:
                    serial_map.setdefault(serial, []).append(f"{node.get('name', '-')}:{device.get('status', '-')}")
        lines.insert(1, f"Fleet: {total_online} online / {total_devices} total across {len(snapshots)} snapshot(s)")
        duplicates = {serial: entries for serial, entries in serial_map.items() if len(entries) > 1}
        if duplicates:
            lines.extend(["", "Serials seen in multiple snapshots:"])
            for serial, entries in sorted(duplicates.items()):
                lines.append(f"- {serial}: {', '.join(entries)}")
        return "\n".join(lines)

    def dashboard_snapshot_text(self, snapshot: dict[str, Any]) -> str:
        path = str(snapshot.get("_path", ""))
        body = self.node_snapshot_summary_text(snapshot)
        return f"{body}\n\nFile:\n{path}" if path else body

    def import_dashboard_snapshot(self, source_path: Path) -> Path:
        snapshot = self.load_node_snapshot_file(source_path)
        node = snapshot.get("node", {}) if isinstance(snapshot.get("node"), dict) else {}
        node_name = safe_filename(str(node.get("name", "node")))
        created = safe_filename(str(snapshot.get("created_at", file_stamp())).replace(":", "-").replace(" ", "-"))
        target = self.dashboard_dir / f"dashboard-{node_name}-{created}.json"
        counter = 2
        while target.exists():
            target = self.dashboard_dir / f"dashboard-{node_name}-{created}-{counter}.json"
            counter += 1
        shutil.copy2(source_path, target)
        return target

    def import_dashboard_snapshot_from_ui(self) -> None:
        path = filedialog.askopenfilename(
            title="Import Node Snapshot",
            initialdir=str(self.node_snapshot_dir),
            filetypes=(("Node snapshot", "*.json"), ("All files", "*.*")),
        )
        if not path:
            return
        try:
            target = self.import_dashboard_snapshot(Path(path))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            messagebox.showerror(APP_NAME, f"Import failed: {exc}")
            return
        self.refresh_dashboard_snapshots()
        self.write_dashboard_details(f"Imported snapshot:\n{target}")
        self.log(f"Imported dashboard snapshot: {target}.")

    def add_current_node_to_dashboard(self) -> None:
        try:
            source = self.export_node_snapshot(self.node_snapshot_dir)
            target = self.import_dashboard_snapshot(source)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            messagebox.showerror(APP_NAME, f"Add current node failed: {exc}")
            return
        self.refresh_dashboard_snapshots()
        self.write_dashboard_details(f"Added current node snapshot:\n{target}")
        self.log(f"Added current node snapshot to dashboard: {target}.")

    def on_dashboard_select(self, _event: tk.Event[Any] | None = None) -> None:
        if not hasattr(self, "dashboard_tree"):
            return
        selection = self.dashboard_tree.selection()
        if not selection:
            return
        path = selection[0]
        for snapshot in self.dashboard_snapshots:
            if str(snapshot.get("_path", "")) == path:
                self.write_dashboard_details(self.dashboard_snapshot_text(snapshot))
                return

    def compare_dashboard_snapshots(self) -> None:
        self.refresh_dashboard_snapshots()
        if not self.dashboard_snapshots:
            messagebox.showinfo(APP_NAME, "Import or add at least one snapshot first.")
            return
        self.write_dashboard_details(self.dashboard_summary_text(self.dashboard_snapshots))

    def open_dashboard_folder(self) -> None:
        try:
            self.dashboard_dir.mkdir(parents=True, exist_ok=True)
            os.startfile(str(self.dashboard_dir))  # type: ignore[attr-defined]
        except OSError as exc:
            self.log(f"Unable to open dashboard folder: {exc}")

    def scrcpy_status_text(self) -> str:
        if self.scrcpy_path:
            return str(self.scrcpy_path)
        return "not found"

    def refresh_scrcpy_status(self) -> None:
        self.scrcpy_path = resolve_tool_path("scrcpy", self.config.get("scrcpy_path"))
        if hasattr(self, "scrcpy_status_var"):
            self.scrcpy_status_var.set(self.scrcpy_status_text())

    def locate_scrcpy(self) -> None:
        path = filedialog.askopenfilename(
            title="Select scrcpy.exe",
            filetypes=(("scrcpy executable", "scrcpy.exe"), ("Executable", "*.exe"), ("All files", "*.*")),
        )
        if not path:
            return
        selected = Path(path)
        if not selected.exists():
            messagebox.showwarning(APP_NAME, "Selected file does not exist.")
            return
        self.config["scrcpy_path"] = str(selected)
        self.save_app_config()
        self.refresh_scrcpy_status()
        self.log(f"Saved scrcpy path: {selected}")

    def normalized_scrcpy_profile(self, profile_name: str | None) -> str:
        if profile_name not in SCRCPY_PROFILES:
            return "Balanced"
        return profile_name

    def selected_scrcpy_profile_name(self) -> str:
        profile_name = getattr(self, "live_profile_var", tk.StringVar(value="Balanced")).get()
        return self.normalized_scrcpy_profile(profile_name)

    def selected_scrcpy_profile(self, profile_name: str | None = None) -> dict[str, Any]:
        profile_name = self.normalized_scrcpy_profile(profile_name or self.selected_scrcpy_profile_name())
        self.config["scrcpy_profile"] = profile_name
        profile = dict(SCRCPY_PROFILES[profile_name])
        custom = self.config.get("scrcpy", {}) if isinstance(self.config.get("scrcpy"), dict) else {}
        if custom and bool(self.config.get("scrcpy_override_profiles", False)):
            profile.update({key: custom[key] for key in ("max_size", "max_fps", "bit_rate") if key in custom})
        return profile

    def group_live_profiles(self) -> dict[str, str]:
        profiles = self.device_state.setdefault("group_live_profiles", {})
        if not isinstance(profiles, dict):
            profiles = {}
            self.device_state["group_live_profiles"] = profiles
        return profiles

    def live_profile_for_device(self, device: DeviceInfo) -> str:
        device_profile = str(self.device_meta(device.serial).get("live_profile", "")).strip()
        if device_profile in SCRCPY_PROFILES:
            return device_profile
        group_profile = str(self.group_live_profiles().get(self.device_group(device.serial), "")).strip()
        if group_profile in SCRCPY_PROFILES:
            return group_profile
        return self.selected_scrcpy_profile_name()

    def update_live_default_status(self) -> None:
        if not hasattr(self, "live_default_var"):
            return
        if not self.selected_serial or self.selected_serial not in self.devices:
            self.live_default_var.set(f"Default: current profile ({self.selected_scrcpy_profile_name()})")
            return
        device = self.devices[self.selected_serial]
        group = self.device_group(device.serial)
        device_profile = str(self.device_meta(device.serial).get("live_profile", "")).strip()
        group_profile = str(self.group_live_profiles().get(group, "")).strip()
        effective = self.live_profile_for_device(device)
        source = "device" if device_profile in SCRCPY_PROFILES else "group" if group_profile in SCRCPY_PROFILES else "current"
        self.live_default_var.set(f"Default: {effective} ({source})  Group: {group}")

    def set_live_profile_for_selected_device(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        profile_name = self.selected_scrcpy_profile_name()
        self.device_meta(device.serial)["live_profile"] = profile_name
        self.save_device_meta()
        self.update_live_default_status()
        self.log(f"Saved live profile for {self.device_label(device)}: {profile_name}.")

    def set_live_profile_for_selected_group(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        group = self.device_group(device.serial)
        profile_name = self.selected_scrcpy_profile_name()
        self.group_live_profiles()[group] = profile_name
        self.save_device_meta()
        self.update_live_default_status()
        self.log(f"Saved live profile for group {group}: {profile_name}.")

    def update_live_profile_preview(self) -> None:
        if not hasattr(self, "live_profile_preview_var"):
            return
        profile_name = self.selected_scrcpy_profile_name()
        profile = dict(SCRCPY_PROFILES.get(profile_name, SCRCPY_PROFILES["Balanced"]))
        self.live_profile_preview_var.set(
            f"{profile['max_size']}px  {profile['max_fps']} fps  {profile['bit_rate']} bitrate"
        )
        self.update_live_default_status()

    def active_live_serials(self) -> list[str]:
        active: list[str] = []
        for serial, process in list(self.live_processes.items()):
            if process.poll() is None:
                active.append(serial)
            else:
                self.live_processes.pop(serial, None)
        return active

    def update_live_session_status(self) -> None:
        active = self.active_live_serials()
        if not hasattr(self, "live_session_var"):
            return
        if not active:
            self.live_session_var.set("No active live sessions.")
            return
        labels = [self.device_label(self.devices[serial]) if serial in self.devices else serial for serial in active]
        if len(labels) > 3:
            shown = ", ".join(labels[:3]) + f" +{len(labels) - 3}"
        else:
            shown = ", ".join(labels)
        self.live_session_var.set(f"{len(active)} active live session(s): {shown}")

    def close_live_process(self, serial: str) -> str:
        process = self.live_processes.pop(serial, None)
        if not process:
            return "not running"
        if process.poll() is not None:
            return "already closed"
        try:
            process.terminate()
            process.wait(timeout=2)
            return "closed"
        except subprocess.TimeoutExpired:
            try:
                process.kill()
                process.wait(timeout=2)
            except (subprocess.TimeoutExpired, OSError) as exc:
                return f"kill failed: {exc}"
            return "killed"
        except OSError as exc:
            return f"close failed: {exc}"

    def close_selected_live(self) -> None:
        if not self.selected_serial:
            messagebox.showinfo(APP_NAME, "Select a device first.")
            return
        result = self.close_live_process(self.selected_serial)
        label = self.device_label(self.devices[self.selected_serial]) if self.selected_serial in self.devices else self.selected_serial
        message = f"Live session for {label}: {result}."
        self.log(message)
        if hasattr(self, "live_status_var"):
            self.live_status_var.set(message)
        self.update_live_session_status()

    def close_all_live(self) -> None:
        serials = list(self.live_processes)
        if not serials:
            self.update_live_session_status()
            if hasattr(self, "live_status_var"):
                self.live_status_var.set("No active live sessions to close.")
            return
        results = [self.close_live_process(serial) for serial in serials]
        closed_count = sum(1 for result in results if result in {"closed", "killed", "already closed"})
        message = f"Closed {closed_count}/{len(serials)} live session(s)."
        self.log(message)
        if hasattr(self, "live_status_var"):
            self.live_status_var.set(message)
        self.update_live_session_status()

    def on_live_watchdog_toggle(self) -> None:
        enabled = bool(self.live_watchdog_var.get()) if hasattr(self, "live_watchdog_var") else True
        self.config["live_watchdog_enabled"] = enabled
        self.save_app_config()
        if enabled:
            self.log("Live watchdog enabled.")
            self.schedule_live_watchdog()
        else:
            self.log("Live watchdog disabled.")
            if self.live_watchdog_after_id:
                self.root.after_cancel(self.live_watchdog_after_id)
                self.live_watchdog_after_id = None

    def schedule_live_watchdog(self) -> None:
        if not hasattr(self, "live_watchdog_var") or not self.live_watchdog_var.get():
            return
        if self.live_watchdog_after_id:
            self.root.after_cancel(self.live_watchdog_after_id)
        self.live_watchdog_after_id = self.root.after(5000, self.run_live_watchdog)

    def run_live_watchdog(self) -> None:
        self.live_watchdog_after_id = None
        before = set(self.live_processes)
        active = set(self.active_live_serials())
        closed = before - active
        if closed:
            self.update_live_session_status()
            labels = [self.device_label(self.devices[serial]) if serial in self.devices else serial for serial in sorted(closed)]
            message = f"Live watchdog cleaned {len(closed)} closed session(s): {', '.join(labels[:3])}"
            if len(labels) > 3:
                message += f" +{len(labels) - 3}"
            self.log(message)
            if hasattr(self, "live_status_var"):
                self.live_status_var.set(message)
        else:
            self.update_live_session_status()
        self.schedule_live_watchdog()

    def workflow_store(self) -> dict[str, str]:
        workflows = self.device_state.setdefault("workflows", {})
        if not isinstance(workflows, dict):
            workflows = {}
            self.device_state["workflows"] = workflows
        return workflows

    def ensure_default_workflows(self) -> None:
        workflows = self.workflow_store()
        if workflows:
            return
        workflows["Wake Home"] = "wake\nwait 500\nhome\n"
        workflows["Settings Screenshot"] = "open com.android.settings\nwait 1000\nscreenshot\n"
        self.save_device_meta()

    def workflow_names(self) -> list[str]:
        return sorted(str(name) for name in self.workflow_store().keys())

    def refresh_workflow_selector(self) -> None:
        if hasattr(self, "workflow_combo"):
            self.workflow_combo.configure(values=self.workflow_names())

    def save_workflow_runtime_options(self) -> None:
        if hasattr(self, "workflow_confirm_var"):
            self.config["workflow_confirm_each_step"] = bool(self.workflow_confirm_var.get())
        if hasattr(self, "workflow_dry_run_var"):
            self.config["workflow_dry_run"] = bool(self.workflow_dry_run_var.get())
        self.save_app_config()

    def load_selected_workflow(self) -> None:
        name = self.workflow_select_var.get().strip()
        if not name:
            return
        self.load_workflow_into_form(name)

    def load_workflow_into_form(self, name: str) -> None:
        workflow = str(self.workflow_store().get(name, ""))
        self.workflow_name_input.delete(0, tk.END)
        self.workflow_name_input.insert(0, name)
        self.workflow_text.delete("1.0", tk.END)
        self.workflow_text.insert("1.0", workflow)
        self.workflow_status_var.set(f"Loaded {name}.")

    def save_workflow_from_form(self) -> None:
        name = self.workflow_name_input.get().strip()
        if not name:
            messagebox.showinfo(APP_NAME, "Enter a workflow name first.")
            return
        text = self.workflow_text.get("1.0", tk.END).strip() + "\n"
        try:
            parse_workflow_text(text)
        except ValueError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        self.workflow_store()[name] = text
        self.save_device_meta()
        self.refresh_workflow_selector()
        self.workflow_select_var.set(name)
        self.workflow_status_var.set(f"Saved {name}.")
        self.log(f"Saved workflow '{name}'.")

    def workflow_preview_lines(self, name: str, steps: list[WorkflowStep]) -> list[str]:
        lines = [f"Workflow: {name}", f"Steps: {len(steps)}", ""]
        for index, step in enumerate(steps, start=1):
            lines.append(f"{index}. {step.command} {step.argument}".strip())
        return lines

    def preview_workflow_from_form(self) -> None:
        name = self.workflow_name_input.get().strip() or self.workflow_select_var.get().strip() or "Workflow"
        try:
            steps = parse_workflow_text(self.workflow_text.get("1.0", tk.END))
        except ValueError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        lines = self.workflow_preview_lines(name, steps)
        messagebox.showinfo(APP_NAME, "\n".join(lines[:32]))
        self.workflow_status_var.set(f"Previewed {len(steps)} step(s).")
        self.log(f"Previewed workflow '{name}' with {len(steps)} step(s).")

    def export_workflow_json(self) -> None:
        name = self.workflow_name_input.get().strip() or self.workflow_select_var.get().strip()
        if not name:
            messagebox.showinfo(APP_NAME, "Enter or load a workflow first.")
            return
        text = self.workflow_text.get("1.0", tk.END).strip() + "\n"
        try:
            parse_workflow_text(text)
        except ValueError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        default_name = f"{re.sub(r'[^A-Za-z0-9_.-]+', '_', name).strip('_') or 'workflow'}.json"
        path = filedialog.asksaveasfilename(
            title="Export Workflow",
            defaultextension=".json",
            initialfile=default_name,
            filetypes=(("JSON", "*.json"), ("All files", "*.*")),
        )
        if not path:
            return
        payload = {
            "schema": "farm-manager.workflow.v1",
            "name": name,
            "steps": text.strip().splitlines(),
        }
        try:
            Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError as exc:
            messagebox.showerror(APP_NAME, f"Export failed: {exc}")
            return
        self.workflow_status_var.set(f"Exported {name}.")
        self.log(f"Exported workflow '{name}' to {path}.")

    def import_workflow_json(self) -> None:
        path = filedialog.askopenfilename(
            title="Import Workflow",
            filetypes=(("JSON", "*.json"), ("All files", "*.*")),
        )
        if not path:
            return
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            imported = workflow_import_map(data)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            messagebox.showerror(APP_NAME, f"Import failed: {exc}")
            return
        store = self.workflow_store()
        overwritten = [name for name in imported if name in store]
        if overwritten and not messagebox.askyesno(APP_NAME, f"Overwrite {len(overwritten)} existing workflow(s)?"):
            return
        store.update(imported)
        self.save_device_meta()
        self.refresh_workflow_selector()
        first_name = sorted(imported)[0]
        self.workflow_select_var.set(first_name)
        self.load_workflow_into_form(first_name)
        self.workflow_status_var.set(f"Imported {len(imported)} workflow(s).")
        self.log(f"Imported {len(imported)} workflow(s) from {path}.")

    def delete_workflow_from_form(self) -> None:
        name = self.workflow_name_input.get().strip() or self.workflow_select_var.get().strip()
        if not name:
            return
        if not messagebox.askyesno(APP_NAME, f"Delete workflow '{name}'?"):
            return
        self.workflow_store().pop(name, None)
        self.save_device_meta()
        self.refresh_workflow_selector()
        self.workflow_name_input.delete(0, tk.END)
        self.workflow_text.delete("1.0", tk.END)
        names = self.workflow_names()
        if names:
            self.workflow_select_var.set(names[0])
            self.load_workflow_into_form(names[0])
        else:
            self.workflow_select_var.set("")
        self.log(f"Deleted workflow '{name}'.")

    def run_workflow_on_selected(self) -> None:
        if self.workflow_running:
            self.log("A workflow is already running.")
            return
        if self.batch_running or self.busy:
            self.log("Wait for the current action to finish first.")
            return
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        name = self.workflow_name_input.get().strip() or self.workflow_select_var.get().strip() or "Workflow"
        text = self.workflow_text.get("1.0", tk.END)
        try:
            steps = parse_workflow_text(text)
        except ValueError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        dry_run = bool(self.workflow_dry_run_var.get()) if hasattr(self, "workflow_dry_run_var") else False
        confirm_each = bool(self.workflow_confirm_var.get()) if hasattr(self, "workflow_confirm_var") else False
        self.save_workflow_runtime_options()
        mode_bits = []
        if dry_run:
            mode_bits.append("dry run")
        if confirm_each:
            mode_bits.append("confirm each step")
        mode_text = f"\nMode: {', '.join(mode_bits)}" if mode_bits else ""
        if not messagebox.askyesno(APP_NAME, f"Run '{name}' on {len(devices)} selected online device(s)?{mode_text}"):
            return

        self.workflow_running = True
        total = len(devices) * len(steps)
        self.workflow_progress.configure(maximum=total, value=0)
        self.workflow_status_var.set(f"{name}: 0/{total}")
        self.status_var.set(f"Workflow {name} running...")
        dry_note = " dry-run" if dry_run else ""
        self.log(f"Workflow '{name}' started for {len(devices)} device(s), {len(steps)} step(s).{dry_note}")

        def work() -> None:
            ok_count = 0
            fail_count = 0
            skipped_count = 0
            done = 0
            for device in devices:
                label = self.device_label(device)
                for step in steps:
                    done += 1
                    self.events.put(
                        (
                            "workflow_progress",
                            {
                                "name": name,
                                "done": done,
                                "total": total,
                                "label": label,
                                "step": f"{step.command} {step.argument}".strip(),
                            },
                        )
                    )
                    try:
                        if confirm_each and not self.confirm_workflow_step(name, label, step, dry_run=dry_run):
                            skipped_count += 1
                            self.events.put(("workflow_log", f"{name} skipped on {label}, line {step.line_no}."))
                            continue
                        result = self.run_workflow_step(device, step, name, dry_run=dry_run)
                        ok_count += 1
                        if result:
                            self.events.put(("workflow_log", f"{name} OK on {label}: {result}"))
                    except Exception as exc:
                        fail_count += 1
                        self.events.put(("workflow_log", f"{name} FAILED on {label}, line {step.line_no}: {exc}"))
                        break
                    finally:
                        self.events.put(("workflow_step_done", done))
            self.events.put(("workflow_done", {"name": name, "ok": ok_count, "fail": fail_count, "skipped": skipped_count, "total": total}))

        threading.Thread(target=work, daemon=True).start()

    def confirm_workflow_step(self, workflow_name: str, device_label: str, step: WorkflowStep, *, dry_run: bool) -> bool:
        request: dict[str, Any] = {
            "event": threading.Event(),
            "approved": False,
            "workflow": workflow_name,
            "device": device_label,
            "step": step,
            "dry_run": dry_run,
        }
        self.events.put(("workflow_confirm_step", request))
        request["event"].wait()
        return bool(request.get("approved", False))

    def run_workflow_step(self, device: DeviceInfo, step: WorkflowStep, workflow_name: str, *, dry_run: bool = False) -> str:
        serial = device.serial
        command = step.command
        argument = step.argument
        if dry_run:
            return f"dry-run {command} {argument}".strip()
        if command == "wait":
            milliseconds = int(argument)
            time.sleep(milliseconds / 1000)
            return f"wait {milliseconds}ms"
        if command in WORKFLOW_KEY_ALIASES:
            self.check_policy_for_device(serial, workflow_name)
            self.adb_required().keyevent(serial, WORKFLOW_KEY_ALIASES[command])
            return command
        if command == "keyevent":
            self.check_policy_for_device(serial, workflow_name)
            self.adb_required().keyevent(serial, argument)
            return argument
        if command == "open":
            self.check_policy_for_device(serial, workflow_name, package_name=argument, allow_manual_only=True)
            self.adb_required().open_package(serial, argument)
            return f"open {argument}"
        if command == "text":
            self.check_policy_for_device(serial, workflow_name)
            self.adb_required().input_text(serial, argument)
            return "text sent"
        if command == "screenshot":
            self.check_policy_for_device(serial, workflow_name, allow_manual_only=True, require_capture=True)
            output_dir = Path(tempfile.gettempdir()) / "FarmManager" / "workflows"
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / f"{self.safe_serial_name(serial)}_{time.strftime('%Y%m%d_%H%M%S')}.png"
            self.adb_required().screenshot(serial, output_path)
            return str(output_path)
        raise AdbError(f"Unsupported workflow command: {command}")

    def policy_meta(self, package_name: str) -> dict[str, Any]:
        policies = self.device_state.setdefault("policies", {})
        raw = policies.setdefault(package_name, {})
        if not isinstance(raw, dict):
            raw = {}
            policies[package_name] = raw
        raw.setdefault("mode", "assisted")
        raw.setdefault("allow_capture", True)
        raw.setdefault("notes", "")
        return raw

    def policy_for_package(self, package_name: str) -> dict[str, Any]:
        policies = self.device_state.get("policies", {})
        if isinstance(policies, dict) and isinstance(policies.get(package_name), dict):
            data = dict(policies[package_name])
        else:
            data = {}
        data.setdefault("mode", "assisted")
        data.setdefault("allow_capture", True)
        data.setdefault("notes", "")
        return data

    def check_policy_for_device(
        self,
        serial: str,
        action_name: str,
        *,
        package_name: str | None = None,
        allow_manual_only: bool = False,
        require_capture: bool = False,
    ) -> str:
        package = package_name or self.adb_required().current_package(serial)
        if not package:
            return ""
        policy = self.policy_for_package(package)
        mode = str(policy.get("mode", "assisted"))
        allow_capture = bool(policy.get("allow_capture", True))
        if require_capture and not allow_capture:
            raise AdbError(f"Policy blocks screenshots/thumbnails for {package}.")
        if mode == "blocked":
            raise AdbError(f"Policy blocks {action_name} while {package} is active.")
        if mode == "manual_only" and not allow_manual_only:
            raise AdbError(f"Policy marks {package} as manual-only; use live manual control instead of ADB automation.")
        return package

    def on_auto_scan_toggle(self) -> None:
        if self.auto_scan_var.get():
            self.log(f"Auto scan enabled every {self.auto_scan_interval_seconds}s.")
            self.schedule_auto_scan()
        else:
            self.log("Auto scan disabled.")
            if self.auto_scan_after_id:
                self.root.after_cancel(self.auto_scan_after_id)
                self.auto_scan_after_id = None

    def schedule_auto_scan(self) -> None:
        if not getattr(self, "auto_scan_var", None) or not self.auto_scan_var.get():
            return
        if self.auto_scan_after_id:
            self.root.after_cancel(self.auto_scan_after_id)
        self.auto_scan_after_id = self.root.after(self.auto_scan_interval_seconds * 1000, self.run_scheduled_auto_scan)

    def run_scheduled_auto_scan(self) -> None:
        self.auto_scan_after_id = None
        if not self.auto_scan_var.get():
            return
        self.refresh_devices(auto=True)

    def selected_devices(self, *, online_only: bool = True) -> list[DeviceInfo]:
        serials = list(self.device_tree.selection())
        devices: list[DeviceInfo] = []
        for serial in serials:
            device = self.devices.get(serial)
            if not device:
                continue
            if online_only and not device.online:
                continue
            devices.append(device)
        return devices

    def selected_online_devices_or_warn(self) -> list[DeviceInfo]:
        devices = self.selected_devices(online_only=True)
        if not devices:
            messagebox.showinfo(APP_NAME, "Select one or more online devices first.")
        return devices

    def on_thumbnail_frame_configure(self, _event: tk.Event[Any] | None = None) -> None:
        self.thumbnail_canvas.configure(scrollregion=self.thumbnail_canvas.bbox("all"))

    def on_thumbnail_canvas_configure(self, event: tk.Event[Any]) -> None:
        self.thumbnail_canvas.itemconfigure(self.thumbnail_window, width=event.width)
        if self.thumbnail_column_count() != getattr(self, "_thumbnail_columns", None):
            self.render_thumbnail_cards()

    def on_thumbnail_mousewheel(self, event: tk.Event[Any]) -> None:
        first, last = self.thumbnail_canvas.yview()
        if first <= 0.0 and last >= 1.0:
            return
        self.thumbnail_canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")

    def thumbnail_column_count(self) -> int:
        width = max(self.thumbnail_canvas.winfo_width(), 230)
        return max(1, width // 212)

    def on_card_click(self, event: tk.Event[Any], serial: str) -> None:
        # Ctrl+click adds or removes a device from the selection; plain click selects one.
        if int(event.state) & 0x0004 and serial in self.devices:
            self.device_tree.selection_toggle(serial)
            return
        self.select_device(serial)

    def safe_serial_name(self, serial: str) -> str:
        return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in serial)

    def render_thumbnail_cards(self) -> None:
        if not hasattr(self, "thumbnail_frame"):
            return
        for child in self.thumbnail_frame.winfo_children():
            child.destroy()
        self.thumbnail_cards.clear()

        columns = self.thumbnail_column_count()
        self._thumbnail_columns = columns
        devices = list(self.devices.values())
        if not devices:
            self.empty_grid_label = ttk.Label(
                self.thumbnail_frame,
                text="No devices yet\n\nConnect phones by USB, allow USB debugging, then press Refresh.",
                anchor="center",
                wraplength=320,
                justify="center",
                style="Muted.TLabel",
            )
            self.empty_grid_label.grid(row=0, column=0, padx=16, pady=48, sticky="nsew")
            self.thumbnail_frame.columnconfigure(0, weight=1)
            return

        for index, device in enumerate(devices):
            row, col = divmod(index, columns)
            card = RoundedCard(
                self.thumbnail_frame, fill=COLOR_PANEL_ALT, outline=COLOR_BORDER, outer=COLOR_PANEL,
                radius=16, padding=12, fit_width=True, fit_height=True,
            )
            card.grid(row=row, column=col, padx=7, pady=7, sticky="n")
            body = card.inner
            body.columnconfigure(0, weight=1)

            head = tk.Frame(body, background=COLOR_PANEL_ALT)
            head.grid(row=0, column=0, sticky="ew")
            head.columnconfigure(0, weight=1)
            # width=1 lets the grid cell, not the text, decide the label width
            title = tk.Label(
                head,
                text=self.device_label(device),
                font=("Segoe UI", 10, "bold"),
                anchor="w",
                width=1,
                background=COLOR_PANEL_ALT,
                foreground=COLOR_TEXT,
            )
            title.grid(row=0, column=0, sticky="ew")
            badge = tk.Label(head, text=device.display_status, font=("Segoe UI", 8, "bold"), padx=8, pady=2)
            badge.grid(row=0, column=1, sticky="e", padx=(6, 0))

            serial_label = tk.Label(
                body,
                text=device.serial,
                font=("Consolas", 8),
                anchor="w",
                width=1,
                background=COLOR_PANEL_ALT,
                foreground=COLOR_MUTED,
            )
            serial_label.grid(row=1, column=0, sticky="ew", pady=(1, 8))

            canvas = tk.Canvas(
                body,
                width=THUMBNAIL_MAX_WIDTH,
                height=THUMBNAIL_MAX_HEIGHT,
                highlightthickness=0,
                background=COLOR_DARK,
            )
            canvas.grid(row=2, column=0)

            meta = tk.Label(
                body,
                anchor="w",
                justify="left",
                wraplength=THUMBNAIL_MAX_WIDTH,
                background=COLOR_PANEL_ALT,
                foreground=COLOR_MUTED,
                font=("Segoe UI", 8),
            )
            meta.grid(row=3, column=0, sticky="ew", pady=(8, 0))

            for widget in (card, body, head, title, badge, serial_label, canvas, meta):
                widget.bind("<Button-1>", lambda event, serial=device.serial: self.on_card_click(event, serial))
                widget.bind("<Double-Button-1>", lambda _event, serial=device.serial: self.open_live_from_thumbnail(serial))

            self.thumbnail_cards[device.serial] = {
                "frame": card,
                "canvas": canvas,
                "title": title,
                "meta": meta,
                "badge": badge,
            }
            self.paint_thumbnail_card(device.serial)

        for col in range(columns):
            self.thumbnail_frame.columnconfigure(col, weight=0)
        self.update_thumbnail_selection()

    def paint_thumbnail_card(self, serial: str) -> None:
        card = self.thumbnail_cards.get(serial)
        device = self.devices.get(serial)
        if not card or not device:
            return

        frame: RoundedCard = card["frame"]
        canvas: tk.Canvas = card["canvas"]
        meta: tk.Label = card["meta"]
        badge: tk.Label = card["badge"]
        canvas.delete("all")
        selected = serial == self.selected_serial or serial in self.device_tree.selection()
        frame.set_colors(outline=COLOR_ACCENT if selected else COLOR_BORDER, line_width=2 if selected else 1)
        canvas.configure(background=COLOR_DARK)

        badge_colors = {
            "online": (COLOR_SUCCESS, COLOR_SUCCESS_SOFT),
            "unauthorized": (COLOR_WARNING, COLOR_WARNING_SOFT),
            "error": (COLOR_DANGER, COLOR_DANGER_SOFT),
        }
        badge_fg, badge_bg = badge_colors.get(self.device_status_tag(device), (COLOR_MUTED, COLOR_PANEL))
        badge.configure(text=device.display_status, foreground=badge_fg, background=badge_bg)

        image = self.thumbnail_images.get(serial)
        if image and device.online:
            x = THUMBNAIL_MAX_WIDTH // 2
            y = THUMBNAIL_MAX_HEIGHT // 2
            canvas.create_image(x, y, image=image, anchor=tk.CENTER)
        else:
            text = "No screen yet" if device.online else "Offline"
            if serial in self.thumbnail_errors:
                text = "Capture failed"
            canvas.create_text(
                THUMBNAIL_MAX_WIDTH // 2,
                THUMBNAIL_MAX_HEIGHT // 2,
                text=text,
                fill="#8891a8",
                font=("Segoe UI", 10),
            )

        status_bits = [self.device_group(serial)]
        if device.battery:
            status_bits.append(device.battery)
        updated_at = self.thumbnail_updated_at.get(serial)
        if updated_at:
            status_bits.append(time.strftime("%H:%M:%S", time.localtime(updated_at)))
        if serial in self.thumbnail_errors:
            status_bits.append("screen error")
        meta.configure(text="  ·  ".join(status_bits))

    def update_thumbnail_selection(self) -> None:
        for serial in self.thumbnail_cards:
            self.paint_thumbnail_card(serial)

    def select_device(self, serial: str) -> None:
        if serial not in self.devices:
            return
        self.selected_serial = serial
        self.device_tree.selection_remove(self.device_tree.selection())
        self.device_tree.selection_set(serial)
        self.device_tree.focus(serial)
        self.device_tree.see(serial)
        self.update_info(self.devices.get(serial))
        self.update_thumbnail_selection()
        self.update_batch_selection_summary()
        self.update_live_default_status()

    def open_live_from_thumbnail(self, serial: str) -> None:
        self.select_device(serial)
        self.open_scrcpy()

    def refresh_devices(self, *, auto: bool = False) -> None:
        if self.busy:
            if auto:
                self.schedule_auto_scan()
            return
        if not self.adb:
            self.log("ADB is not available.")
            if auto:
                self.schedule_auto_scan()
            return
        self.busy = True
        self.status_var.set("Refreshing devices...")
        self.log("Scanning ADB devices..." if not auto else "Auto scanning ADB devices...")

        def work() -> None:
            try:
                try:
                    devices = self.adb_required().list_devices()
                except Exception as first_exc:
                    if not self.auto_restart_adb:
                        raise
                    self.events.put(("message", f"ADB scan failed, restarting server once: {first_exc}"))
                    self.adb_required().restart_server()
                    devices = self.adb_required().list_devices()
                enriched: list[DeviceInfo] = []
                for device in devices:
                    enriched.append(self.adb_required().enrich_device(device))
                self.events.put(("devices", enriched))
            except Exception as exc:
                self.events.put(("error", str(exc)))
            finally:
                self.events.put(("busy", False))

        threading.Thread(target=work, daemon=True).start()

    def restart_adb(self) -> None:
        if self.busy:
            return
        if not self.adb:
            self.log("ADB is not available.")
            return
        self.busy = True
        self.status_var.set("Restarting ADB server...")
        self.log("Restarting ADB server...")

        def work() -> None:
            try:
                self.adb_required().restart_server()
                self.events.put(("message", "ADB server restarted."))
                self.events.put(("refresh", None))
            except Exception as exc:
                self.events.put(("error", str(exc)))
            finally:
                self.events.put(("busy", False))

        threading.Thread(target=work, daemon=True).start()

    def refresh_selected_thumbnail(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        self.refresh_thumbnails(devices=[device])

    def refresh_thumbnails(self, devices: list[DeviceInfo] | None = None) -> None:
        if self.thumbnail_refreshing:
            return
        if not self.adb:
            self.log("ADB is not available.")
            return
        online_devices = [device for device in (devices or list(self.devices.values())) if device.online]
        if not online_devices:
            self.thumbnail_status_var.set("No online devices")
            self.log("No online devices for thumbnail refresh.")
            return

        self.thumbnail_refreshing = True
        self.thumbnail_status_var.set(f"Capturing {len(online_devices)}...")
        self.log(f"Refreshing thumbnails for {len(online_devices)} device(s).")

        def work() -> None:
            ok_count = 0
            for device in online_devices:
                try:
                    self.check_policy_for_device(device.serial, "Thumbnail", allow_manual_only=True, require_capture=True)
                    image_bytes = self.adb_required().screenshot_bytes(device.serial)
                    output_path = self.thumbnail_dir / f"{self.safe_serial_name(device.serial)}.png"
                    output_path.write_bytes(image_bytes)
                    ok_count += 1
                    self.events.put(("thumbnail", {"serial": device.serial, "path": output_path}))
                except Exception as exc:
                    self.events.put(("thumbnail_error", {"serial": device.serial, "error": str(exc)}))
            self.events.put(("thumbnail_done", ok_count))

        threading.Thread(target=work, daemon=True).start()

    def on_thumbnail_auto_toggle(self) -> None:
        if self.thumbnail_auto_var.get():
            self.log(f"Auto thumbnails enabled every {self.thumbnail_interval_seconds}s.")
            self.refresh_thumbnails()
            self.schedule_thumbnail_refresh()
        else:
            self.log("Auto thumbnails disabled.")
            if self.thumbnail_after_id:
                self.root.after_cancel(self.thumbnail_after_id)
                self.thumbnail_after_id = None
            self.thumbnail_status_var.set("Idle")

    def schedule_thumbnail_refresh(self) -> None:
        if not self.thumbnail_auto_var.get():
            return
        if self.thumbnail_after_id:
            self.root.after_cancel(self.thumbnail_after_id)
        self.thumbnail_after_id = self.root.after(self.thumbnail_interval_seconds * 1000, self.run_scheduled_thumbnail_refresh)

    def run_scheduled_thumbnail_refresh(self) -> None:
        self.thumbnail_after_id = None
        if not self.thumbnail_auto_var.get():
            return
        self.refresh_thumbnails()

    def load_thumbnail_image(self, serial: str, path: Path) -> None:
        source = tk.PhotoImage(file=str(path))
        scale = max(1, math.ceil(max(source.width() / THUMBNAIL_MAX_WIDTH, source.height() / THUMBNAIL_MAX_HEIGHT)))
        display = source.subsample(scale, scale)
        self.thumbnail_source_images[serial] = source
        self.thumbnail_images[serial] = display
        self.thumbnail_errors.pop(serial, None)
        self.thumbnail_updated_at[serial] = time.time()
        self.paint_thumbnail_card(serial)

    def on_select_device(self, _event: tk.Event[Any] | None = None) -> None:
        selection = self.device_tree.selection()
        if not selection:
            self.selected_serial = None
            self.update_info(None)
            self.update_thumbnail_selection()
            self.update_batch_selection_summary()
            self.update_live_default_status()
            return
        focus = self.device_tree.focus()
        self.selected_serial = focus if focus in selection else selection[0]
        self.update_info(self.devices.get(self.selected_serial))
        self.update_thumbnail_selection()
        self.update_batch_selection_summary()
        self.update_live_default_status()

    def update_device_tree(self, devices: list[DeviceInfo]) -> None:
        current_selection = self.selected_serial
        previous_status = {serial: device.status for serial, device in self.devices.items()}
        self.devices = {device.serial: device for device in devices}
        for device in devices:
            old_status = previous_status.get(device.serial)
            if old_status and old_status != device.status:
                self.log(f"Status changed for {self.device_label(device)} ({device.serial}): {old_status} -> {device.status}")
            elif old_status is None:
                self.log(f"Discovered {self.device_label(device)} ({device.serial}) as {device.display_status}.")
        for serial, old_status in previous_status.items():
            if serial not in self.devices:
                self.log(f"Device disappeared: {serial} was {old_status}.")
        for item in self.device_tree.get_children():
            self.device_tree.delete(item)
        for device in devices:
            self.device_tree.insert(
                "",
                tk.END,
                iid=device.serial,
                values=(
                    self.device_slot(device.serial) or "-",
                    self.device_group(device.serial),
                    device.display_status,
                    self.device_label(device),
                    device.android or "-",
                    device.battery or "-",
                    device.serial,
                ),
                tags=(self.device_status_tag(device),),
            )
        online_count = sum(1 for device in devices if device.online)
        offline_count = len(devices) - online_count
        self.summary_var.set(f"{online_count} online / {offline_count} inactive")
        if hasattr(self, "fleet_var"):
            self.fleet_var.set(f"{online_count} online   {len(devices)} total")
        if hasattr(self, "header_status_var"):
            self.header_status_var.set(
                f"{online_count} online  ·  {offline_count} inactive  ·  last scan {time.strftime('%H:%M:%S')}"
            )
            self.header_dot.itemconfigure("dot", fill=COLOR_SUCCESS if online_count else COLOR_MUTED)
        if current_selection in self.devices:
            self.device_tree.selection_set(current_selection)
            self.selected_serial = current_selection
            self.update_info(self.devices[current_selection])
        elif devices:
            self.device_tree.selection_set(devices[0].serial)
            self.selected_serial = devices[0].serial
            self.update_info(devices[0])
        else:
            self.selected_serial = None
            self.update_info(None)
        self.render_thumbnail_cards()
        self.update_batch_selection_summary()
        self.update_live_default_status()
        self.update_node_summary()
        self.status_var.set("Ready")
        self.log(f"Found {len(devices)} device(s), {online_count} online.")
        self.evaluate_health_alerts(devices)

    def update_info(self, device: DeviceInfo | None) -> None:
        values = {
            "serial": "—",
            "status": "—",
            "model": "—",
            "product": "—",
            "android": "—",
            "sdk": "—",
            "battery": "—",
            "charging": "—",
            "temperature": "—",
            "last_seen": "—",
        }
        if device:
            values.update(
                {
                    "serial": device.serial,
                    "status": device.display_status,
                    "model": device.model or "—",
                    "product": device.product or "—",
                    "android": device.android or "—",
                    "sdk": device.sdk or "—",
                    "battery": device.battery or "—",
                    "charging": device.charging or "—",
                    "temperature": device.temperature or "—",
                    "last_seen": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(device.last_seen)),
                }
            )
        for key, value in values.items():
            self.info_vars[key].set(value)
        if hasattr(self, "name_input"):
            for entry in (self.name_input, self.info_group_input, self.slot_input):
                entry.delete(0, tk.END)
            if device:
                meta = self.device_meta(device.serial)
                self.name_input.insert(0, str(meta.get("name", "")))
                self.info_group_input.insert(0, self.device_group(device.serial))
                self.slot_input.insert(0, self.device_slot(device.serial))

    def update_batch_selection_summary(self) -> None:
        if not hasattr(self, "batch_selected_var"):
            return
        selected = self.selected_devices(online_only=False)
        online = [device for device in selected if device.online]
        self.batch_selected_var.set(f"{len(selected)} selected / {len(online)} online")
        if hasattr(self, "setup_selected_var"):
            self.setup_selected_var.set(f"{len(selected)} selected / {len(online)} online")

    def on_setup_brightness_change(self, value: str) -> None:
        if hasattr(self, "setup_brightness_label_var"):
            self.setup_brightness_label_var.set(str(int(float(value))))

    def write_setup_diagnostics(self, text: str) -> None:
        self.setup_diagnostics_text.configure(state=tk.NORMAL)
        self.setup_diagnostics_text.delete("1.0", tk.END)
        self.setup_diagnostics_text.insert("1.0", text)
        self.setup_diagnostics_text.configure(state=tk.DISABLED)

    def run_setup_diagnostics(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        self.setup_status_var.set("Running diagnostics...")
        self.status_var.set("Running setup diagnostics...")

        def work() -> None:
            try:
                adb = self.adb_required()
                battery = adb.read_battery(device.serial)
                stay_awake = adb.settings_get(device.serial, "global", "stay_on_while_plugged_in")
                timeout = adb.settings_get(device.serial, "system", "screen_off_timeout")
                brightness = adb.settings_get(device.serial, "system", "screen_brightness")
                animation = adb.settings_get(device.serial, "global", "window_animation_scale")
                current = adb.current_package(device.serial) or "unknown"
                lines = [
                    f"Device: {self.device_label(device)} ({device.serial})",
                    f"Status: {device.display_status}",
                    f"Battery: {battery.get('level', device.battery or '-')}, charging: {battery.get('charging', device.charging or '-')}",
                    f"Temperature: {battery.get('temperature', device.temperature or '-')}",
                    f"Current app: {current}",
                    f"Stay awake bitmask: {stay_awake}",
                    f"Screen timeout: {timeout} ms",
                    f"Brightness: {brightness}",
                    f"Window animation scale: {animation}",
                    f"scrcpy: {self.scrcpy_status_text()}",
                ]
                self.events.put(("setup_diagnostics", "\n".join(lines)))
            except Exception as exc:
                self.events.put(("error", f"Setup diagnostics failed: {exc}"))

        threading.Thread(target=work, daemon=True).start()

    def setup_actions_from_form(self) -> list[tuple[str, Callable[[str], str | None]]]:
        actions: list[tuple[str, Callable[[str], str | None]]] = []
        if self.setup_stay_awake_var.get():
            actions.append(("Stay awake while charging", lambda serial: self.adb_required().set_stay_awake(serial, True)))
        if self.setup_disable_animations_var.get():
            actions.append(("Disable animations", lambda serial: self.adb_required().disable_animations(serial)))
        if self.setup_timeout_var.get():
            try:
                minutes = int(self.setup_timeout_input.get().strip())
            except ValueError as exc:
                raise ValueError("Screen timeout must be a whole number of minutes.") from exc
            minutes = max(1, min(120, minutes))
            actions.append((f"Set screen timeout to {minutes}m", lambda serial, value=minutes: self.adb_required().set_screen_timeout(serial, value)))
        if self.setup_brightness_var.get():
            brightness = int(float(self.setup_brightness_scale.get()))
            actions.append((f"Set brightness to {brightness}", lambda serial, value=brightness: self.adb_required().set_brightness(serial, value)))
        if self.setup_wake_var.get():
            actions.append(("Wake device", lambda serial: self.adb_required().keyevent(serial, "KEYCODE_WAKEUP")))
        return actions

    def apply_setup_to_selected(self) -> None:
        if self.setup_running:
            self.log("Setup is already running.")
            return
        if self.busy or self.batch_running or self.workflow_running:
            self.log("Wait for the current action to finish before applying setup.")
            return
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        try:
            actions = self.setup_actions_from_form()
        except ValueError as exc:
            messagebox.showerror(APP_NAME, str(exc))
            return
        if not actions:
            messagebox.showinfo(APP_NAME, "Select at least one setup action.")
            return
        if not messagebox.askyesno(APP_NAME, f"Apply {len(actions)} setup action(s) to {len(devices)} selected device(s)?"):
            return

        self.setup_running = True
        self.setup_progress.configure(maximum=len(devices) * len(actions), value=0)
        self.setup_status_var.set("Setup running...")
        self.status_var.set("Applying setup...")
        self.log(f"Setup started for {len(devices)} device(s), {len(actions)} action(s).")

        def work() -> None:
            ok_count = 0
            fail_count = 0
            done = 0
            total = len(devices) * len(actions)
            for device in devices:
                label = self.device_label(device)
                for action_name, action in actions:
                    done += 1
                    self.events.put(("setup_progress", {"done": done, "total": total, "label": label, "action": action_name}))
                    try:
                        action(device.serial)
                        ok_count += 1
                        self.events.put(("setup_log", f"Setup OK on {label}: {action_name}"))
                    except Exception as exc:
                        fail_count += 1
                        self.events.put(("setup_log", f"Setup FAILED on {label}: {action_name}: {exc}"))
                    self.events.put(("setup_step_done", done))
            self.events.put(("setup_done", {"ok": ok_count, "fail": fail_count, "total": total}))

        threading.Thread(target=work, daemon=True).start()

    def selected_package(self) -> str | None:
        if not hasattr(self, "apps_tree"):
            return None
        selection = self.apps_tree.selection()
        if not selection:
            messagebox.showinfo(APP_NAME, "Select a package first.")
            return None
        return selection[0]

    def write_app_details(self, text: str) -> None:
        self.apps_detail_text.configure(state=tk.NORMAL)
        self.apps_detail_text.delete("1.0", tk.END)
        self.apps_detail_text.insert("1.0", text)
        self.apps_detail_text.configure(state=tk.DISABLED)

    def refresh_apps(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        include_system = self.apps_include_system_var.get()
        self.apps_status_var.set("Loading packages...")
        self.status_var.set("Loading packages...")
        self.log(f"Loading packages for {self.device_label(device)} ({device.serial}).")

        def work() -> None:
            try:
                packages = self.adb_required().list_packages(device.serial, include_system=include_system)
                self.events.put(("apps_list", {"serial": device.serial, "packages": packages, "include_system": include_system}))
            except Exception as exc:
                self.events.put(("error", f"Package list failed: {exc}"))

        threading.Thread(target=work, daemon=True).start()

    def render_apps_tree(self, packages: list[str]) -> None:
        query = self.apps_search_var.get().strip().lower() if hasattr(self, "apps_search_var") else ""
        current = self.selected_package_silent()
        for item in self.apps_tree.get_children():
            self.apps_tree.delete(item)
        shown = 0
        for package in packages:
            if query and query not in package.lower():
                continue
            self.apps_tree.insert("", tk.END, iid=package, values=(package,))
            shown += 1
        if current and current in self.apps_tree.get_children():
            self.apps_tree.selection_set(current)
            self.apps_tree.focus(current)
        self.apps_status_var.set(f"{shown} shown / {len(packages)} packages")

    def selected_package_silent(self) -> str | None:
        if not hasattr(self, "apps_tree"):
            return None
        selection = self.apps_tree.selection()
        return selection[0] if selection else None

    def filter_apps_tree(self) -> None:
        self.render_apps_tree(self.app_packages)

    def on_app_select(self, _event: tk.Event[Any] | None = None) -> None:
        package = self.selected_package_silent()
        if not package:
            return
        self.load_package_info(package)

    def load_package_info(self, package_name: str) -> None:
        device = self.selected_online_device()
        if not device:
            return
        self.apps_status_var.set(f"Loading {package_name}...")

        def work() -> None:
            try:
                info = self.adb_required().package_info(device.serial, package_name)
                self.events.put(("app_info", {"package": package_name, "info": info}))
            except Exception as exc:
                self.events.put(("error", f"Package info failed for {package_name}: {exc}"))

        threading.Thread(target=work, daemon=True).start()

    def open_selected_package(self) -> None:
        device = self.selected_online_device()
        package = self.selected_package()
        if not device or not package:
            return

        def action() -> str:
            self.check_policy_for_device(device.serial, "Open App", package_name=package, allow_manual_only=True)
            return self.adb_required().open_package(device.serial, package)

        self.run_background_action(f"Open {package}", action)

    def install_apk_from_apps(self) -> None:
        self.install_apk()

    def clear_selected_package_data(self) -> None:
        device = self.selected_online_device()
        package = self.selected_package()
        if not device or not package:
            return
        if not messagebox.askyesno(APP_NAME, f"Clear all data for {package} on {device.serial}?"):
            return

        def action() -> str:
            self.check_policy_for_device(device.serial, "Clear Data", package_name=package)
            return self.adb_required().clear_package_data(device.serial, package)

        self.run_background_action(f"Clear Data {package}", action, refresh=False)

    def uninstall_selected_package(self) -> None:
        device = self.selected_online_device()
        package = self.selected_package()
        if not device or not package:
            return
        if not messagebox.askyesno(APP_NAME, f"Uninstall {package} from {device.serial}?"):
            return

        def action() -> str:
            self.check_policy_for_device(device.serial, "Uninstall", package_name=package)
            return self.adb_required().uninstall_package(device.serial, package)

        def refresh_after_uninstall() -> str:
            result = action()
            self.events.put(("apps_refresh", None))
            return result

        self.run_background_action(f"Uninstall {package}", refresh_after_uninstall, refresh=False)

    @staticmethod
    def format_file_size(size: int) -> str:
        value = float(size)
        for unit in ("B", "KB", "MB", "GB"):
            if value < 1024 or unit == "GB":
                if unit == "B":
                    return f"{int(value)} {unit}"
                return f"{value:.1f} {unit}"
            value /= 1024
        return f"{size} B"

    def write_apk_details(self, text: str) -> None:
        self.apk_detail_text.configure(state=tk.NORMAL)
        self.apk_detail_text.delete("1.0", tk.END)
        self.apk_detail_text.insert("1.0", text)
        self.apk_detail_text.configure(state=tk.DISABLED)

    def scan_apk_library(self, *, announce: bool = True) -> None:
        try:
            self.apk_library_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self.apk_status_var.set(f"Unable to create APK library: {exc}")
            return

        items: list[dict[str, Any]] = []
        for path in sorted(self.apk_library_dir.rglob("*.apk"), key=lambda item: item.name.lower()):
            try:
                stat = path.stat()
            except OSError:
                continue
            items.append(
                {
                    "path": path,
                    "name": path.name,
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                }
            )
        self.apk_library_items = items
        self.render_apk_library_tree()
        message = f"{len(items)} APK file(s) in library."
        self.apk_status_var.set(message)
        if announce:
            self.log(f"APK library scan completed: {message}")

    def render_apk_library_tree(self) -> None:
        if not hasattr(self, "apk_tree"):
            return
        current = self.selected_apk_path_silent()
        for item in self.apk_tree.get_children():
            self.apk_tree.delete(item)
        for item in self.apk_library_items:
            path: Path = item["path"]
            self.apk_tree.insert(
                "",
                tk.END,
                iid=str(path),
                values=(
                    item["name"],
                    self.format_file_size(int(item["size"])),
                    time.strftime("%Y-%m-%d %H:%M", time.localtime(float(item["modified"]))),
                ),
            )
        if current and str(current) in self.apk_tree.get_children():
            self.apk_tree.selection_set(str(current))
            self.apk_tree.focus(str(current))
        if not self.apk_library_items and hasattr(self, "apk_detail_text"):
            self.write_apk_details(f"APK library is empty.\n\nFolder:\n{self.apk_library_dir}")

    def selected_apk_path_silent(self) -> Path | None:
        if not hasattr(self, "apk_tree"):
            return None
        selection = self.apk_tree.selection()
        if not selection:
            return None
        return Path(selection[0])

    def selected_apk_path(self) -> Path | None:
        path = self.selected_apk_path_silent()
        if not path:
            messagebox.showinfo(APP_NAME, "Select an APK from the library first.")
            return None
        if not path.exists():
            messagebox.showwarning(APP_NAME, "Selected APK no longer exists. Scan the library again.")
            return None
        return path

    def on_apk_select(self, _event: tk.Event[Any] | None = None) -> None:
        path = self.selected_apk_path_silent()
        if not path:
            return
        try:
            stat = path.stat()
            lines = [
                f"APK: {path.name}",
                f"Path: {path}",
                f"Size: {self.format_file_size(stat.st_size)}",
                f"Modified: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_mtime))}",
            ]
        except OSError as exc:
            lines = [f"APK: {path.name}", f"Error: {exc}"]
        self.write_apk_details("\n".join(lines))

    def open_apk_library_folder(self) -> None:
        try:
            self.apk_library_dir.mkdir(parents=True, exist_ok=True)
            os.startfile(str(self.apk_library_dir))  # type: ignore[attr-defined]
        except OSError as exc:
            self.log(f"Unable to open APK library folder: {exc}")

    def install_selected_library_apk(self) -> None:
        path = self.selected_apk_path()
        if path:
            self.install_apk_to_selected_devices(path)

    def install_chosen_apk_to_selected(self) -> None:
        apk_path = filedialog.askopenfilename(
            title="Select APK",
            initialdir=str(self.apk_library_dir),
            filetypes=(("Android package", "*.apk"), ("All files", "*.*")),
        )
        if apk_path:
            self.install_apk_to_selected_devices(Path(apk_path))

    def install_apk_to_selected_devices(self, apk_path: Path) -> None:
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        if not apk_path.exists():
            messagebox.showwarning(APP_NAME, "APK file does not exist.")
            return
        if not messagebox.askyesno(APP_NAME, f"Install {apk_path.name} to {len(devices)} selected online device(s)?"):
            return
        self.run_app_batch_action(
            f"Install {apk_path.name}",
            devices,
            lambda serial: self.adb_required().install_apk(serial, str(apk_path)),
            refresh_apps=True,
        )

    def set_apk_package_from_selected_app(self) -> None:
        package = self.selected_package_silent()
        if not package:
            messagebox.showinfo(APP_NAME, "Select a package in the Apps tab first.")
            return
        self.apk_package_var.set(package)
        self.write_apk_details(f"Package selected:\n{package}")

    def apk_package_input(self) -> str | None:
        package = self.apk_package_var.get().strip() if hasattr(self, "apk_package_var") else ""
        if not package:
            messagebox.showinfo(APP_NAME, "Enter a package name first.")
            return None
        return package

    def compare_package_on_selected_devices(self) -> None:
        if self.app_batch_running:
            self.log("App batch task is already running.")
            return
        package = self.apk_package_input()
        devices = self.selected_online_devices_or_warn()
        if not package or not devices:
            return

        self.app_batch_running = True
        self.apk_progress.configure(maximum=len(devices), value=0)
        self.apk_status_var.set(f"Comparing {package} on {len(devices)} device(s)...")
        self.status_var.set("Comparing app versions...")
        self.log(f"Comparing {package} on {len(devices)} device(s).")

        def work() -> None:
            rows: list[dict[str, str]] = []
            for index, device in enumerate(devices, start=1):
                label = self.device_label(device)
                self.events.put(("app_batch_progress", {"action": "Compare", "index": index, "total": len(devices), "label": label}))
                try:
                    info = self.adb_required().package_info(device.serial, package)
                    installed = bool(info.get("version_name") or info.get("version_code"))
                    rows.append(
                        {
                            "device": label,
                            "serial": device.serial,
                            "status": "installed" if installed else "not installed",
                            "version_name": info.get("version_name", "") if installed else "",
                            "version_code": info.get("version_code", "") if installed else "",
                            "target_sdk": info.get("target_sdk", "") if installed else "",
                        }
                    )
                except Exception as exc:
                    rows.append(
                        {
                            "device": label,
                            "serial": device.serial,
                            "status": f"error: {exc}",
                            "version_name": "",
                            "version_code": "",
                            "target_sdk": "",
                        }
                    )
                self.events.put(("app_batch_step_done", {"index": index, "total": len(devices), "action": "Compare"}))
            self.events.put(("app_compare_done", {"package": package, "rows": rows}))

        threading.Thread(target=work, daemon=True).start()

    def batch_clear_package_data(self) -> None:
        package = self.apk_package_input()
        devices = self.selected_online_devices_or_warn()
        if not package or not devices:
            return
        if not messagebox.askyesno(APP_NAME, f"Clear all data for {package} on {len(devices)} selected online device(s)?"):
            return
        self.run_app_batch_action(
            f"Clear Data {package}",
            devices,
            lambda serial: self.adb_required().clear_package_data(serial, package),
            package_name=package,
        )

    def batch_uninstall_package(self) -> None:
        package = self.apk_package_input()
        devices = self.selected_online_devices_or_warn()
        if not package or not devices:
            return
        if not messagebox.askyesno(APP_NAME, f"Uninstall {package} from {len(devices)} selected online device(s)?"):
            return
        self.run_app_batch_action(
            f"Uninstall {package}",
            devices,
            lambda serial: self.adb_required().uninstall_package(serial, package),
            package_name=package,
            refresh_apps=True,
        )

    def run_app_batch_action(
        self,
        action_name: str,
        devices: list[DeviceInfo],
        action: Callable[[str], str | None],
        *,
        package_name: str | None = None,
        refresh_apps: bool = False,
    ) -> None:
        if self.app_batch_running:
            self.log("App batch task is already running.")
            return
        if self.busy or self.batch_running or self.workflow_running or self.setup_running:
            self.log("Wait for the current task to finish before running app batch actions.")
            return

        self.app_batch_running = True
        total = len(devices)
        self.apk_progress.configure(maximum=total, value=0)
        self.apk_status_var.set(f"{action_name}: 0/{total}")
        self.status_var.set(f"{action_name} running...")
        self.log(f"{action_name} queued for {total} device(s).")

        def work() -> None:
            ok_count = 0
            fail_count = 0
            for index, device in enumerate(devices, start=1):
                label = self.device_label(device)
                self.events.put(("app_batch_progress", {"action": action_name, "index": index, "total": total, "label": label}))
                try:
                    if package_name:
                        self.check_policy_for_device(device.serial, action_name, package_name=package_name)
                    result = action(device.serial)
                    ok_count += 1
                    detail = f" {result}" if result else ""
                    self.events.put(("app_batch_log", f"{action_name} OK on {label} ({device.serial}).{detail}"))
                except Exception as exc:
                    fail_count += 1
                    self.events.put(("app_batch_log", f"{action_name} FAILED on {label} ({device.serial}): {exc}"))
                self.events.put(("app_batch_step_done", {"index": index, "total": total, "action": action_name}))
            self.events.put(
                (
                    "app_batch_done",
                    {
                        "action": action_name,
                        "ok": ok_count,
                        "fail": fail_count,
                        "total": total,
                        "refresh_apps": refresh_apps,
                    },
                )
            )

        threading.Thread(target=work, daemon=True).start()

    def evaluate_health_alerts(self, devices: list[DeviceInfo]) -> None:
        for device in devices:
            if not device.online:
                continue
            label = self.device_label(device)
            battery = parse_percent(device.battery)
            battery_key = f"{device.serial}:battery"
            if battery is not None and battery <= self.low_battery_percent:
                if battery_key not in self.health_alert_cache:
                    self.health_alert_cache.add(battery_key)
                    self.log(f"HEALTH warning: {label} battery is low at {battery}%.")
            else:
                self.health_alert_cache.discard(battery_key)

            temp = parse_temperature_c(device.temperature)
            temp_key = f"{device.serial}:temperature"
            if temp is not None and temp >= self.high_temp_c:
                if temp_key not in self.health_alert_cache:
                    self.health_alert_cache.add(temp_key)
                    self.log(f"HEALTH warning: {label} temperature is high at {temp:.1f}C.")
            else:
                self.health_alert_cache.discard(temp_key)

    def save_selected_metadata(self) -> None:
        if not self.selected_serial or self.selected_serial not in self.devices:
            messagebox.showinfo(APP_NAME, "Select a device first.")
            return
        meta = self.device_meta(self.selected_serial)
        meta["name"] = self.name_input.get().strip()
        meta["group"] = self.info_group_input.get().strip() or "Default"
        meta["slot"] = self.slot_input.get().strip()
        self.save_device_meta()
        self.update_device_tree(list(self.devices.values()))
        self.log(f"Saved metadata for {self.selected_serial}.")

    def set_policy_form_package(self, package_name: str) -> None:
        self.policy_package_input.delete(0, tk.END)
        self.policy_package_input.insert(0, package_name)
        self.load_policy_for_package(package_name)

    def load_policy_for_package(self, package_name: str) -> None:
        package = package_name.strip()
        if not package:
            self.policy_status_var.set("No package selected.")
            return
        policy = self.policy_for_package(package)
        mode = str(policy.get("mode", "assisted"))
        self.policy_mode_var.set(POLICY_MODE_LABELS.get(mode, POLICY_MODE_LABELS["assisted"]))
        self.policy_capture_var.set(bool(policy.get("allow_capture", True)))
        self.policy_notes_input.delete(0, tk.END)
        self.policy_notes_input.insert(0, str(policy.get("notes", "")))
        self.policy_status_var.set(f"Loaded policy for {package}: {POLICY_MODE_LABELS.get(mode, mode)}")

    def load_policy_from_package_input(self) -> None:
        self.load_policy_for_package(self.policy_package_input.get())

    def save_policy_from_form(self) -> None:
        package = self.policy_package_input.get().strip()
        if not package:
            messagebox.showinfo(APP_NAME, "Enter a package name first.")
            return
        label = self.policy_mode_var.get()
        mode = POLICY_LABEL_TO_MODE.get(label, "assisted")
        policy = self.policy_meta(package)
        policy["mode"] = mode
        policy["allow_capture"] = bool(self.policy_capture_var.get())
        policy["notes"] = self.policy_notes_input.get().strip()
        self.save_device_meta()
        self.policy_status_var.set(f"Saved policy for {package}: {POLICY_MODE_LABELS[mode]}")
        self.log(f"Saved policy for {package}: {POLICY_MODE_LABELS[mode]}.")

    def clear_policy_from_form(self) -> None:
        package = self.policy_package_input.get().strip()
        if not package:
            messagebox.showinfo(APP_NAME, "Enter a package name first.")
            return
        policies = self.device_state.setdefault("policies", {})
        if isinstance(policies, dict):
            policies.pop(package, None)
        self.save_device_meta()
        self.policy_mode_var.set(POLICY_MODE_LABELS["assisted"])
        self.policy_capture_var.set(True)
        self.policy_notes_input.delete(0, tk.END)
        self.policy_status_var.set(f"Cleared policy for {package}.")
        self.log(f"Cleared policy for {package}.")

    def detect_current_app(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        self.status_var.set("Detecting current app...")

        def work() -> None:
            try:
                package = self.adb_required().current_package(device.serial)
                self.events.put(("current_app", {"serial": device.serial, "package": package}))
            except Exception as exc:
                self.events.put(("error", f"Current app detection failed: {exc}"))

        threading.Thread(target=work, daemon=True).start()

    def apply_group_to_selection(self) -> None:
        selected = self.selected_devices(online_only=False)
        if not selected:
            messagebox.showinfo(APP_NAME, "Select one or more devices first.")
            return
        group = self.group_input.get().strip() or "Default"
        for device in selected:
            self.device_meta(device.serial)["group"] = group
        self.save_device_meta()
        self.update_device_tree(list(self.devices.values()))
        self.log(f"Set group '{group}' for {len(selected)} device(s).")

    def run_batch_keyevent(self, action_name: str, key: str) -> None:
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        self.run_batch_action(action_name, devices, lambda serial: self.adb_required().keyevent(serial, key))

    def batch_open_app_prompt(self) -> None:
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        dialog = TextPrompt(self.root, "Batch Open App", "Package name:")
        package_name = dialog.value
        if not package_name:
            return

        def action(serial: str) -> str:
            self.check_policy_for_device(serial, "Open App", package_name=package_name, allow_manual_only=True)
            return self.adb_required().open_package(serial, package_name)

        self.run_batch_action("Open App", devices, action, policy_checked=False)

    def batch_install_apk(self) -> None:
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        apk_path = filedialog.askopenfilename(
            title="Select APK",
            filetypes=(("Android package", "*.apk"), ("All files", "*.*")),
        )
        if not apk_path:
            return
        self.run_batch_action(
            "Install APK",
            devices,
            lambda serial: self.adb_required().install_apk(serial, apk_path),
            refresh=True,
            policy_checked=False,
        )

    def batch_reboot(self) -> None:
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        if not messagebox.askyesno(APP_NAME, f"Reboot {len(devices)} selected online device(s)?"):
            return
        self.run_batch_action(
            "Reboot",
            devices,
            lambda serial: self.adb_required().text(["reboot"], serial=serial, timeout=8),
            refresh=True,
            policy_checked=False,
        )

    def run_batch_action(
        self,
        action_name: str,
        devices: list[DeviceInfo],
        action: Callable[[str], str | None],
        *,
        refresh: bool = False,
        policy_checked: bool = True,
        allow_manual_only: bool = False,
    ) -> None:
        if self.batch_running:
            self.log("A batch action is already running.")
            return
        if self.busy:
            self.log("Wait for the current single-device action to finish first.")
            return

        self.batch_running = True
        total = len(devices)
        self.batch_progress.configure(maximum=total, value=0)
        self.batch_progress_var.set(f"{action_name}: 0/{total}")
        self.status_var.set(f"Batch {action_name} running...")
        self.log(f"Batch {action_name} queued for {total} device(s).")

        def work() -> None:
            ok_count = 0
            fail_count = 0
            for index, device in enumerate(devices, start=1):
                label = self.device_label(device)
                self.events.put(("batch_progress", {"action": action_name, "index": index, "total": total, "label": label}))
                try:
                    if policy_checked:
                        package = self.check_policy_for_device(
                            device.serial,
                            action_name,
                            allow_manual_only=allow_manual_only,
                        )
                        if package:
                            self.events.put(("batch_log", f"{action_name} policy check on {label}: {package}"))
                    result = action(device.serial)
                    ok_count += 1
                    detail = f" {result}" if result else ""
                    self.events.put(("batch_log", f"{action_name} OK on {label} ({device.serial}).{detail}"))
                except Exception as exc:
                    fail_count += 1
                    self.events.put(("batch_log", f"{action_name} FAILED on {label} ({device.serial}): {exc}"))
                self.events.put(("batch_step_done", {"index": index, "total": total, "action": action_name}))
            self.events.put(("batch_done", {"action": action_name, "ok": ok_count, "fail": fail_count, "refresh": refresh}))

        threading.Thread(target=work, daemon=True).start()

    def selected_online_device(self) -> DeviceInfo | None:
        if not self.selected_serial:
            messagebox.showinfo(APP_NAME, "Select a device first.")
            return None
        device = self.devices.get(self.selected_serial)
        if not device:
            messagebox.showinfo(APP_NAME, "Selected device is no longer available.")
            return None
        if not device.online:
            messagebox.showwarning(APP_NAME, f"Device is {device.display_status}.")
            return None
        return device

    def run_selected_action(self, action_name: str, action: Callable[[str], str | None]) -> None:
        device = self.selected_online_device()
        if not device:
            return
        def guarded_action() -> str | None:
            self.check_policy_for_device(device.serial, action_name)
            return action(device.serial)

        self.run_background_action(action_name, guarded_action, refresh=False)

    def run_background_action(self, action_name: str, action: Callable[[], Any], *, refresh: bool = False) -> None:
        if self.busy:
            return
        self.busy = True
        self.status_var.set(f"Running {action_name}...")
        self.log(f"{action_name} started.")

        def work() -> None:
            try:
                result = action()
                self.events.put(("message", f"{action_name} completed." + (f" {result}" if result else "")))
                if refresh:
                    self.events.put(("refresh", None))
            except Exception as exc:
                self.events.put(("error", f"{action_name} failed: {exc}"))
            finally:
                self.events.put(("busy", False))

        threading.Thread(target=work, daemon=True).start()

    def take_screenshot(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        output_dir = Path(tempfile.gettempdir()) / "FarmManager"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{device.serial.replace(':', '_')}_{time.strftime('%Y%m%d_%H%M%S')}.png"

        def action() -> str:
            self.check_policy_for_device(device.serial, "Screenshot", allow_manual_only=True, require_capture=True)
            self.adb_required().screenshot(device.serial, output_path)
            return str(output_path)

        self.run_background_action("Screenshot", action)

    def install_apk(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        apk_path = filedialog.askopenfilename(
            title="Select APK",
            filetypes=(("Android package", "*.apk"), ("All files", "*.*")),
        )
        if not apk_path:
            return

        def action() -> str:
            return self.adb_required().install_apk(device.serial, apk_path)

        self.run_background_action("Install APK", action, refresh=True)

    def open_app_prompt(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        dialog = TextPrompt(self.root, "Open App", "Package name:")
        package_name = dialog.value
        if not package_name:
            return

        def action() -> str:
            self.check_policy_for_device(device.serial, "Open App", package_name=package_name, allow_manual_only=True)
            return self.adb_required().open_package(device.serial, package_name)

        self.run_background_action("Open App", action)

    def send_text(self) -> None:
        value = self.text_input.get()
        if not value:
            return
        device = self.selected_online_device()
        if not device:
            return

        def action() -> str:
            self.check_policy_for_device(device.serial, "Send Text")
            return self.adb_required().input_text(device.serial, value)

        self.run_background_action("Send Text", action)

    def open_scrcpy_with_profile(self, profile_name: str) -> None:
        if hasattr(self, "live_profile_var"):
            self.live_profile_var.set(profile_name)
            self.update_live_profile_preview()
        self.open_scrcpy()

    def open_scrcpy(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        self.open_scrcpy_for_device(device, self.selected_scrcpy_profile_name(), remember=True)

    def open_scrcpy_default(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        profile_name = self.live_profile_for_device(device)
        if hasattr(self, "live_profile_var"):
            self.live_profile_var.set(profile_name)
            self.update_live_profile_preview()
        self.open_scrcpy_for_device(device, profile_name, remember=True)

    def remember_live_serials(self, serials: list[str]) -> None:
        self.last_live_serials = list(dict.fromkeys(serials))
        self.config["last_live_serials"] = self.last_live_serials
        self.save_app_config()

    def scrcpy_args_for_device(self, device: DeviceInfo, profile_name: str) -> list[str]:
        profile = self.selected_scrcpy_profile(profile_name)
        window_title = f"Farm Manager - {self.device_label(device)}"
        return [
            self.scrcpy_path or "",
            "-s",
            device.serial,
            "--window-title",
            window_title,
            "--max-size",
            str(profile["max_size"]),
            "--max-fps",
            str(profile["max_fps"]),
            "--video-bit-rate",
            str(profile["bit_rate"]),
        ]

    def open_scrcpy_for_device(self, device: DeviceInfo, profile_name: str, *, remember: bool = False) -> bool:
        self.refresh_scrcpy_status()
        self.update_live_session_status()
        if not self.scrcpy_path:
            message = "scrcpy was not found. Use Locate to select scrcpy.exe."
            self.log(message)
            if hasattr(self, "live_status_var"):
                self.live_status_var.set(message)
            if messagebox.askyesno(APP_NAME, "scrcpy was not found. Locate scrcpy.exe now?"):
                self.locate_scrcpy()
            return False
        try:
            self.check_policy_for_device(device.serial, "Open scrcpy", allow_manual_only=True, require_capture=True)
        except AdbError as exc:
            self.log(f"Open scrcpy blocked by policy: {exc}")
            messagebox.showwarning(APP_NAME, str(exc))
            if hasattr(self, "live_status_var"):
                self.live_status_var.set(str(exc))
            return False

        self.save_app_config()
        args = self.scrcpy_args_for_device(device, profile_name)
        try:
            process = subprocess.Popen(args)
            self.live_processes[device.serial] = process
            self.update_live_session_status()
            if remember:
                self.remember_live_serials([device.serial])
            message = f"Opened live control for {device.serial} using {profile_name} profile."
            self.log(message)
            if hasattr(self, "live_status_var"):
                self.live_status_var.set(message)
            return True
        except OSError as exc:
            self.log(f"Unable to open scrcpy: {exc}")
            if hasattr(self, "live_status_var"):
                self.live_status_var.set(f"Unable to open scrcpy: {exc}")
            self.update_live_session_status()
            return False

    def open_selected_live(self) -> None:
        devices = self.selected_online_devices_or_warn()
        if not devices:
            return
        if len(devices) > 1 and not messagebox.askyesno(APP_NAME, f"Open live control for {len(devices)} selected online device(s)?"):
            return
        self.open_live_device_sequence(devices, use_defaults=True)

    def open_live_device_sequence(self, devices: list[DeviceInfo], *, use_defaults: bool) -> None:
        if not devices:
            return
        self.refresh_scrcpy_status()
        if not self.scrcpy_path:
            message = "scrcpy was not found. Use Locate to select scrcpy.exe."
            self.log(message)
            if hasattr(self, "live_status_var"):
                self.live_status_var.set(message)
            if messagebox.askyesno(APP_NAME, "scrcpy was not found. Locate scrcpy.exe now?"):
                self.locate_scrcpy()
            return

        serials = [device.serial for device in devices]
        self.remember_live_serials(serials)
        self.live_status_var.set(f"Opening {len(devices)} live session(s)...")

        def open_next(index: int) -> None:
            if index >= len(devices):
                self.update_live_session_status()
                self.live_status_var.set(f"Opened live set: {len(devices)} device(s).")
                return
            device = devices[index]
            profile_name = self.live_profile_for_device(device) if use_defaults else self.selected_scrcpy_profile_name()
            self.open_scrcpy_for_device(device, profile_name, remember=False)
            self.root.after(280, lambda: open_next(index + 1))

        open_next(0)

    def reopen_last_live(self) -> None:
        serials = [serial for serial in self.last_live_serials if serial in self.devices and self.devices[serial].online]
        if not serials:
            messagebox.showinfo(APP_NAME, "No previous online live set to reopen.")
            return
        devices = [self.devices[serial] for serial in serials]
        self.open_live_device_sequence(devices, use_defaults=True)

    def reboot_selected(self) -> None:
        device = self.selected_online_device()
        if not device:
            return
        if not messagebox.askyesno(APP_NAME, f"Reboot {device.serial}?"):
            return

        def action() -> str:
            return self.adb_required().text(["reboot"], serial=device.serial, timeout=8)

        self.run_background_action("Reboot", action, refresh=True)

    def open_config_folder(self) -> None:
        try:
            os.startfile(str(BASE_DIR))
        except OSError as exc:
            self.log(f"Unable to open folder: {exc}")

    def open_event_db(self) -> None:
        try:
            os.startfile(str(EVENT_DB_FILE))
        except OSError as exc:
            self.log(f"Unable to open event DB: {exc}")

    def _poll_events(self) -> None:
        while True:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "devices":
                self.update_device_tree(payload)
                self.schedule_auto_scan()
            elif kind == "message":
                self.log(str(payload))
                self.status_var.set("Ready")
            elif kind == "error":
                self.log(f"ERROR: {payload}")
                self.status_var.set("Error")
                self.schedule_auto_scan()
            elif kind == "busy":
                self.busy = bool(payload)
            elif kind == "refresh":
                self.root.after(200, self.refresh_devices)
            elif kind == "thumbnail":
                serial = str(payload["serial"])
                path = Path(payload["path"])
                try:
                    self.load_thumbnail_image(serial, path)
                except Exception as exc:
                    self.thumbnail_errors[serial] = str(exc)
                    self.paint_thumbnail_card(serial)
                    self.log(f"Thumbnail display failed for {serial}: {exc}")
            elif kind == "thumbnail_error":
                serial = str(payload["serial"])
                error = str(payload["error"])
                self.thumbnail_errors[serial] = error
                self.paint_thumbnail_card(serial)
                self.log(f"Thumbnail failed for {serial}: {error}")
            elif kind == "thumbnail_done":
                self.thumbnail_refreshing = False
                self.thumbnail_status_var.set(f"Updated {payload} at {now_stamp()}")
                self.schedule_thumbnail_refresh()
            elif kind == "current_app":
                package = str(payload.get("package", "")).strip()
                if package:
                    self.current_package_var.set(package)
                    self.set_policy_form_package(package)
                    self.status_var.set("Ready")
                    self.log(f"Current app on {payload.get('serial')}: {package}")
                else:
                    self.current_package_var.set("-")
                    self.status_var.set("Ready")
                    self.log(f"Current app on {payload.get('serial')}: unknown")
            elif kind == "batch_progress":
                index = int(payload["index"])
                total = int(payload["total"])
                action = str(payload["action"])
                label = str(payload["label"])
                self.batch_progress.configure(value=index - 1)
                self.batch_progress_var.set(f"{action}: {index}/{total}  {label}")
            elif kind == "batch_log":
                self.log(str(payload))
            elif kind == "batch_step_done":
                self.batch_progress.configure(value=int(payload["index"]))
            elif kind == "batch_done":
                self.batch_running = False
                action = str(payload["action"])
                ok_count = int(payload["ok"])
                fail_count = int(payload["fail"])
                total = ok_count + fail_count
                self.batch_progress.configure(value=total)
                self.batch_progress_var.set(f"{action}: {ok_count} OK / {fail_count} failed")
                self.status_var.set("Ready")
                self.log(f"Batch {action} completed: {ok_count} OK, {fail_count} failed.")
                if bool(payload.get("refresh")):
                    self.root.after(700, self.refresh_devices)
            elif kind == "workflow_progress":
                done = int(payload["done"])
                total = int(payload["total"])
                self.workflow_progress.configure(value=max(0, done - 1))
                self.workflow_status_var.set(f"{payload['name']}: {done}/{total}  {payload['label']}  {payload['step']}")
            elif kind == "workflow_step_done":
                self.workflow_progress.configure(value=int(payload))
            elif kind == "workflow_log":
                self.log(str(payload))
            elif kind == "workflow_confirm_step":
                step = payload["step"]
                action_text = f"{step.command} {step.argument}".strip()
                dry_note = "\n\nDry run is enabled: no command will be sent to the device." if bool(payload.get("dry_run")) else ""
                approved = messagebox.askyesno(
                    APP_NAME,
                    f"Run workflow step?\n\nWorkflow: {payload['workflow']}\nDevice: {payload['device']}\nStep: {action_text}{dry_note}",
                )
                payload["approved"] = approved
                payload["event"].set()
            elif kind == "workflow_done":
                self.workflow_running = False
                name = str(payload["name"])
                ok_count = int(payload["ok"])
                fail_count = int(payload["fail"])
                skipped_count = int(payload.get("skipped", 0))
                total = int(payload["total"])
                self.workflow_progress.configure(value=total)
                skip_text = f" / {skipped_count} skipped" if skipped_count else ""
                self.workflow_status_var.set(f"{name}: {ok_count} OK / {fail_count} failed{skip_text}")
                self.status_var.set("Ready")
                self.log(f"Workflow '{name}' completed: {ok_count} OK, {fail_count} failed, {skipped_count} skipped.")
            elif kind == "setup_diagnostics":
                self.write_setup_diagnostics(str(payload))
                self.setup_status_var.set("Diagnostics complete")
                self.status_var.set("Ready")
                self.log("Setup diagnostics completed.")
            elif kind == "setup_progress":
                done = int(payload["done"])
                total = int(payload["total"])
                self.setup_progress.configure(value=max(0, done - 1))
                self.setup_status_var.set(f"{done}/{total}  {payload['label']}  {payload['action']}")
            elif kind == "setup_step_done":
                self.setup_progress.configure(value=int(payload))
            elif kind == "setup_log":
                self.log(str(payload))
            elif kind == "setup_done":
                self.setup_running = False
                ok_count = int(payload["ok"])
                fail_count = int(payload["fail"])
                total = int(payload["total"])
                self.setup_progress.configure(value=total)
                self.setup_status_var.set(f"{ok_count} OK / {fail_count} failed")
                self.status_var.set("Ready")
                self.log(f"Setup completed: {ok_count} OK, {fail_count} failed.")
                self.root.after(700, self.refresh_devices)
            elif kind == "apps_list":
                self.app_packages = list(payload["packages"])
                self.app_packages_device = str(payload["serial"])
                self.render_apps_tree(self.app_packages)
                self.write_app_details("Select a package to view details.")
                self.status_var.set("Ready")
                label = "system + user" if bool(payload.get("include_system")) else "user"
                self.log(f"Loaded {len(self.app_packages)} {label} package(s) for {self.app_packages_device}.")
            elif kind == "app_info":
                package = str(payload["package"])
                info = payload["info"]
                lines = [
                    f"Package: {package}",
                    f"Version name: {info.get('version_name') or '-'}",
                    f"Version code: {info.get('version_code') or '-'}",
                    f"Target SDK: {info.get('target_sdk') or '-'}",
                    f"First install: {info.get('first_install') or '-'}",
                    f"Last update: {info.get('last_update') or '-'}",
                    f"Installer: {info.get('installer') or '-'}",
                    f"Flags: {info.get('flags') or '-'}",
                ]
                self.write_app_details("\n".join(lines))
                self.apps_status_var.set(f"Loaded details for {package}")
                self.status_var.set("Ready")
            elif kind == "apps_refresh":
                self.root.after(700, self.refresh_apps)
            elif kind == "app_batch_progress":
                index = int(payload["index"])
                total = int(payload["total"])
                self.apk_progress.configure(value=max(0, index - 1))
                self.apk_status_var.set(f"{payload['action']}: {index}/{total}  {payload['label']}")
            elif kind == "app_batch_step_done":
                self.apk_progress.configure(value=int(payload["index"]))
            elif kind == "app_batch_log":
                self.log(str(payload))
            elif kind == "app_batch_done":
                self.app_batch_running = False
                action = str(payload["action"])
                ok_count = int(payload["ok"])
                fail_count = int(payload["fail"])
                total = int(payload["total"])
                self.apk_progress.configure(value=total)
                self.apk_status_var.set(f"{action}: {ok_count} OK / {fail_count} failed")
                self.status_var.set("Ready")
                self.write_apk_details(f"{action}\n\n{ok_count} OK\n{fail_count} failed\n{total} total")
                self.log(f"{action} completed: {ok_count} OK, {fail_count} failed.")
                if bool(payload.get("refresh_apps")) and self.selected_serial:
                    self.root.after(700, self.refresh_apps)
            elif kind == "app_compare_done":
                self.app_batch_running = False
                package = str(payload["package"])
                rows = list(payload["rows"])
                lines = [f"Package: {package}", ""]
                lines.append(f"{'Device':<22} {'Version':<16} {'Code':<10} {'Target':<8} Status")
                lines.append("-" * 76)
                for row in rows:
                    lines.append(
                        f"{str(row.get('device', '-'))[:22]:<22} "
                        f"{str(row.get('version_name', '-') or '-')[:16]:<16} "
                        f"{str(row.get('version_code', '-') or '-')[:10]:<10} "
                        f"{str(row.get('target_sdk', '-') or '-')[:8]:<8} "
                        f"{row.get('status', '-')}"
                    )
                    lines.append(f"  {row.get('serial', '-')}")
                self.apk_progress.configure(value=len(rows))
                self.apk_status_var.set(f"Compared {package} on {len(rows)} device(s).")
                self.write_apk_details("\n".join(lines))
                self.status_var.set("Ready")
                self.log(f"Compared {package} on {len(rows)} device(s).")
        self.root.after(120, self._poll_events)

    def log(self, message: str, *, level: str | None = None) -> None:
        event_level = level or ("warning" if "warning" in message.lower() else "error" if message.startswith("ERROR:") else "info")
        self.log_text.configure(state=tk.NORMAL)
        self.log_text.insert(tk.END, f"[{now_stamp()}] {message}\n")
        self.log_text.see(tk.END)
        self.log_text.configure(state=tk.DISABLED)
        self.event_store.log(message, level=event_level)


class TextPrompt:
    def __init__(self, parent: tk.Tk, title: str, label: str) -> None:
        self.value: str | None = None
        self.window = tk.Toplevel(parent)
        self.window.title(title)
        self.window.transient(parent)
        self.window.grab_set()
        self.window.resizable(False, False)
        self.window.configure(background=COLOR_PANEL)

        frame = ttk.Frame(self.window, padding=16)
        frame.grid(row=0, column=0, sticky="nsew")
        frame.columnconfigure(0, weight=1)
        ttk.Label(frame, text=label).grid(row=0, column=0, sticky="w", pady=(0, 6))
        self.entry = ttk.Entry(frame, width=42)
        self.entry.grid(row=1, column=0, columnspan=2, sticky="ew")
        self.entry.focus_set()

        buttons = ttk.Frame(frame)
        buttons.grid(row=2, column=0, sticky="e", pady=(12, 0))
        ttk.Button(buttons, text="Cancel", command=self.cancel).grid(row=0, column=0, padx=4)
        ttk.Button(buttons, text="OK", style="Accent.TButton", command=self.ok).grid(row=0, column=1, padx=4)

        self.window.bind("<Return>", lambda _event: self.ok())
        self.window.bind("<Escape>", lambda _event: self.cancel())
        parent.wait_window(self.window)

    def ok(self) -> None:
        value = self.entry.get().strip()
        self.value = value or None
        self.window.destroy()

    def cancel(self) -> None:
        self.value = None
        self.window.destroy()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local Phone Farm Manager")
    parser.add_argument("--check", action="store_true", help="check tool paths and ADB device listing without opening the GUI")
    return parser.parse_args(argv)


def run_check() -> int:
    config = load_config()
    adb_path = resolve_tool_path("adb", config.get("adb_path"))
    scrcpy_path = resolve_tool_path("scrcpy", config.get("scrcpy_path"))
    print(f"{APP_NAME} {APP_VERSION}")
    print(f"Node: {config.get('node_name') or os.getenv('COMPUTERNAME') or 'Local Node'}")
    print(f"Config: {CONFIG_FILE}")
    print(f"Event DB: {EVENT_DB_FILE}")
    print(f"ADB: {adb_path or 'not found'}")
    print(f"scrcpy: {scrcpy_path or 'not found'}")
    if not adb_path:
        return 1

    adb = AdbClient(adb_path)
    try:
        devices = adb.list_devices()
    except Exception as exc:
        print(f"ADB check failed: {exc}")
        return 1

    online_count = sum(1 for device in devices if device.online)
    print(f"Devices: {len(devices)} total / {online_count} online")
    for device in devices:
        label = device.model or device.product or "-"
        print(f"- {device.serial}  {device.display_status}  {label}")
    return 0


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.check:
        raise SystemExit(run_check())
    root = tk.Tk()
    FarmManagerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
