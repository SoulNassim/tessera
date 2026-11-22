"""Images made on the user's own GPU with a model installed in Settings → This PC (forge/local_ai). Free."""

from __future__ import annotations

import random
import re
from pathlib import Path
from typing import Any

from PIL import Image

from forge.providers.base import CostEstimate, ProgressCallback, ProviderAdapter, ProviderCapability, ProviderError, ProviderResult

# About one megapixel in each shape, in multiples of 64 as SDXL and FLUX like them.
SIZES = {"1:1": (1024, 1024), "3:4": (896, 1152), "4:3": (1152, 896), "2:3": (832, 1216), "3:2": (1216, 832),
         "9:16": (768, 1344), "16:9": (1344, 768), "4:5": (896, 1088), "5:4": (1088, 896), "21:9": (1536, 640)}
CUTOUT_HINT = ", single subject centered, full figure in frame, isolated on a plain white background, no shadow"
NEGATIVE = "blurry, lowres, jpeg artifacts, watermark, text, signature, extra limbs, deformed, cropped"
CUTOUT_NEGATIVE = ", busy background, scenery, floor, frame, border"


def local_prompt(prompt: str, hint: str = "") -> str:
    """Tessera's prompt reshaped for a local model, which reads keywords rather than instructions.

    Paragraphs about attached images go (a local model gets no references), the style bible's bullets become one
    comma list after the description, and bullets that only say what not to do go too: "No text" reads as "text".
    """
    keep, style = [], []
    for para in str(prompt or "").replace("\r", "").split("\n\n"):
        para = para.strip()
        if not para or "attached image" in para.lower() or "attached reference" in para.lower():
            continue
        if para.startswith("Style bible:") or (style and para.lstrip().startswith("-")):
            for line in para.removeprefix("Style bible:").splitlines():
                line = re.split(r",\s*(?:never|no|not)\b", line.strip().lstrip("-•* ").strip().rstrip("."), flags=re.I)[0]
                if line and not re.match(r"(no|not|never|original design|don't|do not)\b", line, re.I):
                    style.append(line)
            continue
        keep.append(" ".join(para.split()))
    # Negated phrases in the description itself ("empty of text", "without a logo") name the very thing to avoid.
    subject = re.sub(r",?\s*\b(?:empty of|without(?: any)?|free of|(?:with )?no)\s+(?:any\s+)?(?:text|words|letters|logos?|watermarks?|labels?)\b", "",
                     " ".join(keep), flags=re.I).rstrip(" .,")
    return ", ".join(part for part in (subject + hint, *style) if part)


def size_for(aspect: str) -> tuple[int, int]:
    return SIZES.get(str(aspect or "1:1"), SIZES["1:1"])


class LocalImageAdapter(ProviderAdapter):
    provider_id = "local"
    display_name = "This PC"
    capabilities = [ProviderCapability.TEXT_TO_IMAGE, ProviderCapability.IMAGE_EDIT]

    def parameter_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {"model": {"type": "string", "description": "local:<model id>"}}}

    def estimate_cost(self, capability: ProviderCapability, params: dict[str, Any]) -> CostEstimate:
        return CostEstimate(provider=self.provider_id, model=str(params.get("model") or "local"), estimated_usd=0.0,
                            unit_description="free, runs on this PC")

    async def execute(
        self,
        capability: ProviderCapability,
        prompt: str,
        output_dir: Path,
        filename_stem: str,
        reference_files: list[Path] | None = None,
        params: dict[str, Any] | None = None,
        progress_cb: ProgressCallback | None = None,
    ) -> ProviderResult:
        from forge.local_ai import catalog, hardware, runtime
        from forge.local_ai.cutout import cut_out
        from forge.local_ai.engine import ENGINE, LocalEngineError

        params = params or {}
        model = catalog.get(str(params.get("model") or ""))
        if model is None:
            raise ProviderError(f"Unknown local model '{params.get('model')}'.", provider=self.provider_id, status_code=400,
                                how_to_fix="Pick a model installed in Settings → This PC.")
        if model.id not in runtime.installed_ids():
            raise ProviderError(f"{model.label} isn't installed on this PC.", provider=self.provider_id, status_code=400,
                                how_to_fix="Install it in Settings → This PC, or pick another model.")
        missing = runtime.missing_deps(model)
        if missing:
            names = ", ".join(catalog.DEP_BY_ID[d].label for d in missing)
            raise ProviderError(f"{model.label} needs {names}, which isn't installed.", provider=self.provider_id, status_code=400,
                                how_to_fix=f"Install {names} under Dependencies in Settings → This PC.")
        transparent = bool(params.get("remove_background", params.get("transparent", True)))
        width, height = size_for(str(params.get("aspect_ratio") or "1:1"))
        seed = int(params.get("seed") or random.randint(1, 2**31 - 1))
        text = local_prompt(prompt, CUTOUT_HINT if transparent else "")
        negative = NEGATIVE + (CUTOUT_NEGATIVE if transparent else "")
        # A variant or edit starts from its source picture; style references alone don't (they would copy the subject).
        source_path = Path(str(params.get("source_image") or "")) if params.get("source_image") else None
        source = source_path if source_path and source_path.is_file() else None
        hw = hardware.detect()
        request = {"spec": {**runtime.model_paths(model), "offload": model.offload(float(hw.get("usable_gb") or 0))},
                   "prompt": text, "negative": negative, "width": width, "height": height, "seed": seed,
                   "steps": model.steps, "guidance": model.guidance}
        out_file = output_dir / f"{filename_stem}.png"
        out_file.parent.mkdir(parents=True, exist_ok=True)
        request["out"] = str(out_file)
        if source is not None:
            request["init_image"], request["strength"] = str(source), float(params.get("strength") or 0.65)
        try:
            result = await ENGINE.generate(request, progress_cb, label=model.label)
        except LocalEngineError as err:
            raise ProviderError(
                "Your graphics card ran out of memory." if err.oom else str(err), provider=self.provider_id, status_code=507 if err.oom else 500,
                how_to_fix=("Close other programs that use the GPU (games, other AI apps), or install a lighter model in Settings → This PC."
                            if err.oom else "Try again. If it keeps failing, reinstall the model in Settings → This PC."),
            ) from err
        removed, cutter = False, ""
        if transparent:
            removed, cutter = await cut_out(out_file)
        img = Image.open(out_file)
        thumb_path = out_file.with_name(f"{out_file.stem}_thumb.png")
        thumb = img.convert("RGBA").copy()
        thumb.thumbnail((256, 256), Image.Resampling.LANCZOS)
        thumb.save(thumb_path, format="PNG")
        return ProviderResult(
            provider=self.provider_id,
            model=f"local:{model.id}",
            file_path=f"assets/{out_file.name}",
            thumbnail_path=f"assets/{thumb_path.name}",
            cost_usd=0.0,
            cost_estimated=False,
            seed=seed,
            metadata={"width": width, "height": height, "aspect_ratio": params.get("aspect_ratio") or "1:1", "seconds": result.get("seconds"),
                      "peak_vram_gb": result.get("peak_vram_gb"), "background_removed": removed, "cut_out_by": cutter if removed else "",
                      "local_model": model.label},
        )
