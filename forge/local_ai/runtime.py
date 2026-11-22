"""Install, track and remove local models: the managed runtime (a venv with torch + diffusers) and model downloads.

Layout under the local AI folder (Settings never asks; `FORGE_LOCAL_AI_DIR` or config `local_ai_dir` can move it):

  runtime/        the venv, made with uv
  models/<repo>/  each Hugging Face repository, as plain files
  state.json      what is installed

An install runs in a background thread and reports through `INSTALLER.snapshot()`, which the page polls.
"""

from __future__ import annotations

import fnmatch
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from forge.config import get_config_dir
from forge.local_ai import catalog, hardware

WORKER = Path(__file__).with_name("worker_main.py")
RUNTIME_GB = 8.0  # torch with CUDA plus diffusers and friends, and uv's copy of the downloaded wheels
STALL_SECONDS = 600
LIBS = catalog.DEP_BY_ID["image-libs"].packages
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def root() -> Path:
    custom = os.environ.get("FORGE_LOCAL_AI_DIR", "").strip()
    if not custom:
        try:
            custom = str(json.loads((get_config_dir() / "config.json").read_text(encoding="utf-8")).get("local_ai_dir") or "").strip()
        except (OSError, ValueError, AttributeError):
            custom = ""
    return Path(custom) if custom else get_config_dir() / "local-ai"


def runtime_dir() -> Path:
    return root() / "runtime"


def python_path() -> Path:
    return runtime_dir() / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def repo_dir(repo: str) -> Path:
    return root() / "models" / repo.replace("/", "--")


def _state_file() -> Path:
    return root() / "state.json"


def read_state() -> dict[str, Any]:
    try:
        data = json.loads(_state_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(data: dict[str, Any]) -> None:
    _state_file().parent.mkdir(parents=True, exist_ok=True)
    _state_file().write_text(json.dumps(data, indent=2), encoding="utf-8")


def dep_installed(dep_id: str, state: dict[str, Any] | None = None) -> bool:
    """Installs from before dependencies were separate count PyTorch and the image libraries as installed."""
    state = read_state() if state is None else state
    if not python_path().is_file():
        return False
    if dep_id in (state.get("deps") or {}):
        return True
    return dep_id in ("pytorch", "image-libs") and "deps" not in state and bool((state.get("runtime") or {}).get("ok"))


def _with_needs(dep_ids, state: dict[str, Any] | None = None) -> list[str]:
    """The dependencies that aren't installed, each after the ones it needs."""
    state = read_state() if state is None else state
    order: list[str] = []

    def add(dep_id: str) -> None:
        for need in catalog.DEP_BY_ID[dep_id].needs:
            add(need)
        if dep_id not in order and not dep_installed(dep_id, state):
            order.append(dep_id)

    for dep_id in dep_ids:
        add(dep_id)
    return order


def missing_deps(model: catalog.LocalModel, state: dict[str, Any] | None = None) -> list[str]:
    return _with_needs(model.deps, state)


class NeedsDeps(ValueError):
    """A model needs dependencies the user hasn't agreed to install yet."""

    def __init__(self, model: catalog.LocalModel, missing: list[str]) -> None:
        self.missing = missing
        names = ", ".join(catalog.DEP_BY_ID[d].label for d in missing)
        super().__init__(f"{model.label} needs {names} first.")


def runtime_ready() -> bool:
    return dep_installed("pytorch") and dep_installed("image-libs")


def installed_ids() -> list[str]:
    if not runtime_ready():
        return []
    return [mid for mid in (read_state().get("models") or {}) if catalog.get(mid)]


def image_ready() -> bool:
    """Cheap enough for load_config: two small file reads."""
    return bool(installed_ids())


def model_paths(model: catalog.LocalModel) -> dict[str, Any]:
    """What the worker needs to load a model: real folders and files instead of repository names."""
    base_repo = next(iter(model.files))
    spec: dict[str, Any] = {"family": model.family, "base": str(repo_dir(base_repo)), "scheduler": model.scheduler}
    if model.family == "sdxl":
        spec["vae"] = str(repo_dir(catalog.SDXL_VAE))
    else:
        spec.update(clip=str(repo_dir(catalog.FLUX_CLIP)), t5=str(repo_dir(catalog.FLUX_T5)), vae=str(repo_dir(catalog.FLUX_VAE)),
                    guidance_embeds=bool(model.extra.get("guidance_embeds")))
    for key, ref in (("unet_file", model.unet_file), ("gguf_file", model.gguf_file)):
        if ref:
            repo, _, name = ref.rpartition("/")
            spec[key] = str(repo_dir(repo) / name)
    return spec


def local_env() -> dict[str, str]:
    """Every download, cache and temp file of an install stays in the local AI folder: the user picked that drive
    because the system drive is full, and uv, Hugging Face and Python would otherwise all write to C:."""
    base = root()
    dirs = {"UV_CACHE_DIR": base / "cache" / "uv", "UV_PYTHON_INSTALL_DIR": base / "python", "HF_HOME": base / "cache" / "hf",
            "TMP": base / "tmp", "TEMP": base / "tmp", "TMPDIR": base / "tmp"}
    for folder in dirs.values():
        folder.mkdir(parents=True, exist_ok=True)
    return {name: str(folder) for name, folder in dirs.items()}


def _folder_bytes(folder: Path) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


def disk_free_gb(path: Path | None = None) -> float:
    target = path or root()
    while not target.exists() and target.parent != target:
        target = target.parent
    try:
        return round(shutil.disk_usage(target).free / 1024**3, 1)
    except OSError:
        return 0.0


def _own_uv() -> Path:
    return root() / "tools" / ("uv.exe" if sys.platform == "win32" else "uv")


def find_uv() -> str:
    found = shutil.which("uv")
    if found:
        return found
    home = Path.home()
    for candidate in (_own_uv(), home / ".local/bin/uv.exe", home / ".local/bin/uv", home / ".cargo/bin/uv.exe", home / ".cargo/bin/uv",
                      Path(sys.executable).with_name("uv.exe"), Path(sys.executable).with_name("uv")):
        if candidate.is_file():
            return str(candidate)
    return ""


def uv_download_url() -> str:
    """Astral's own release of uv for this system (the desktop app ships without it)."""
    import platform

    arm = platform.machine().lower() in ("arm64", "aarch64")
    arch = "aarch64" if arm else "x86_64"
    if sys.platform == "win32":
        name = f"uv-{arch}-pc-windows-msvc.zip"
    elif sys.platform == "darwin":
        name = f"uv-{arch}-apple-darwin.tar.gz"
    else:
        name = f"uv-{arch}-unknown-linux-gnu.tar.gz"
    return f"https://github.com/astral-sh/uv/releases/latest/download/{name}"


def fetch_uv() -> str:
    """Download uv into the local AI folder and return its path."""
    import io
    import tarfile
    import zipfile

    import httpx

    url = uv_download_url()
    with httpx.Client(follow_redirects=True, timeout=120.0) as client:
        resp = client.get(url)
        resp.raise_for_status()
    target = _own_uv()
    target.parent.mkdir(parents=True, exist_ok=True)
    wanted = target.name
    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(resp.content)) as archive:
            member = next(n for n in archive.namelist() if n.rsplit("/", 1)[-1] == wanted)
            target.write_bytes(archive.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as archive:
            member = next(m for m in archive.getmembers() if m.isfile() and m.name.rsplit("/", 1)[-1] == wanted)
            handle = archive.extractfile(member)
            target.write_bytes(handle.read() if handle else b"")
        target.chmod(0o755)
    return str(target)


def _torch_index_args(hw: dict[str, Any]) -> list[str]:
    return [] if hw.get("torch_index") in ("", "pypi", None) else ["--index-url", f"https://download.pytorch.org/whl/{hw['torch_index']}"]


def dep_commands(dep: catalog.Dependency, hw: dict[str, Any], uv: str) -> list[tuple[str, list[str]]]:
    """(stage label, command) to install one dependency for this hardware."""
    py = str(python_path())
    if dep.id == "pytorch":
        torch = "torch>=2.7" if _torch_index_args(hw) else "torch>=2.5"
        steps = [] if Path(py).is_file() else [("Setting up Python", [uv, "venv", "--python", "3.12", str(runtime_dir())])]
        return steps + [("Installing PyTorch", [uv, "pip", "install", "--python", py, torch, *_torch_index_args(hw)])]
    steps = []
    if dep.from_torch_index:
        # From the same CUDA wheels index as PyTorch, so it matches the installed build and never swaps PyTorch out.
        steps.append((f"Installing {dep.label}", [uv, "pip", "install", "--python", py, *dep.from_torch_index, *_torch_index_args(hw)]))
    if dep.packages:
        steps.append((f"Installing {dep.label}", [uv, "pip", "install", "--python", py, *dep.packages]))
    return steps


def runtime_commands(hw: dict[str, Any], uv: str) -> list[tuple[str, list[str]]]:
    """(stage label, command) for what image models need: PyTorch, then the image libraries."""
    libs = dep_commands(catalog.DEP_BY_ID["image-libs"], hw, uv)
    return dep_commands(catalog.DEP_BY_ID["pytorch"], hw, uv) + [("Installing the image libraries", args) for _, args in libs]


def needed_gb(model: catalog.LocalModel) -> float:
    present = [repo for repo, patterns in model.files.items() if _repo_complete(repo, patterns)]
    if len(present) == len(model.files):
        share = 0.0  # every file is already here (a model removed from the list, or files moved in): only checked again
    else:
        share = model.size_gb * (0.5 if present else 1.0)  # a shared repository already on disk saves part of it
    return round(share + sum(catalog.DEP_BY_ID[d].size_gb for d in missing_deps(model)), 1)


def _repo_complete(repo: str, patterns: tuple[str, ...]) -> bool:
    """Every pattern has a finished file (Hugging Face keeps unfinished downloads under .cache, never at the path)."""
    folder = repo_dir(repo)
    if not folder.is_dir():
        return False
    files = [p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file() and ".cache" not in p.parts and p.stat().st_size]
    return all(any(fnmatch.fnmatch(f, pat) for f in files) for pat in patterns)


class Cancelled(Exception):
    pass


class Installer:
    """One install at a time; the page polls snapshot()."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._cancel = False
        self._reset()

    def _reset(self) -> None:
        self.status, self.model, self.stage, self.percent, self.error, self.kind = "idle", "", "", 0.0, "", "install"
        self.log: deque[str] = deque(maxlen=40)

    def snapshot(self) -> dict[str, Any]:
        return {"status": self.status, "model": self.model, "stage": self.stage, "percent": round(self.percent, 1), "error": self.error, "kind": self.kind}

    @property
    def running(self) -> bool:
        return self.status == "running"

    def start(self, model_id: str, hw: dict[str, Any] | None = None, accept_license: bool = False, install_deps: bool = True) -> dict[str, Any]:
        """Install a model (with its missing dependencies when `install_deps`), or one dependency ("dep:<id>")."""
        hw = hw or hardware.detect()
        if model_id.startswith("dep:"):
            return self._start_dep(model_id[4:], hw)
        model = catalog.get(model_id)
        if not model:
            raise ValueError(f"Unknown local model '{model_id}'.")
        fit = catalog.fit(model, hw)
        if fit == "low_ram":
            raise ValueError(f"{model.label} needs {model.min_ram_gb:g} GB of system memory and this PC has {hw.get('ram_gb'):g} GB.")
        if fit in ("too_big", "unsupported"):
            raise ValueError(f"{model.label} won't run on this computer: {hw.get('reason') or 'not enough video memory'}.")
        if model.personal_only and not accept_license:
            raise ValueError(f"{model.label} may only be used non-commercially. Accept its license to install it.")
        if hw.get("warning") and hw.get("backend") == "cuda" and "driver" in hw["warning"]:
            raise ValueError(hw["warning"])
        missing = missing_deps(model)
        if missing and not install_deps:
            raise NeedsDeps(model, missing)
        self._check_space(model.label, needed_gb(model))
        self._begin(model.id)
        threading.Thread(target=self._run, args=(model, missing, hw), name="local-ai-install", daemon=True).start()
        return self.snapshot()

    def _start_dep(self, dep_id: str, hw: dict[str, Any]) -> dict[str, Any]:
        dep = catalog.DEP_BY_ID.get(dep_id)
        if not dep:
            raise ValueError(f"Unknown dependency '{dep_id}'.")
        if hw.get("backend") == "none":
            raise ValueError(f"{dep.label} needs an NVIDIA graphics card or an Apple silicon Mac.")
        order = _with_needs([dep_id])
        if not order:
            return self.snapshot()
        self._check_space(dep.label, sum(catalog.DEP_BY_ID[d].size_gb for d in order))
        self._begin(f"dep:{dep_id}")
        threading.Thread(target=self._run, args=(None, order, hw), name="local-ai-install", daemon=True).start()
        return self.snapshot()

    def _check_space(self, label: str, need: float) -> None:
        free = disk_free_gb()
        if free and free < need + 1:
            raise ValueError(f"Not enough disk space: {label} needs about {need:g} GB and {free:g} GB is free at {root()}. Choose a folder on another drive in Settings → This PC.")

    def _begin(self, what: str) -> None:
        with self._lock:
            if self.running:
                raise ValueError("Something is already installing. Wait for it to finish, or stop it.")
            self._reset()
            self.status, self.model, self.stage, self._cancel = "running", what, "Starting", False

    def start_move(self, source: Path, target: Path) -> dict[str, Any]:
        need = sum(_folder_bytes(source / sub) for sub in MOVED) / 1024**3
        target.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(target).free / 1024**3
        if source.drive.lower() != target.drive.lower() and free < need + 1:
            raise ValueError(f"Not enough room: moving needs about {need:.1f} GB and {free:.1f} GB is free at {target}.")
        with self._lock:
            if self.running:
                raise ValueError("Wait for the install to finish, or stop it, first.")
            self._reset()
            self.status, self.kind, self.stage = "running", "move", "Moving your models"
        threading.Thread(target=self._move, args=(source, target, need), name="local-ai-move", daemon=True).start()
        return self.snapshot()

    def _move(self, source: Path, target: Path, need_gb: float) -> None:
        from forge.local_ai.engine import ENGINE

        moved = {"bytes": 0}

        def on_file(size: int) -> None:
            moved["bytes"] += size
            self.percent = min(99.0, 100.0 * moved["bytes"] / max(need_gb * 1024**3, 1))
            self.stage = f"Moving your models · {moved['bytes'] / 1024**3:.1f} of {need_gb:.1f} GB"

        try:
            ENGINE.stop()
            for sub in MOVED:
                if (source / sub).exists():
                    _merge_move(source / sub, target / sub, on_file)
            _repoint_venv(target, source)
            old_state, new_state = read_state(), {}
            state_file = target / "state.json"
            if state_file.is_file():
                try:
                    new_state = json.loads(state_file.read_text(encoding="utf-8"))
                except ValueError:
                    new_state = {}
            merged = {**new_state, **old_state, "models": {**(new_state.get("models") or {}), **(old_state.get("models") or {})}}
            state_file.write_text(json.dumps(merged, indent=2), encoding="utf-8")
            _save_folder(target)
            shutil.rmtree(source, ignore_errors=True)  # only caches and temp files are left; the folder is Tessera's own
            self.status, self.stage, self.percent = "done", "Moved", 100.0
        except Exception as err:  # noqa: BLE001
            self.status, self.error = "error", f"Moving stopped: {err}. Files already moved are in {target}; choose that folder again to finish."

    def cancel(self) -> None:
        self._cancel = True
        proc = self._proc
        if proc and proc.poll() is None:
            proc.kill()

    # ---- the install itself, in its thread ----

    def _run(self, model: catalog.LocalModel | None, deps: list[str], hw: dict[str, Any]) -> None:
        try:
            # The bar: each dependency takes a share by its size, the model's download the rest.
            sizes = [catalog.DEP_BY_ID[d].size_gb for d in deps]
            total = max(sum(sizes) + (model.size_gb if model else 0), 0.01)
            done = 0.0
            for dep_id, size in zip(deps, sizes):
                self._install_dep(catalog.DEP_BY_ID[dep_id], hw, 100 * done / total, 100 * size / total)
                done += size
            if model:
                self.percent = 100 * done / total
                self._download(model)
                state = read_state()
                state.setdefault("models", {})[model.id] = {"installed_at": time.time(), "size_gb": model.size_gb}
                write_state(state)
                if model.kind == "image":
                    _make_default_if_alone(model.id)
            self.status, self.stage, self.percent = "done", "Installed", 100.0
        except Cancelled:
            self.status, self.stage = "cancelled", "Stopped"
        except Exception as err:  # noqa: BLE001
            self.status, self.error = "error", str(err) or type(err).__name__
        finally:
            self._proc = None

    def _command(self, args: list[str], env: dict[str, str] | None = None, on_tick=None) -> str:
        """Run one install step. `on_tick()` returns how many bytes the step has written so far; a step that writes
        nothing and prints nothing for STALL_SECONDS is stopped (a full disk or a dead connection hangs, not fails)."""
        if self._cancel:
            raise Cancelled()
        self.log.append("$ " + " ".join(args[:4]))
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                env={**os.environ, **local_env(), **(env or {})}, creationflags=_NO_WINDOW)
        self._proc = proc
        out: list[str] = []
        reader = threading.Thread(target=lambda: [out.append(line) or self.log.append(line.rstrip()) for line in proc.stdout or []], daemon=True)
        reader.start()
        last_seen, last_change = (-1, -1), time.monotonic()
        while proc.poll() is None:
            seen = (on_tick() if on_tick else 0, len(out))
            if seen != last_seen:
                last_seen, last_change = seen, time.monotonic()
            elif time.monotonic() - last_change > STALL_SECONDS:
                proc.kill()
                free = disk_free_gb()
                why = f"the drive is full ({free:g} GB free)" if free < 1 else "nothing arrived for 10 minutes; check your internet connection"
                raise RuntimeError(f"{self.stage} stalled: {why}. Install again to pick up where it stopped.")
            time.sleep(1.0)
        reader.join(timeout=5)
        if self._cancel:
            raise Cancelled()
        if proc.returncode != 0:
            tail = " ".join(line.strip() for line in list(self.log)[-4:])[-400:]
            raise RuntimeError(f"{self.stage} failed: {tail}")
        return "".join(out)

    def _watch(self, label: str, start: float, share: float, expect_gb: float):
        """A tick that shows the bytes a step writes into the local AI folder as progress inside its share of the bar."""
        folders = [root() / "cache", runtime_dir()]
        before = sum(_folder_bytes(f) for f in folders)
        state = {"at": 0.0, "got": 0}

        def tick() -> int:
            if time.monotonic() - state["at"] >= 2:
                state["at"], state["got"] = time.monotonic(), max(sum(_folder_bytes(f) for f in folders) - before, 0)
                gb = state["got"] / 1024**3
                self.percent = start + share * min(gb / expect_gb, 0.97)
                self.stage = f"{label} · {gb:.1f} GB" if gb >= 0.05 else label
            return state["got"]

        return tick

    def _install_dep(self, dep: catalog.Dependency, hw: dict[str, Any], start: float, share: float) -> None:
        uv = find_uv()
        if not uv:
            self.stage = "Getting the installer"
            try:
                uv = fetch_uv()
            except Exception as err:  # noqa: BLE001
                raise RuntimeError(f"Couldn't download uv, the tool that installs the engine: {err}. Check your internet connection.") from err
        state = read_state()
        if "deps" not in state:  # an install from before dependencies were separate keeps what it had
            state["deps"] = {d: {"installed_at": time.time()} for d in ("pytorch", "image-libs") if dep_installed(d, state)}
            write_state(state)
        commands = dep_commands(dep, hw, uv)
        # (part of this dependency's share, GB the step roughly writes: PyTorch's wheel is ~3 GB and is unpacked next to it)
        weights = {"Setting up Python": (0.05, 0.1), "Installing PyTorch": (0.95, 7.5)}
        done = start
        for label, args in commands:
            part, expect = weights.get(label, (1 / len(commands), max(dep.size_gb, 0.1)))
            self.stage, self.percent = label, done
            self._command(args, on_tick=self._watch(label, done, share * part, expect))
            done += share * part
        state = read_state()
        if dep.id == "pytorch":
            self.stage = "Checking your graphics card"
            out = self._command([str(python_path()), str(WORKER), "probe"])
            info = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
            if hw.get("backend") == "cuda" and not (info.get("cuda") and info.get("kernel_ok", True)):
                raise RuntimeError(f"PyTorch can't use your {hw.get('gpu') or 'GPU'}: {info.get('error') or 'CUDA is not available'}. Updating the NVIDIA driver usually fixes this.")
            state = read_state()
            state["runtime"] = {"ok": True, "torch": info.get("torch", ""), "device": info.get("device", ""),
                                "index": hw.get("torch_index", ""), "installed_at": time.time()}
        state.setdefault("deps", {})[dep.id] = {"installed_at": time.time()}
        write_state(state)
        self.percent = start + share

    def _download(self, model: catalog.LocalModel) -> None:
        self.stage = f"Downloading {model.label}"
        start = self.percent
        repos = [{"repo": repo, "allow": list(patterns), "dir": str(repo_dir(repo))} for repo, patterns in model.files.items()]
        folders = [repo_dir(repo) for repo in model.files]
        before = sum(_folder_bytes(f) for f in folders)
        expected = max(model.size_gb * 1024**3 - before, 1)

        label = self.stage
        state = {"at": 0.0, "got": 0}

        def tick() -> int:
            if time.monotonic() - state["at"] >= 2:
                state["at"], state["got"] = time.monotonic(), max(sum(_folder_bytes(f) for f in folders) - before, 0)
                self.percent = start + (99.0 - start) * min(state["got"] / expected, 1.0)
                self.stage = f"{label} · {state['got'] / 1024**3:.1f} of {model.size_gb:g} GB"
            return state["got"]

        self._command([str(python_path()), str(WORKER), "download", json.dumps({"repos": repos})],
                      env={"HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1"}, on_tick=tick)


def _make_default_if_alone(model_id: str) -> None:
    """With no other image model that works, new images go to the one just installed."""
    from forge.asset_studio import list_image_models
    from forge.config import save_config

    others = [m for m in list_image_models() if m["available"] and not str(m["id"]).startswith("local:")]
    if not others:
        save_config({"default_image_model": f"local:{model_id}", "user_locked_image_model": True})


def remove(model_id: str) -> None:
    """Delete a model's files, keeping any a remaining model still uses."""
    model = catalog.get(model_id)
    if not model:
        raise ValueError(f"Unknown local model '{model_id}'.")
    if INSTALLER.running:
        raise ValueError("Wait for the install to finish, or stop it, first.")
    from forge.local_ai.engine import ENGINE

    ENGINE.stop()
    state = read_state()
    (state.get("models") or {}).pop(model.id, None)
    keep: dict[str, list[str]] = {}
    for other_id in state.get("models") or {}:
        other = catalog.get(other_id)
        for repo, patterns in (other.files.items() if other else []):
            keep.setdefault(repo, []).extend(patterns)
    for repo, patterns in model.files.items():
        folder = repo_dir(repo)
        if not folder.is_dir():
            continue
        if repo not in keep:
            shutil.rmtree(folder, ignore_errors=True)
            continue
        for path in [p for p in folder.rglob("*") if p.is_file()]:
            rel = path.relative_to(folder).as_posix()
            if any(fnmatch.fnmatch(rel, pat) for pat in patterns) and not any(fnmatch.fnmatch(rel, pat) for pat in keep[repo]):
                path.unlink(missing_ok=True)
    write_state(state)
    _drop_default(model.id)


def all_deps(model: catalog.LocalModel) -> list[str]:
    """Every dependency a model needs, including what those need."""
    out: list[str] = []

    def add(dep_id: str) -> None:
        for need in catalog.DEP_BY_ID[dep_id].needs:
            add(need)
        if dep_id not in out:
            out.append(dep_id)

    for dep_id in model.deps:
        add(dep_id)
    return out


def dep_users(dep_id: str, state: dict[str, Any] | None = None) -> list[str]:
    """Labels of installed models and dependencies that need this dependency."""
    state = read_state() if state is None else state
    users = [m.label for m in catalog.MODELS if m.id in (state.get("models") or {}) and dep_id in all_deps(m)]
    for other in catalog.DEPS:
        if other.id != dep_id and dep_installed(other.id, state) and dep_id in _needs_closure(other.id):
            users.append(other.label)
    return users


def _needs_closure(dep_id: str) -> set[str]:
    out: set[str] = set()
    for need in catalog.DEP_BY_ID[dep_id].needs:
        out |= {need} | _needs_closure(need)
    return out


class InUse(ValueError):
    def __init__(self, dep: catalog.Dependency, users: list[str]) -> None:
        self.users = users
        super().__init__(f"{', '.join(users)} {'needs' if len(users) == 1 else 'need'} {dep.label}. Remove {'it' if len(users) == 1 else 'them'} first, or remove {dep.label} anyway.")


def _package_name(spec: str) -> str:
    import re

    return re.split(r"[<>=!~ \[]", spec, maxsplit=1)[0]


KEEP_PACKAGES = {"pillow"}  # small, and other packages lean on it


def remove_dep(dep_id: str, force: bool = False) -> None:
    """Uninstall one dependency. Models stay on disk; the ones that need it say so until it is back."""
    dep = catalog.DEP_BY_ID.get(dep_id)
    if not dep:
        raise ValueError(f"Unknown dependency '{dep_id}'.")
    if INSTALLER.running:
        raise ValueError("Wait for the install to finish, or stop it, first.")
    state = read_state()
    if not dep_installed(dep_id, state):
        return
    users = dep_users(dep_id, state)
    if users and not force:
        raise InUse(dep, users)
    from forge.local_ai.engine import ENGINE

    ENGINE.stop()
    if "deps" not in state:
        state["deps"] = {d: {"installed_at": time.time()} for d in ("pytorch", "image-libs") if dep_installed(d, state)}
    if dep_id == "pytorch":
        # Every other dependency lives inside PyTorch's Python, so they all go with it.
        for sub in ("runtime", "python"):
            shutil.rmtree(root() / sub, ignore_errors=True)
        state.pop("runtime", None)
        state["deps"] = {}
    else:
        names = [_package_name(p) for p in (*dep.packages, *dep.from_torch_index) if _package_name(p).lower() not in KEEP_PACKAGES]
        uv = find_uv() or fetch_uv()
        done = subprocess.run([uv, "pip", "uninstall", "--python", str(python_path()), *names], capture_output=True, text=True,
                              env={**os.environ, **local_env()}, creationflags=_NO_WINDOW, check=False)
        if done.returncode != 0:
            raise RuntimeError(f"Couldn't remove {dep.label}: {(done.stderr or done.stdout).strip()[-300:]}")
        state["deps"].pop(dep_id, None)
    write_state(state)


def remove_everything() -> None:
    if INSTALLER.running:
        raise ValueError("Wait for the install to finish, or stop it, first.")
    from forge.local_ai.engine import ENGINE

    ENGINE.stop()
    for model_id in list((read_state().get("models") or {})):
        _drop_default(model_id)
    for sub in ("runtime", "models", "cache", "python", "tmp", "tools"):
        shutil.rmtree(root() / sub, ignore_errors=True)
    write_state({})


FOLDER_NAME = "Tessera local models"


def set_folder(folder: str) -> Path:
    """Keep the engine and models in a folder on another drive (models are big; C: is often full).

    The files go in a subfolder of the chosen one, so removing them never touches the user's own files. Anything
    already installed moves along (in the installer's thread, with progress), so nothing has to be downloaded again."""
    if INSTALLER.running:
        raise ValueError("Wait for the install to finish, or stop it, first.")
    base = Path(folder).expanduser()
    if not folder or not base.is_absolute():
        raise ValueError("Choose a full folder path, like D:\\AI.")
    if not base.is_dir():
        raise ValueError(f"There's no folder at {base}.")
    target = base if base.name == FOLDER_NAME else base / FOLDER_NAME
    current = root()
    if target.resolve() == current.resolve():
        return target
    if current.resolve() in target.resolve().parents:
        raise ValueError("Choose a folder outside the current one.")
    state = read_state()
    if state.get("runtime") or state.get("models"):
        INSTALLER.start_move(current, target)
        return target
    target.mkdir(parents=True, exist_ok=True)
    _save_folder(target)
    return target


def _save_folder(target: Path) -> None:
    from forge.config import save_config

    save_config({"local_ai_dir": str(target)})


MOVED = ("runtime", "python", "models", "tools")  # caches and temp files are left behind and deleted


def _merge_move(src: Path, dst: Path, on_file) -> None:
    """Move src into dst, merging folders that already exist there (the new folder may hold models already)."""
    if src.is_dir() and not src.is_symlink():
        dst.mkdir(parents=True, exist_ok=True)
        for child in list(src.iterdir()):
            _merge_move(child, dst / child.name, on_file)
        src.rmdir()
        return
    size = src.stat().st_size
    if dst.exists():
        dst.unlink()
    shutil.move(str(src), str(dst))
    on_file(size)


def _repoint_venv(target: Path, old: Path) -> None:
    """The engine's venv names its Python by full path; point it at the moved copy."""
    cfg = target / "runtime" / "pyvenv.cfg"
    if cfg.is_file():
        text = cfg.read_text(encoding="utf-8")
        cfg.write_text(text.replace(str(old), str(target)), encoding="utf-8")


def _drop_default(model_id: str) -> None:
    from forge.config import load_config, save_config

    if load_config().default_image_model == f"local:{model_id}":
        save_config({"default_image_model": "gemini-nano-banana-2.1", "user_locked_image_model": False})


def status() -> dict[str, Any]:
    """Everything the This PC page shows."""
    hw = hardware.detect()
    state = read_state()
    installed = set(installed_ids())
    best = {kind: catalog.recommended(hw, kind) for kind, _ in catalog.KINDS}
    models = []
    for model in catalog.MODELS:
        row = catalog.describe(model, hw)
        row["installed"] = model.id in installed
        row["recommended"] = model.id == best.get(model.kind)
        row["missing_deps"] = missing_deps(model, state)
        row["needed_gb"] = round(sum(catalog.DEP_BY_ID[d].size_gb for d in row["missing_deps"]), 1) if row["installed"] else needed_gb(model)
        models.append(row)
    deps = [{"id": d.id, "label": d.label, "blurb": d.blurb, "size_gb": d.size_gb, "needs": list(d.needs),
             "installed": dep_installed(d.id, state), "used_by": dep_users(d.id, state)} for d in catalog.DEPS]
    return {"hardware": hw, "preset": catalog.preset_name(hw), "recommended": best.get("image", ""), "models": models, "deps": deps,
            "kinds": [list(k) for k in catalog.KINDS], "engine": ENGINE_STATUS(), "ram_used_gb": hardware.ram_in_use_gb(),
            "runtime": {**(state.get("runtime") or {}), "ready": runtime_ready(), "size_gb": RUNTIME_GB},
            "folder": str(root()), "disk_free_gb": disk_free_gb(), "install": INSTALLER.snapshot(), "uv": bool(find_uv())}


def ENGINE_STATUS() -> dict[str, Any]:  # noqa: N802
    from forge.local_ai.engine import ENGINE

    return ENGINE.status()


INSTALLER = Installer()
