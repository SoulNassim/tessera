"""The local models Tessera can install, and which of them suit this computer.

Every model here may be used for commercial games (its license is shown next to it), except ones marked
`personal_only`: those are never recommended and install only after the user accepts their license. Sizes are what gets
downloaded.
Several models share files (both SDXL models use the same text encoders), so the files are listed per repository and
a shared repository is downloaded once.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SDXL_BASE = "stabilityai/stable-diffusion-xl-base-1.0"
SDXL_VAE = "madebyollin/sdxl-vae-fp16-fix"  # the SDXL VAE patched so fp16 doesn't turn images black (MIT)
# FLUX comes from open copies: Black Forest Labs' own repositories need a signed-in Hugging Face account. The parts are
# the same Apache-2.0 / MIT files; the worker writes the few lines of model config itself.
FLUX_GGUF = "city96/FLUX.1-schnell-gguf"
FLUX_DEV_GGUF = "city96/FLUX.1-dev-gguf"
FLUX_CLIP = "openai/clip-vit-large-patch14"
FLUX_T5 = "city96/t5-v1_1-xxl-encoder-bf16"
FLUX_VAE = "diffusers/FLUX.1-vae"

# Everything SDXL needs apart from its UNet weights, in fp16.
_SDXL_PARTS = (
    "model_index.json", "scheduler/*", "tokenizer/*", "tokenizer_2/*",
    "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
    "text_encoder_2/config.json", "text_encoder_2/model.fp16.safetensors",
    "unet/config.json", "vae/config.json",
)
# Shared by every FLUX model: 10.7 GB of text encoders and VAE.
_FLUX_PARTS = {
    FLUX_CLIP: ("config.json", "model.safetensors", "merges.txt", "vocab.json", "tokenizer*.json", "special_tokens_map.json"),
    FLUX_T5: ("config.json", "model.safetensors", "spiece.model", "tokenizer_config.json", "special_tokens_map.json"),
    FLUX_VAE: ("config.json", "diffusion_pytorch_model.safetensors"),
}


@dataclass(frozen=True)
class Dependency:
    """Something models need besides their own files, installed once and shared: removing a model keeps it."""
    id: str
    label: str
    blurb: str
    size_gb: float
    needs: tuple[str, ...] = ()  # installed first
    packages: tuple[str, ...] = ()  # pip packages (PyTorch's come from runtime.torch_command)
    from_torch_index: tuple[str, ...] = ()  # packages that must match PyTorch's CUDA build


DEPS: tuple[Dependency, ...] = (
    Dependency("pytorch", "PyTorch", "Runs AI models on your graphics card. Brings its own Python, so nothing on your system changes.", 7.2),
    Dependency("image-libs", "Image libraries", "Diffusers and Transformers, which every image model here is built on.", 0.8, ("pytorch",),
               ("diffusers>=0.32", "transformers>=4.46", "accelerate>=1.0", "safetensors>=0.4", "huggingface_hub>=0.26",
                "gguf>=0.10", "sentencepiece>=0.2", "protobuf>=4", "pillow>=10")),
    Dependency("cutout-libs", "Cut-out add-ons", "torchvision, timm, kornia and einops, which BiRefNet needs.", 0.3, ("image-libs",),
               ("timm>=1.0", "kornia>=0.7", "einops>=0.8"), ("torchvision",)),
)
DEP_BY_ID = {d.id: d for d in DEPS}
KINDS = (("image", "Images"), ("cutout", "Cut out"))


@dataclass(frozen=True)
class LocalModel:
    id: str
    label: str
    blurb: str
    family: str  # how the worker loads it: "sdxl" or "flux"
    files: dict[str, tuple[str, ...]]  # repository -> file patterns
    size_gb: float
    min_gb: float  # smallest video memory it runs in (with parts parked in system memory)
    good_gb: float  # video memory where it runs well; the recommendation needs this much
    tier: int  # higher is better quality; the best tier that runs well is recommended
    steps: int
    guidance: float
    speed: str
    license: str
    license_url: str
    backends: tuple[str, ...] = ("cuda", "mps")
    unet_file: str = ""  # SDXL with a replacement UNet (Lightning)
    gguf_file: str = ""  # FLUX with a quantized transformer
    scheduler: str = ""
    negative: bool = True  # whether a negative prompt does anything
    kind: str = "image"
    min_ram_gb: float = 0  # system memory it needs (FLUX keeps its text encoder and streamed layers there)
    resident_gb: float = 0  # video memory to keep it all on the card; below this it is streamed (0: good_gb + 2)
    personal_only: bool = False  # license forbids commercial use of the model: opt-in, never recommended
    deps: tuple[str, ...] = ("pytorch", "image-libs")  # DEPS ids, in install order
    extra: dict[str, Any] = field(default_factory=dict)

    def offload(self, usable_gb: float) -> bool:
        """Park parts of the model in system memory between steps when the card is short of room."""
        return usable_gb < (self.resident_gb or self.good_gb + 2)


MODELS: tuple[LocalModel, ...] = (
    LocalModel(
        id="sdxl-lightning", label="SDXL Lightning", blurb="Fast, clean game art in 4 steps. The best start on most cards.",
        family="sdxl", files={SDXL_BASE: _SDXL_PARTS, SDXL_VAE: ("config.json", "diffusion_pytorch_model.safetensors"),
                               "ByteDance/SDXL-Lightning": ("sdxl_lightning_4step_unet.safetensors",)},
        size_gb=7.1, min_gb=6, good_gb=8, tier=2, steps=4, guidance=0.0, speed="about 3 seconds an image on an 8 GB card",
        license="CreativeML Open RAIL++-M · commercial use allowed", license_url="https://huggingface.co/ByteDance/SDXL-Lightning",
        unet_file="ByteDance/SDXL-Lightning/sdxl_lightning_4step_unet.safetensors", scheduler="euler_trailing", negative=False,
    ),
    LocalModel(
        id="sdxl", label="SDXL", blurb="The classic. Slower than Lightning, follows negative prompts and long prompts a little better.",
        family="sdxl", files={SDXL_BASE: (*_SDXL_PARTS, "unet/diffusion_pytorch_model.fp16.safetensors"),
                               SDXL_VAE: ("config.json", "diffusion_pytorch_model.safetensors")},
        size_gb=7.1, min_gb=6, good_gb=8, tier=1, steps=28, guidance=6.0, speed="about 15 seconds an image on an 8 GB card",
        license="CreativeML Open RAIL++-M · commercial use allowed", license_url="https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
    ),
    LocalModel(
        id="flux-schnell-q4", label="FLUX.1 schnell", blurb="Much better at following a description, with clean shapes that suit image-to-3D. Compressed to run on 8 GB cards.",
        family="flux", files={**_FLUX_PARTS, FLUX_GGUF: ("flux1-schnell-Q4_K_S.gguf",)},
        size_gb=17.0, min_gb=6, good_gb=8, min_ram_gb=24, resident_gb=10, tier=3, steps=4, guidance=0.0,
        speed="about 17 seconds an image on an 8 GB card", license="Apache 2.0 · commercial use allowed",
        license_url="https://huggingface.co/city96/FLUX.1-schnell-gguf", backends=("cuda",),
        gguf_file=f"{FLUX_GGUF}/flux1-schnell-Q4_K_S.gguf", negative=False,
    ),
    LocalModel(
        id="flux-schnell-q8", label="FLUX.1 schnell · full detail", blurb="FLUX schnell with less compression: finer detail, more memory.",
        family="flux", files={**_FLUX_PARTS, FLUX_GGUF: ("flux1-schnell-Q8_0.gguf",)},
        size_gb=22.5, min_gb=12, good_gb=16, min_ram_gb=32, resident_gb=16, tier=4, steps=4, guidance=0.0,
        speed="about 6 seconds an image on a 16 GB card", license="Apache 2.0 · commercial use allowed",
        license_url="https://huggingface.co/city96/FLUX.1-schnell-gguf", backends=("cuda",),
        gguf_file=f"{FLUX_GGUF}/flux1-schnell-Q8_0.gguf", negative=False,
    ),
    LocalModel(
        id="flux-dev-q4", label="FLUX.1 dev", blurb="More character and polish than schnell, but takes 24 steps instead of 4. Personal use only.",
        family="flux", files={**_FLUX_PARTS, FLUX_DEV_GGUF: ("flux1-dev-Q4_K_S.gguf", "LICENSE.md")},
        size_gb=17.0, min_gb=6, good_gb=8, min_ram_gb=24, resident_gb=10, tier=0, steps=24, guidance=3.5,
        speed="about 95 seconds an image on an 8 GB card",
        license="FLUX.1 [dev] Non-Commercial License · images may be used commercially, the model only non-commercially",
        license_url="https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md", backends=("cuda",),
        gguf_file=f"{FLUX_DEV_GGUF}/flux1-dev-Q4_K_S.gguf", negative=False, personal_only=True,
        extra={"guidance_embeds": True},
    ),
    LocalModel(
        id="birefnet", label="BiRefNet", blurb="A proper AI cut-out: hair, holes and soft edges come out clean. The same model ElevenLabs uses.",
        family="birefnet", kind="cutout", files={"ZhengPeng7/BiRefNet": ("config.json", "birefnet.py", "BiRefNet_config.py", "model.safetensors")},
        size_gb=0.45, min_gb=2, good_gb=4, tier=1, steps=0, guidance=0.0, speed="about 1 second an image",
        license="MIT · commercial use allowed", license_url="https://huggingface.co/ZhengPeng7/BiRefNet",
        deps=("pytorch", "image-libs", "cutout-libs"),
    ),
)
BY_ID = {m.id: m for m in MODELS}


def get(model_id: str) -> LocalModel | None:
    return BY_ID.get(str(model_id or "").removeprefix("local:"))


def fit(model: LocalModel, hw: dict[str, Any]) -> str:
    """"good", "slow" (runs, but parts wait in system memory), "too_big", "low_ram" or "unsupported"."""
    if hw.get("backend") not in model.backends:
        return "unsupported"
    usable = float(hw.get("usable_gb") or 0)
    if usable < model.min_gb:
        return "too_big"
    if model.min_ram_gb and float(hw.get("ram_gb") or 0) and float(hw["ram_gb"]) < model.min_ram_gb - 1:
        return "low_ram"  # reported RAM runs a little under the stick size (32 GB shows as 31.9)
    return "good" if usable >= model.good_gb else "slow"


def recommended(hw: dict[str, Any], kind: str = "image") -> str:
    """The best model of a kind that runs well here, else the lightest one that runs at all, else ""."""
    choices = [m for m in MODELS if not m.personal_only and m.kind == kind]
    good = [m for m in choices if fit(m, hw) == "good"]
    if good:
        return max(good, key=lambda m: m.tier).id
    runs = [m for m in choices if fit(m, hw) == "slow"]
    return min(runs, key=lambda m: m.min_gb).id if runs else ""


def preset_name(hw: dict[str, Any]) -> str:
    usable = float(hw.get("usable_gb") or 0)
    if hw.get("backend") == "none" or usable < 6:
        return ""
    return "High" if usable >= 16 else "Balanced" if usable >= 12 else "Light"


def describe(model: LocalModel, hw: dict[str, Any]) -> dict[str, Any]:
    return {"id": model.id, "model_id": f"local:{model.id}", "label": model.label, "blurb": model.blurb, "size_gb": model.size_gb,
            "min_gb": model.min_gb, "good_gb": model.good_gb, "speed": model.speed, "license": model.license,
            "license_url": model.license_url, "fit": fit(model, hw), "kind": model.kind, "min_ram_gb": model.min_ram_gb,
            "personal_only": model.personal_only, "deps": list(model.deps)}
