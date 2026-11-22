"""What this computer can run: its GPU, video memory, system memory and which PyTorch build fits it.

Detection only shells out to tools the system already has (nvidia-smi, sysctl, PowerShell); it never imports torch.
"""

from __future__ import annotations

import ctypes
import os
import platform
import re
import shutil
import subprocess
import sys
from functools import lru_cache
from typing import Any

# PyTorch's CUDA 12.8 wheels are the first that run on RTX 50-series (Blackwell, compute capability 12.0). They need
# an NVIDIA driver from the 570 series or newer. Older cards (down to compute 5.0) also run the CUDA 12.6 wheels.
CU128_MIN_DRIVER = 570.0
_RUN_TIMEOUT = 8


def _run(args: list[str]) -> str:
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.run(args, capture_output=True, text=True, timeout=_RUN_TIMEOUT, creationflags=flags)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _float(text: str) -> float:
    match = re.search(r"\d+(\.\d+)?", text or "")
    return float(match.group(0)) if match else 0.0


def parse_nvidia_smi(text: str) -> list[dict[str, Any]]:
    """Rows of `nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader,nounits`."""
    gpus = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2 or not parts[0]:
            continue
        mib = _float(parts[1])
        gpus.append({
            "name": parts[0],
            "vram_gb": round(mib / 1024, 1),
            "compute_cap": _float(parts[2]) if len(parts) > 2 and "N/A" not in parts[2] else 0.0,
            "driver": _float(parts[3]) if len(parts) > 3 else 0.0,
        })
    return gpus


def _nvidia() -> list[dict[str, Any]]:
    exe = shutil.which("nvidia-smi")
    if not exe and sys.platform == "win32":
        candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = candidate if os.path.exists(candidate) else None
    if not exe:
        return []
    text = _run([exe, "--query-gpu=name,memory.total,compute_cap,driver_version", "--format=csv,noheader,nounits"])
    if not text:  # drivers older than 510 have no compute_cap column
        text = _run([exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
        return [{**g, "driver": g["compute_cap"], "compute_cap": 0.0} for g in parse_nvidia_smi(text)]
    return parse_nvidia_smi(text)


def _other_gpu_names() -> list[str]:
    """Display adapters that aren't NVIDIA (AMD, Intel), so the page can say why they aren't supported yet."""
    if sys.platform == "win32":
        text = _run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"])
    elif sys.platform.startswith("linux"):
        text = "\n".join(line.split(": ", 1)[-1] for line in _run(["lspci"]).splitlines() if "VGA" in line or "3D" in line)
    else:
        text = ""
    return [n.strip() for n in text.splitlines() if n.strip() and "nvidia" not in n.lower() and "basic" not in n.lower()]


def system_ram_gb() -> float:
    try:
        if sys.platform == "win32":
            class MemoryStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = MemoryStatus()
            status.dwLength = ctypes.sizeof(MemoryStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))  # type: ignore[attr-defined]
            return round(status.ullTotalPhys / 1024**3, 1)
        if sys.platform == "darwin":
            return round(_float(_run(["sysctl", "-n", "hw.memsize"])) / 1024**3, 1)
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 1)
    except (OSError, ValueError, AttributeError):
        return 0.0


def ram_in_use_gb() -> float:
    """System memory in use right now, by everything (the This PC meter)."""
    try:
        if sys.platform == "win32":
            class MemoryStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = MemoryStatus()
            status.dwLength = ctypes.sizeof(MemoryStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))  # type: ignore[attr-defined]
            return round((status.ullTotalPhys - status.ullAvailPhys) / 1024**3, 1)
        if sys.platform.startswith("linux"):
            info = dict(line.split(":", 1) for line in open("/proc/meminfo", encoding="ascii").read().splitlines() if ":" in line)
            kb = lambda key: float(info.get(key, "0 kB").split()[0])  # noqa: E731
            return round((kb("MemTotal") - kb("MemAvailable")) / 1024**2, 1)
        return 0.0
    except (OSError, ValueError, AttributeError):
        return 0.0


def torch_index(gpu: dict[str, Any]) -> tuple[str, str]:
    """(PyTorch wheel build, a warning or "") for an NVIDIA GPU."""
    cap, driver, name = float(gpu.get("compute_cap") or 0), float(gpu.get("driver") or 0), str(gpu.get("name") or "")
    blackwell = cap >= 12 or bool(re.search(r"RTX\s*50\d\d", name, re.I))
    if blackwell:
        if driver and driver < CU128_MIN_DRIVER:
            return "cu128", f"Update your NVIDIA driver to version {int(CU128_MIN_DRIVER)} or newer first: your card needs it."
        return "cu128", ""
    if cap and cap < 5.0:
        return "", "This GPU is too old for current PyTorch."
    if cap and cap < 7.5:
        return "cu126", ""
    return ("cu128" if not driver or driver >= CU128_MIN_DRIVER else "cu126"), ""


def summarize(gpus: list[dict[str, Any]], darwin_arm: bool, ram_gb: float, chip: str = "", others: list[str] | None = None) -> dict[str, Any]:
    """The hardware report from raw facts; separate from detection so it is easy to test."""
    if gpus:
        gpu = max(gpus, key=lambda g: g["vram_gb"])
        index, warning = torch_index(gpu)
        return {"backend": "cuda" if index else "none", "gpu": gpu["name"], "vram_gb": gpu["vram_gb"], "usable_gb": gpu["vram_gb"],
                "ram_gb": ram_gb, "torch_index": index, "compute_cap": gpu.get("compute_cap") or 0.0, "driver": gpu.get("driver") or 0.0,
                "warning": warning, "reason": "" if index else warning}
    if darwin_arm:
        # Apple silicon shares memory between CPU and GPU; about two thirds of it can hold a model.
        usable = round(ram_gb * 0.65, 1)
        return {"backend": "mps", "gpu": chip or "Apple silicon", "vram_gb": ram_gb, "usable_gb": usable, "ram_gb": ram_gb,
                "torch_index": "pypi", "compute_cap": 0.0, "driver": 0.0, "warning": "Apple silicon runs local models more slowly than an NVIDIA card.", "reason": ""}
    names = [n for n in (others or []) if n]
    reason = (f"{names[0]} isn't supported yet: local generation needs an NVIDIA graphics card (6 GB or more) or a Mac with Apple silicon."
              if names else "No supported graphics card found: local generation needs an NVIDIA card (6 GB or more) or a Mac with Apple silicon.")
    return {"backend": "none", "gpu": names[0] if names else "", "vram_gb": 0.0, "usable_gb": 0.0, "ram_gb": ram_gb, "torch_index": "",
            "compute_cap": 0.0, "driver": 0.0, "warning": "", "reason": reason}


@lru_cache(maxsize=1)
def _detect_cached() -> dict[str, Any]:
    override = os.environ.get("TESSERA_FAKE_GPU", "")
    if override:  # "RTX 4090,24" for screenshots and tests of other machines
        name, _, vram = override.partition(",")
        return summarize([{"name": name, "vram_gb": float(vram or 8), "compute_cap": 8.9, "driver": 580.0}], False, 32.0)
    darwin_arm = sys.platform == "darwin" and platform.machine() == "arm64"
    gpus = [] if darwin_arm else _nvidia()
    chip = _run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip() if darwin_arm else ""
    others = [] if gpus or darwin_arm else _other_gpu_names()
    return summarize(gpus, darwin_arm, system_ram_gb(), chip, others)


def detect(refresh: bool = False) -> dict[str, Any]:
    if refresh:
        _detect_cached.cache_clear()
    return dict(_detect_cached())
