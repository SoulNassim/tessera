"""This PC: free local image models. No test downloads anything or needs a GPU; the worker and installs are faked."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from forge.local_ai import catalog, hardware, runtime
from forge.local_ai.cutout import remove_plain_background

RTX_5060_TI = "NVIDIA GeForce RTX 5060 Ti, 8151, 12.0, 580.88"


def hw_for(row: str, ram_gb: float = 32.0) -> dict:
    return hardware.summarize(hardware.parse_nvidia_smi(row), False, ram_gb)


@pytest.fixture(autouse=True)
def _no_keys(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # The developer's own keys (environment, Windows registry, Meshy CLI login) must not leak into these tests.
    for name in ("GEMINI_API_KEY", "MESHY_API_KEY", "ELEVENLABS_API_KEY", "STABILITY_API_KEY", "TRIPO_API_KEY", "FORGE_LOCAL_AI_DIR", "FORGE_DEMO_MODE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("forge.config._read_win32_user_env", lambda name: "")
    monkeypatch.setenv("MESHY_CONFIG_DIR", str(tmp_path / "meshy"))
    runtime.INSTALLER._reset()


# ---------- hardware and recommendations ----------

def test_an_8gb_blackwell_card_gets_cuda_12_8_and_the_light_preset() -> None:
    hw = hw_for(RTX_5060_TI)
    assert (hw["backend"], hw["torch_index"], hw["vram_gb"], hw["warning"]) == ("cuda", "cu128", 8.0, "")
    assert catalog.preset_name(hw) == "Light"
    # FLUX schnell streams its layers from system memory on 8 GB: it needs the RAM for that, then it is the best choice.
    assert catalog.recommended(hw) == "flux-schnell-q4"
    assert catalog.fit(catalog.BY_ID["flux-schnell-q4"], hw) == "good" and catalog.BY_ID["flux-schnell-q4"].offload(hw["usable_gb"])
    assert catalog.BY_ID["sdxl-lightning"].offload(hw["usable_gb"])  # 8 GB is tight: parts wait in system memory
    small_ram = hw_for(RTX_5060_TI, 16.0)
    assert catalog.fit(catalog.BY_ID["flux-schnell-q4"], small_ram) == "low_ram" and catalog.recommended(small_ram) == "sdxl-lightning"
    with pytest.raises(ValueError, match="system memory"):
        runtime.INSTALLER.start("flux-schnell-q4", small_ram)


def test_a_blackwell_card_on_an_old_driver_is_told_to_update_and_install_refuses() -> None:
    hw = hw_for("NVIDIA GeForce RTX 5070, 12227, 12.0, 561.09")
    assert hw["torch_index"] == "cu128" and "driver" in hw["warning"]
    with pytest.raises(ValueError, match="driver"):
        runtime.INSTALLER.start("sdxl-lightning", hw)


def test_bigger_cards_get_better_models_and_older_cards_older_wheels() -> None:
    mid = hw_for("NVIDIA GeForce RTX 4070, 12282, 8.9, 581.0")
    assert catalog.recommended(mid) == "flux-schnell-q4" and not catalog.BY_ID["flux-schnell-q4"].offload(mid["usable_gb"])
    big = hw_for("NVIDIA GeForce RTX 4090, 24564, 8.9, 581.0")
    assert (catalog.recommended(big), catalog.preset_name(big)) == ("flux-schnell-q8", "High")
    pascal = hw_for("NVIDIA GeForce GTX 1080, 8192, 6.1, 538.0")
    assert pascal["torch_index"] == "cu126"
    assert catalog.recommended(hw_for("NVIDIA GeForce GTX 1650, 4096, 7.5, 581.0")) == ""  # 4 GB runs nothing


def test_macs_get_sdxl_and_unsupported_gpus_say_why() -> None:
    mac = hardware.summarize([], True, 16.0, "Apple M2 Pro")
    assert mac["backend"] == "mps" and mac["usable_gb"] == 10.4
    assert catalog.recommended(mac) == "sdxl-lightning"
    assert catalog.fit(catalog.BY_ID["flux-schnell-q4"], mac) == "unsupported"
    amd = hardware.summarize([], False, 32.0, others=["AMD Radeon RX 7800 XT"])
    assert amd["backend"] == "none" and "Radeon" in amd["reason"] and catalog.recommended(amd) == ""


def test_every_model_allows_commercial_use_unless_it_is_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    for model in catalog.MODELS:
        assert ("commercial use allowed" in model.license) != model.personal_only
        assert all("black-forest-labs" not in repo for repo in model.files)  # gated: needs a Hugging Face account
    dev = catalog.BY_ID["flux-dev-q4"]
    big = hw_for("NVIDIA GeForce RTX 4090, 24564, 8.9, 581.0")
    assert catalog.fit(dev, big) == "good" and catalog.recommended(big) != dev.id  # never recommended
    fake_install(monkeypatch)
    with pytest.raises(ValueError, match="Accept its license"):
        runtime.INSTALLER.start(dev.id, big)
    runtime.INSTALLER.start(dev.id, big, accept_license=True)
    assert wait_install()["status"] == "done"
    spec = runtime.model_paths(dev)
    assert spec["guidance_embeds"] and spec["gguf_file"].endswith("flux1-dev-Q4_K_S.gguf") and "t5-v1_1-xxl" in spec["t5"]
    # Files already on disk (moved in, or a model taken off the list) download nothing; shared ones save half.
    state = runtime.read_state(); state["models"].pop(dev.id); runtime.write_state(state)
    assert runtime.needed_gb(dev) == 0.0 and runtime.needed_gb(catalog.BY_ID["flux-schnell-q4"]) == pytest.approx(8.5)


def test_runtime_commands_use_the_cuda_wheels_for_this_card(tmp_path: Path) -> None:
    commands = runtime.runtime_commands(hw_for(RTX_5060_TI), "uv")
    assert [label for label, _ in commands] == ["Setting up Python", "Installing PyTorch", "Installing the image libraries"]
    torch_cmd = commands[1][1]
    assert torch_cmd[-2:] == ["--index-url", "https://download.pytorch.org/whl/cu128"]
    mac_torch = runtime.runtime_commands(hardware.summarize([], True, 16.0), "uv")[1][1]
    assert "--index-url" not in mac_torch


# ---------- installing, using and removing ----------

def fake_install(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Make Installer._command pretend: the venv appears, the probe answers, downloads write the listed files."""
    seen: list[str] = []

    def command(self, args, env=None, on_tick=None):  # noqa: ANN001
        seen.append(self.stage)
        if "venv" in args:
            runtime.python_path().parent.mkdir(parents=True, exist_ok=True)
            runtime.python_path().write_text("")
        if args[-1] == "probe":
            return json.dumps({"torch": "2.9.0+cu128", "cuda": True, "kernel_ok": True, "device": "RTX 5060 Ti", "diffusers": "0.35"}) + "\n"
        if "download" in args:
            for repo in json.loads(args[-1])["repos"]:
                for pattern in repo["allow"]:
                    path = Path(repo["dir"]) / pattern.replace("*", "file.json")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("x")
            if on_tick:
                on_tick()
        return ""

    monkeypatch.setattr(runtime.Installer, "_command", command)
    monkeypatch.setattr(runtime, "find_uv", lambda: "uv")
    monkeypatch.setattr(runtime, "disk_free_gb", lambda path=None: 500.0)
    return seen


def wait_install() -> dict:
    import time

    for _ in range(200):
        if not runtime.INSTALLER.running:
            break
        time.sleep(0.02)
    return runtime.INSTALLER.snapshot()


def test_install_sets_up_the_engine_once_and_becomes_the_free_default(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge.asset_studio import list_image_models
    from forge.config import load_config
    from forge.providers.elevenlabs_image import resolve_image_provider

    seen = fake_install(monkeypatch)
    hw = hw_for(RTX_5060_TI)
    assert load_config().demo_mode  # nothing set up yet
    runtime.INSTALLER.start("sdxl-lightning", hw)
    assert wait_install()["status"] == "done"
    assert seen == ["Setting up Python", "Installing PyTorch", "Checking your graphics card", "Installing Image libraries", "Downloading SDXL Lightning"]
    cfg = load_config()
    assert not cfg.demo_mode  # free real images now, not placeholders
    assert cfg.default_image_model == "local:sdxl-lightning"
    first = list_image_models()[0]
    assert (first["id"], first["price"], first["available"], first["label"]) == ("local:sdxl-lightning", 0.0, True, "This PC · SDXL Lightning")
    assert resolve_image_provider("gemini", {}) == "local"
    assert resolve_image_provider("gemini", {"model": "local:sdxl"}) == "local"
    # A second model skips the engine and only downloads.
    seen.clear()
    runtime.INSTALLER.start("sdxl", hw)
    assert wait_install()["status"] == "done" and seen == ["Downloading SDXL"]
    assert set(runtime.installed_ids()) == {"sdxl-lightning", "sdxl"}


def test_removing_a_model_keeps_the_files_another_model_shares(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge.config import load_config

    fake_install(monkeypatch)
    hw = hw_for(RTX_5060_TI)
    for model_id in ("sdxl-lightning", "sdxl"):
        runtime.INSTALLER.start(model_id, hw)
        wait_install()
    base = runtime.repo_dir(catalog.SDXL_BASE)
    runtime.remove("sdxl")
    assert not (base / "unet/diffusion_pytorch_model.fp16.safetensors").exists()  # only SDXL used its UNet
    assert (base / "text_encoder_2/model.fp16.safetensors").exists()  # Lightning still needs these
    assert runtime.installed_ids() == ["sdxl-lightning"]
    runtime.remove("sdxl-lightning")
    assert not base.exists() and runtime.installed_ids() == []
    assert load_config().default_image_model != "local:sdxl-lightning"  # no default pointing at a removed model
    runtime.remove_everything()
    assert not runtime.python_path().exists()


def test_install_refuses_models_too_big_for_the_card_and_full_disks(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_install(monkeypatch)
    with pytest.raises(ValueError, match="won't run"):
        runtime.INSTALLER.start("flux-schnell-q8", hw_for(RTX_5060_TI))
    monkeypatch.setattr(runtime, "disk_free_gb", lambda path=None: 4.0)
    with pytest.raises(ValueError, match="disk space"):
        runtime.INSTALLER.start("sdxl-lightning", hw_for(RTX_5060_TI))
    with pytest.raises(ValueError, match="Unknown"):
        runtime.INSTALLER.start("nope", hw_for(RTX_5060_TI))


def test_a_failed_install_reports_why(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_install(monkeypatch)
    monkeypatch.setattr(runtime.Installer, "_command", lambda self, args, env=None, on_tick=None: (_ for _ in ()).throw(RuntimeError("Installing PyTorch failed: no network")))
    runtime.INSTALLER.start("sdxl-lightning", hw_for(RTX_5060_TI))
    job = wait_install()
    assert job["status"] == "error" and "no network" in job["error"]
    assert runtime.installed_ids() == []


# ---------- generating ----------

def _picture(path: Path, busy: bool = False) -> None:
    img = Image.new("RGB", (256, 256), (250, 250, 248))
    if busy:
        for x in range(256):
            for y in range(0, 256, 2):
                img.putpixel((x, y), (x % 255, y % 255, 90))
    for x in range(80, 176):
        for y in range(60, 200):
            img.putpixel((x, y), (200, 40, 40))
    img.save(path)


def test_cutout_clears_a_plain_background_and_leaves_a_busy_one(tmp_path: Path) -> None:
    plain, busy = tmp_path / "plain.png", tmp_path / "busy.png"
    _picture(plain)
    _picture(busy, busy=True)
    out, removed = remove_plain_background(Image.open(plain))
    assert removed and out.getpixel((5, 5))[3] == 0 and out.getpixel((128, 128))[3] == 255
    out, removed = remove_plain_background(Image.open(busy))
    assert not removed and out.getpixel((5, 5))[3] == 255


async def test_the_local_provider_draws_for_free_and_explains_out_of_memory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from forge.local_ai.engine import ENGINE, LocalEngineError
    from forge.providers.base import ProviderCapability, ProviderError
    from forge.providers.registry import REGISTRY

    adapter = REGISTRY.get("local")
    with pytest.raises(ProviderError, match="isn't installed"):
        await adapter.execute(ProviderCapability.TEXT_TO_IMAGE, "a knight", tmp_path, "x", params={"model": "local:sdxl-lightning"})

    fake_install(monkeypatch)
    monkeypatch.setattr(hardware, "detect", lambda refresh=False: hw_for(RTX_5060_TI))
    runtime.INSTALLER.start("sdxl-lightning", hw_for(RTX_5060_TI))
    wait_install()
    sent: dict = {}

    async def draw(request, progress_cb=None, label=""):  # noqa: ANN001
        sent.update(request)
        _picture(Path(request["out"]))
        return {"ok": True, "seconds": 2.5, "peak_vram_gb": 6.1}

    monkeypatch.setattr(ENGINE, "generate", draw)
    result = await adapter.execute(ProviderCapability.TEXT_TO_IMAGE, "a knight", tmp_path, "knight",
                                   params={"model": "local:sdxl-lightning", "aspect_ratio": "3:4", "transparent": True, "seed": 7})
    assert (result.provider, result.cost_usd, result.seed, result.model) == ("local", 0.0, 7, "local:sdxl-lightning")
    assert (sent["width"], sent["height"], sent["steps"], sent["spec"]["family"], sent["spec"]["offload"]) == (896, 1152, 4, "sdxl", True)
    assert sent["spec"]["unet_file"].endswith("sdxl_lightning_4step_unet.safetensors")
    assert "plain white background" in sent["prompt"] and "init_image" not in sent
    assert result.metadata["background_removed"]
    assert Image.open(tmp_path / "knight.png").getpixel((2, 2))[3] == 0
    assert (tmp_path / "knight_thumb.png").exists()

    source = tmp_path / "source.png"
    _picture(source)
    await adapter.execute(ProviderCapability.IMAGE_EDIT, "same knight, blue", tmp_path, "variant",
                          params={"model": "local:sdxl-lightning", "source_image": str(source), "transparent": False})
    assert sent["init_image"] == str(source)

    async def oom(request, progress_cb=None, label=""):  # noqa: ANN001
        raise LocalEngineError("CUDA out of memory", oom=True)

    monkeypatch.setattr(ENGINE, "generate", oom)
    with pytest.raises(ProviderError) as caught:
        await adapter.execute(ProviderCapability.TEXT_TO_IMAGE, "a knight", tmp_path, "k2", params={"model": "local:sdxl-lightning"})
    assert caught.value.status_code == 507 and "lighter model" in caught.value.how_to_fix


def test_the_this_pc_page_reports_hardware_and_models(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from forge.server.app import app

    monkeypatch.setattr(hardware, "detect", lambda refresh=False: hw_for(RTX_5060_TI))
    fake_install(monkeypatch)
    client = TestClient(app, base_url="http://127.0.0.1:8420")
    info = client.get("/api/local-ai").json()
    assert info["hardware"]["gpu"] == "NVIDIA GeForce RTX 5060 Ti" and info["preset"] == "Light"
    rows = {m["id"]: m for m in info["models"]}
    assert rows["flux-schnell-q4"]["recommended"] and rows["flux-schnell-q4"]["needed_gb"] == pytest.approx(25.0)
    assert rows["sdxl-lightning"]["needed_gb"] == pytest.approx(15.1) and rows["flux-dev-q4"]["personal_only"]
    bad = client.post("/api/local-ai/install", json={"model": "flux-schnell-q8"})
    assert bad.status_code == 400 and "won't run" in bad.json()["detail"]
    ask = client.post("/api/local-ai/install", json={"model": "sdxl-lightning"})  # the page asks before adding PyTorch
    assert ask.status_code == 409 and [d["id"] for d in ask.json()["detail"]["missing"]] == ["pytorch", "image-libs"]
    assert client.post("/api/local-ai/install", json={"model": "sdxl-lightning", "install_deps": True}).status_code == 200
    wait_install()
    assert {m["id"]: m for m in client.get("/api/local-ai").json()["models"]}["sdxl-lightning"]["installed"]
    assert client.post("/api/local-ai/remove", json={"everything": True}).json()["runtime"]["ready"] is False


def test_models_can_live_on_another_drive_and_move_there_later(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake_install(monkeypatch)
    drive = tmp_path / "D_drive"
    drive.mkdir()
    with pytest.raises(ValueError, match="full folder path"):
        runtime.set_folder("relative/path")
    target = runtime.set_folder(str(drive))
    assert target == drive / runtime.FOLDER_NAME and runtime.root() == target  # a subfolder: removal never touches the user's files
    runtime.INSTALLER.start("sdxl-lightning", hw_for(RTX_5060_TI))
    wait_install()
    assert runtime.python_path().is_relative_to(target)
    (runtime.repo_dir(catalog.SDXL_VAE) / "config.json").write_text("{}")
    (target / "runtime" / "pyvenv.cfg").write_text(f"home = {target / 'python' / 'cpython-3.12'}\n")
    (target / "cache" / "uv").mkdir(parents=True, exist_ok=True)
    other = tmp_path / "E_drive"
    (other / runtime.FOLDER_NAME / "models" / "city96--FLUX.1-dev-gguf").mkdir(parents=True)  # models already there stay
    moved_to = runtime.set_folder(str(other))
    assert wait_install()["kind"] == "move" and runtime.INSTALLER.status == "done"
    assert runtime.root() == moved_to == other / runtime.FOLDER_NAME and not target.exists()
    assert runtime.installed_ids() == ["sdxl-lightning"] and runtime.runtime_ready()
    assert (runtime.repo_dir(catalog.SDXL_VAE) / "config.json").is_file() and (moved_to / "models" / "city96--FLUX.1-dev-gguf").is_dir()
    assert str(moved_to / "python") in (moved_to / "runtime" / "pyvenv.cfg").read_text()


def test_the_desktop_app_can_install_the_engine_without_uv_or_a_python(monkeypatch: pytest.MonkeyPatch) -> None:
    # The desktop download is a frozen app: the worker must be a real file in it, and uv comes from Astral's releases.
    build = (Path(__file__).parents[1] / "scripts" / "build_desktop.py").read_text(encoding="utf-8")
    assert "worker_main.py" in build
    url = runtime.uv_download_url()
    assert url.startswith("https://github.com/astral-sh/uv/releases/latest/download/uv-")
    monkeypatch.setattr(runtime.shutil, "which", lambda name: None)
    monkeypatch.setattr(runtime.Path, "home", lambda: Path("/nowhere"))
    monkeypatch.setattr(runtime.sys, "executable", "/nowhere/python")
    assert runtime.find_uv() == ""
    runtime._own_uv().parent.mkdir(parents=True, exist_ok=True)
    runtime._own_uv().write_text("")
    assert runtime.find_uv() == str(runtime._own_uv())


def test_installs_keep_caches_and_temp_files_on_the_chosen_drive_and_stop_when_stuck(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # uv unpacks PyTorch in its cache and Python writes temp files: on a full C: that hung the install forever.
    drive = tmp_path / "D"
    drive.mkdir()
    target = runtime.set_folder(str(drive))
    env = runtime.local_env()
    for name in ("UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "HF_HOME", "TMP", "TEMP"):
        assert Path(env[name]).is_relative_to(target)
    monkeypatch.setattr(runtime, "STALL_SECONDS", 0.5)
    import sys as _sys

    installer = runtime.Installer()
    installer.stage = "Installing PyTorch"
    with pytest.raises(RuntimeError, match="stalled"):
        installer._command([_sys.executable, "-c", "import time; time.sleep(30)"], on_tick=lambda: 0)


def test_local_prompt_keeps_description_and_bible_but_drops_reference_talk():
    from forge.asset_studio import PILLAR_RULE
    from forge.providers.local_image import CUTOUT_HINT, local_prompt

    prompt = ("A tin robot with a wind-up key.\n\nStyle bible:\n- Chunky low-poly game art\n- Matte surfaces, never glossy\n"
              f"- No text, no logo\n- Original design, not based on any game\n\n{PILLAR_RULE}")
    text = local_prompt(prompt, CUTOUT_HINT)
    assert text.startswith("A tin robot with a wind-up key" + CUTOUT_HINT)
    assert "Chunky low-poly game art" in text and "Matte surfaces" in text
    assert "attached" not in text and "text" not in text and "glossy" not in text and "Original design" not in text
    assert local_prompt("Just a sword") == "Just a sword"


def test_worker_splits_long_prompts_into_pieces_sdxl_can_read():
    import importlib.util
    import sys

    from forge.local_ai import runtime

    saved = sys.stdout
    try:  # the worker points stdout at stderr when it loads
        spec = importlib.util.spec_from_file_location("tessera_worker", runtime.WORKER)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
    finally:
        sys.stdout = saved
    assert worker.chunk_tokens([]) == [[]]
    assert [len(p) for p in worker.chunk_tokens(list(range(160)))] == [75, 75, 10]
    assert len(worker.chunk_tokens(list(range(1000)))) == worker.MAX_CHUNKS
    assert worker.chunk_tokens([1, 2], 3) == [[1, 2], [], []]  # the negative prompt matches the prompt's piece count


def test_dependencies_install_and_remove_apart_from_the_models(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from forge.server.app import app

    monkeypatch.setattr(hardware, "detect", lambda refresh=False: hw_for(RTX_5060_TI))
    fake_install(monkeypatch)
    uninstalled: list[list[str]] = []
    monkeypatch.setattr(runtime.subprocess, "run", lambda args, **kw: uninstalled.append(args) or type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})())
    client = TestClient(app, base_url="http://127.0.0.1:8420")
    # PyTorch on its own, then a model only downloads.
    assert client.post("/api/local-ai/install", json={"dep": "pytorch"}).status_code == 200
    wait_install()
    deps = {d["id"]: d for d in client.get("/api/local-ai").json()["deps"]}
    assert deps["pytorch"]["installed"] and not deps["image-libs"]["installed"]
    assert client.post("/api/local-ai/install", json={"model": "sdxl-lightning"}).json()["detail"]["missing"][0]["id"] == "image-libs"
    client.post("/api/local-ai/install", json={"model": "sdxl-lightning", "install_deps": True})
    wait_install()
    # Removing the model keeps PyTorch and the libraries.
    assert client.post("/api/local-ai/remove", json={"model": "sdxl-lightning"}).status_code == 200
    deps = {d["id"]: d for d in client.get("/api/local-ai").json()["deps"]}
    assert deps["pytorch"]["installed"] and deps["image-libs"]["installed"] and deps["pytorch"]["used_by"] == ["Image libraries"]
    # A dependency something still needs asks first; forced, it goes.
    blocked = client.post("/api/local-ai/remove", json={"dep": "pytorch"})
    assert blocked.status_code == 409 and blocked.json()["detail"]["users"] == ["Image libraries"]
    assert client.post("/api/local-ai/remove", json={"dep": "image-libs"}).status_code == 200
    assert uninstalled and "diffusers" in uninstalled[-1] and "pillow" not in uninstalled[-1]
    assert client.post("/api/local-ai/remove", json={"dep": "pytorch"}).status_code == 200
    assert not any(d["installed"] for d in client.get("/api/local-ai").json()["deps"])


async def test_the_cut_out_uses_birefnet_only_when_chosen_and_installed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from forge.local_ai import cutout
    from forge.local_ai.engine import ENGINE

    picture = tmp_path / "p.png"
    _picture(picture)
    assert cutout.cutter_name() == "simple"  # nothing installed
    removed, by = await cutout.cut_out(picture)
    assert by == "plain-background cut"
    monkeypatch.setattr(runtime, "installed_ids", lambda: ["birefnet"])
    monkeypatch.setattr(runtime, "missing_deps", lambda model, state=None: [])
    asked: list = []

    async def fake_cut(image, out, model_dir):  # noqa: ANN001
        asked.append(model_dir)
        Image.open(image).convert("RGBA").save(out)
        return {"ok": True}

    monkeypatch.setattr(ENGINE, "cutout", fake_cut)
    assert cutout.cutter_name() == "birefnet"
    assert (await cutout.cut_out(picture)) == (True, "BiRefNet on this PC") and asked[0].endswith("BiRefNet")
    from forge.config import load_config

    cfg = load_config()
    cfg.cutout_with = "simple"
    assert cutout.cutter_name(cfg) == "simple"
    assert cutout.has_own_cutout("meshy:nano-banana") and cutout.has_own_cutout("svc:higgsfield:x") and not cutout.has_own_cutout("gemini-2.5-flash-image")


def test_local_prompts_drop_negated_text_phrases() -> None:
    from forge.providers.local_image import local_prompt

    assert local_prompt("A rounded card with a glowing cyan edge, empty of text") == "A rounded card with a glowing cyan edge"
    assert local_prompt("A noble knight with no logos, red cape") == "A noble knight, red cape"


def test_memory_status_and_free_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from forge.local_ai.engine import ENGINE
    from forge.server.app import app

    monkeypatch.setattr(hardware, "detect", lambda refresh=False: hw_for(RTX_5060_TI))
    stopped: list[bool] = []
    monkeypatch.setattr(ENGINE, "stop", lambda: stopped.append(True))
    client = TestClient(app, base_url="http://127.0.0.1:8420")
    info = client.get("/api/local-ai").json()
    assert info["engine"] == {"running": False} and "ram_used_gb" in info
    assert client.post("/api/local-ai/free").status_code == 200 and stopped
    reads = client.post("/api/local-ai/prompt-preview", json={"prompt": "A crate\n\nUse the attached reference images for style.", "transparent": True}).json()
    assert "attached" not in reads["prompt"] and reads["prompt"].startswith("A crate")


def test_image_models_list_only_installed_image_makers(monkeypatch: pytest.MonkeyPatch) -> None:
    from forge.asset_studio import list_image_models

    monkeypatch.setattr(runtime, "installed_ids", lambda: ["flux-schnell-q4", "birefnet"])
    local = [m["id"] for m in list_image_models() if m.get("local")]
    assert local == ["local:flux-schnell-q4"]
