"""The running local worker: started on the first local generation, kept warm, stopped after a few idle minutes.

One image at a time (a GPU can't usefully run two). Stopping the process is what frees the video memory, so a user
who goes back to their game gets the whole card back.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable

from forge.local_ai import runtime

IDLE_SECONDS = 900  # loading costs far more than an idle worker; keep it warm for a working session
# FLUX holds ~17 GB of system memory while loaded (T5 plus the streamed layers): give it back sooner.
IDLE_BY_FAMILY = {"flux": 180}
LINE_TIMEOUT = 900  # loading a big model from a slow disk takes minutes the first time

Progress = Callable[[int, str], Awaitable[None] | None]


class LocalEngineError(Exception):
    def __init__(self, message: str, oom: bool = False) -> None:
        super().__init__(message)
        self.oom = oom


class LocalEngine:
    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=30)
        self._lock: asyncio.Lock | None = None
        self._last_used = 0.0
        self._watchdog: threading.Thread | None = None
        self._loaded = ""  # label of the model the worker holds
        self._family = ""

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _start(self) -> None:
        python = runtime.python_path()
        if not python.is_file():
            raise LocalEngineError("Local generation isn't installed. Open Settings → This PC to install a model.")
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
               "PYTHONUNBUFFERED": "1"}
        self._lines = queue.Queue()
        self._stderr.clear()
        proc = subprocess.Popen([str(python), str(runtime.WORKER), "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self._proc = proc
        lines = self._lines

        def pump_out() -> None:
            for line in proc.stdout or []:
                lines.put(line)
            lines.put(None)

        def pump_err() -> None:
            for line in proc.stderr or []:
                self._stderr.append(line.rstrip())

        threading.Thread(target=pump_out, daemon=True).start()
        threading.Thread(target=pump_err, daemon=True).start()
        if self._watchdog is None or not self._watchdog.is_alive():
            self._watchdog = threading.Thread(target=self._idle_loop, daemon=True)
            self._watchdog.start()

    def _idle_loop(self) -> None:
        while True:
            time.sleep(15)
            if not self.running:
                return
            if self._lock is not None and self._lock.locked():
                continue
            if time.time() - self._last_used > self.idle_seconds:
                self.stop()
                return

    @property
    def idle_seconds(self) -> int:
        return IDLE_BY_FAMILY.get(self._family, IDLE_SECONDS)

    def status(self) -> dict[str, Any]:
        """What the This PC page shows: the model held and the system memory it takes."""
        if not self.running or not self._proc:
            return {"running": False}
        busy = self._lock is not None and self._lock.locked()
        left = max(0, int(self.idle_seconds - (time.time() - self._last_used))) if self._last_used else self.idle_seconds
        return {"running": True, "busy": busy, "model": self._loaded, "ram_gb": round(_rss_gb(self._proc.pid), 1), "frees_in": left}

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        self._loaded, self._family = "", ""
        if proc and proc.poll() is None:
            try:
                proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")  # type: ignore[union-attr]
                proc.stdin.flush()  # type: ignore[union-attr]
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                proc.kill()

    async def _read(self) -> dict[str, Any]:
        while True:
            line = await asyncio.to_thread(self._lines.get, True, LINE_TIMEOUT)
            if line is None:
                detail = " ".join(list(self._stderr)[-3:])[-400:]
                self._proc = None
                raise LocalEngineError(f"The local worker stopped. {detail}".strip())
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                return json.loads(line)
            except ValueError:
                continue

    async def generate(self, request: dict[str, Any], progress_cb: Progress | None = None, label: str = "") -> dict[str, Any]:
        result = await self._ask({"cmd": "generate", **request}, progress_cb)
        family = str((request.get("spec") or {}).get("family") or "")
        if family:
            self._family, self._loaded = family, label or family
        return result

    async def cutout(self, image: str, out: str, model_dir: str) -> dict[str, Any]:
        """Cut the background out of a picture with BiRefNet; it stays loaded next to the image model."""
        result = await self._ask({"cmd": "cutout", "image": image, "out": out, "dir": model_dir}, None)
        if not self._loaded:
            self._loaded = "BiRefNet"
        return result

    async def _ask(self, payload: dict[str, Any], progress_cb: Progress | None) -> dict[str, Any]:
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if not self.running:
                self._start()
                if progress_cb:
                    await _call(progress_cb, 5, "Starting the local model…")
            assert self._proc and self._proc.stdin
            self._proc.stdin.write(json.dumps(payload) + "\n")
            self._proc.stdin.flush()
            try:
                while True:
                    msg = await self._read()
                    if msg.get("event") == "ready":
                        continue
                    if msg.get("event") == "progress":
                        if progress_cb:
                            step, steps = int(msg.get("step") or 0), max(int(msg.get("steps") or 1), 1)
                            await _call(progress_cb, 20 + int(75 * step / steps), f"Drawing on this PC · step {step} of {steps}")
                        continue
                    if not msg.get("ok"):
                        raise LocalEngineError(str(msg.get("error") or "Local generation failed."), oom=bool(msg.get("oom")))
                    return msg
            except queue.Empty as err:
                self.stop()
                raise LocalEngineError("The local model stopped answering, so Tessera restarted it. Try again.") from err
            finally:
                self._last_used = time.time()


def _tree_pids_windows(pid: int) -> list[int]:
    """The process and everything it started: a venv's python.exe is a launcher that runs the real Python as a child."""
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    k32 = ctypes.windll.kernel32
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        return [pid]
    parents: dict[int, int] = {}
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(Entry)
        ok = k32.Process32FirstW(wintypes.HANDLE(snap), ctypes.byref(entry))
        while ok:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            ok = k32.Process32NextW(wintypes.HANDLE(snap), ctypes.byref(entry))
    finally:
        k32.CloseHandle(wintypes.HANDLE(snap))
    tree = [pid]
    for parent in tree:  # grows while it walks
        tree.extend(child for child, of in parents.items() if of == parent and child not in tree and child != 0)
    return tree


def _rss_gb(pid: int) -> float:
    """Resident memory of a process and its children in GB, without psutil."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            k32 = ctypes.windll.kernel32
            k32.OpenProcess.restype = wintypes.HANDLE
            psapi = ctypes.windll.psapi
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            total = 0
            for one in _tree_pids_windows(pid):
                handle = k32.OpenProcess(0x1000 | 0x0010, False, one)  # QUERY_LIMITED_INFORMATION | VM_READ
                if not handle:
                    continue
                try:
                    counters = Counters()
                    counters.cb = ctypes.sizeof(Counters)
                    if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                        total += counters.WorkingSetSize
                finally:
                    k32.CloseHandle(wintypes.HANDLE(handle))
            return total / 1024**3
        status = Path(f"/proc/{pid}/status")
        if status.is_file():
            kb = next((int(line.split()[1]) for line in status.read_text().splitlines() if line.startswith("VmRSS:")), 0)
            return kb / 1024**2
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, check=False).stdout.strip()
        return int(out or 0) / 1024**2
    except Exception:  # noqa: BLE001
        return 0.0


async def _call(cb: Progress, pct: int, text: str) -> None:
    result = cb(pct, text)
    if hasattr(result, "__await__"):
        await result  # type: ignore[misc]


ENGINE = LocalEngine()
