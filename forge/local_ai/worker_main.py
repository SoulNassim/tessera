"""Tessera's local generation worker. It runs inside the local AI runtime (its own venv with torch and diffusers).

Never imported by Tessera itself: Tessera starts it as `<runtime python> worker_main.py <command>`.

  probe              print what torch sees (one JSON line)
  download <json>    fetch model files: {"repos": [{"repo": "...", "allow": [...], "dir": "..."}]}
  serve              read one JSON request per line on stdin, answer one JSON line per request on stdout

Only protocol lines go to stdout; everything libraries print goes to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import time

_OUT = sys.stdout
sys.stdout = sys.stderr  # library chatter must not mix with the protocol


def emit(payload: dict) -> None:
    _OUT.write(json.dumps(payload) + "\n")
    _OUT.flush()


def probe() -> None:
    import torch

    info = {"torch": torch.__version__, "cuda": bool(torch.cuda.is_available()), "mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())}
    if info["cuda"]:
        info["device"] = torch.cuda.get_device_name(0)
        info["capability"] = ".".join(map(str, torch.cuda.get_device_capability(0)))
        # A wheel built without this card's architecture only fails on the first real kernel, so run one.
        try:
            (torch.ones(8, device="cuda") * 2).sum().item()
            info["kernel_ok"] = True
        except Exception as err:  # noqa: BLE001
            info["kernel_ok"] = False
            info["error"] = str(err)[:300]
    try:
        import diffusers

        info["diffusers"] = diffusers.__version__
    except Exception as err:  # noqa: BLE001
        info["diffusers_error"] = str(err)[:300]
    emit(info)


def download(spec: dict) -> None:
    from huggingface_hub import snapshot_download

    for item in spec.get("repos", []):
        emit({"event": "repo", "repo": item["repo"]})
        snapshot_download(repo_id=item["repo"], allow_patterns=item.get("allow") or None, local_dir=item["dir"], max_workers=4)
    emit({"ok": True})


STREAM_BLOCKS = int(os.environ.get("TESSERA_STREAM_BLOCKS") or 2)  # FLUX blocks on the card at once when streaming
MAX_CHUNKS = 4  # SDXL's text encoders read 75 tokens at a time; up to 300 tokens of prompt are kept


def chunk_tokens(ids: list[int], chunks: int | None = None) -> list[list[int]]:
    """Split a prompt's tokens into 75-token pieces (at least one, at most MAX_CHUNKS), padded to `chunks` pieces."""
    pieces = [ids[i:i + 75] for i in range(0, len(ids), 75)][:MAX_CHUNKS] or [[]]
    return (pieces + [[]] * (chunks or 0))[:chunks] if chunks else pieces


def sdxl_embeds(pipe, prompt: str, negative: str, use_negative: bool) -> dict:
    """SDXL prompt embeddings without CLIP's 77-token cut: each 75-token piece is encoded on its own and the pieces are
    joined, so the description and the style bible after it both reach the model."""
    import torch

    device = pipe._execution_device
    count = len(chunk_tokens(pipe.tokenizer(prompt, add_special_tokens=False).input_ids))

    def encode(text: str):
        joined, pooled = [], None
        for tok, enc in ((pipe.tokenizer, pipe.text_encoder), (pipe.tokenizer_2, pipe.text_encoder_2)):
            outs = []
            for piece in chunk_tokens(tok(text, add_special_tokens=False).input_ids, count):
                row = [tok.bos_token_id, *piece, tok.eos_token_id]
                row += [tok.pad_token_id] * (tok.model_max_length - len(row))
                out = enc(torch.tensor([row], device=device), output_hidden_states=True)
                outs.append(out.hidden_states[-2])
                if enc is pipe.text_encoder_2 and pooled is None:
                    pooled = out[0]  # the first piece's pooled vector, as SDXL expects
            joined.append(torch.cat(outs, dim=1))
        return torch.cat(joined, dim=-1).to(pipe.unet.dtype), pooled.to(pipe.unet.dtype)

    with torch.no_grad():
        embeds, pooled = encode(prompt)
        args = {"prompt_embeds": embeds, "pooled_prompt_embeds": pooled}
        if use_negative:
            args["negative_prompt_embeds"], args["negative_pooled_prompt_embeds"] = encode(negative)
    return args


class Engine:
    def __init__(self) -> None:
        self.key = ""
        self.pipe = None
        self.encoder = None  # FLUX reads the prompt with its own pipeline, so the image model never shares the card with T5
        self.cutter = None  # BiRefNet, kept loaded beside the image model (under 1 GB)
        self.device = "cpu"

    def cutout(self, req: dict) -> dict:
        """Background removal with BiRefNet: a 1024x1024 mask, scaled back to the picture's size as its alpha."""
        import torch
        from PIL import Image

        started = time.time()
        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        if self.cutter is None:
            from transformers import AutoModelForImageSegmentation

            model = AutoModelForImageSegmentation.from_pretrained(req["dir"], trust_remote_code=True)
            model = model.to(device).eval()
            if device != "cpu":
                model = model.half()
            self.cutter = model
        image = Image.open(req["image"]).convert("RGB")
        small = image.resize((1024, 1024), Image.Resampling.BILINEAR)
        import numpy as np

        x = torch.from_numpy(np.asarray(small, dtype=np.float32)).permute(2, 0, 1) / 255.0
        mean, std = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1), torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
        x = ((x - mean) / std).unsqueeze(0).to(device)
        if device != "cpu":
            x = x.half()
        with torch.no_grad():
            mask = self.cutter(x)[-1].sigmoid()[0, 0].float().cpu()
        alpha = Image.fromarray((mask.clamp(0, 1) * 255).byte().numpy(), mode="L").resize(image.size, Image.Resampling.BILINEAR)
        out = image.convert("RGBA")
        out.putalpha(alpha)
        out.save(req["out"], format="PNG")
        return {"ok": True, "out": req["out"], "seconds": round(time.time() - started, 2)}

    def unload(self) -> None:
        import gc

        import torch

        self.pipe, self.encoder, self.key, self.cutter = None, None, "", None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def load(self, spec: dict):
        import torch

        key = json.dumps(spec, sort_keys=True)
        if self.pipe is not None and key == self.key:
            return self.pipe
        self.unload()
        self.device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        if spec["family"] == "sdxl":
            pipe = self._sdxl(spec, torch)
            if spec.get("offload") and self.device == "cuda":
                pipe.enable_model_cpu_offload()
            else:
                pipe.to(self.device)
        elif spec["family"] == "flux":
            pipe = self._flux(spec, torch)
        else:
            raise ValueError(f"Unknown model family {spec['family']}")
        if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
            pipe.vae.enable_tiling()  # decoding a big image is the usual out-of-memory moment
        pipe.set_progress_bar_config(disable=True)
        self.pipe, self.key = pipe, key
        return pipe

    def _sdxl(self, spec: dict, torch):
        from diffusers import AutoencoderKL, EulerDiscreteScheduler, StableDiffusionXLPipeline, UNet2DConditionModel

        dtype = torch.float16
        parts = {"vae": AutoencoderKL.from_pretrained(spec["vae"], torch_dtype=dtype)}
        if spec.get("unet_file"):
            from accelerate import init_empty_weights
            from safetensors.torch import load_file

            # An empty shell takes the file's fp16 weights as they are: no 10 GB of random fp32 weights first.
            with init_empty_weights():
                unet = UNet2DConditionModel.from_config(UNet2DConditionModel.load_config(spec["base"], subfolder="unet"))
            unet.load_state_dict(load_file(spec["unet_file"]), assign=True)
            parts["unet"] = unet.to(dtype)
        pipe = StableDiffusionXLPipeline.from_pretrained(spec["base"], torch_dtype=dtype, variant="fp16", **parts)
        if spec.get("scheduler") == "euler_trailing":
            pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
        return pipe

    def _flux(self, spec: dict, torch):
        """FLUX from its parts. The text encoders get their own pipeline (T5 alone is 9.5 GB); on a card without room for
        the whole image model its layers stream in from system memory as each is needed. Same maths, same picture."""

        from diffusers import AutoencoderKL, FlowMatchEulerDiscreteScheduler, FluxPipeline, FluxTransformer2DModel, GGUFQuantizationConfig
        from transformers import CLIPTextModel, CLIPTokenizer, T5EncoderModel, T5TokenizerFast

        dtype = torch.bfloat16
        dev = spec.get("guidance_embeds")
        scheduler = FlowMatchEulerDiscreteScheduler(
            shift=3.0 if dev else 1.0, use_dynamic_shifting=bool(dev), base_image_seq_len=256, max_image_seq_len=4096, base_shift=0.5, max_shift=1.15)
        encoder = FluxPipeline(
            scheduler=scheduler, vae=None, transformer=None,
            text_encoder=CLIPTextModel.from_pretrained(spec["clip"], torch_dtype=dtype), tokenizer=CLIPTokenizer.from_pretrained(spec["clip"]),
            text_encoder_2=T5EncoderModel.from_pretrained(spec["t5"], torch_dtype=dtype), tokenizer_2=T5TokenizerFast.from_pretrained(spec["t5"]))
        gpu_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3 if self.device == "cuda" else 0
        if self.device != "cuda":
            encoder.to(self.device)
        elif gpu_gb >= 12:
            encoder.enable_model_cpu_offload()  # T5 fits on the card while it reads, then steps aside
        else:
            encoder.enable_sequential_cpu_offload()
        config = os.path.join(os.path.dirname(spec["gguf_file"]), "tessera-config")
        os.makedirs(os.path.join(config, "transformer"), exist_ok=True)
        with open(os.path.join(config, "transformer", "config.json"), "w", encoding="utf-8") as fh:
            json.dump({"_class_name": "FluxTransformer2DModel", "patch_size": 1, "in_channels": 64, "num_layers": 19, "num_single_layers": 38,
                       "attention_head_dim": 128, "num_attention_heads": 24, "joint_attention_dim": 4096, "pooled_projection_dim": 768,
                       "guidance_embeds": bool(dev), "axes_dims_rope": [16, 56, 56]}, fh)
        transformer = FluxTransformer2DModel.from_single_file(
            spec["gguf_file"], quantization_config=GGUFQuantizationConfig(compute_dtype=dtype), torch_dtype=dtype, config=config, subfolder="transformer")
        pipe = FluxPipeline(scheduler=scheduler, vae=AutoencoderKL.from_pretrained(spec["vae"], torch_dtype=dtype), transformer=transformer,
                            text_encoder=None, tokenizer=None, text_encoder_2=None, tokenizer_2=None)
        if spec.get("offload") and self.device == "cuda":
            transformer.enable_group_offload(onload_device=torch.device("cuda"), offload_device=torch.device("cpu"),
                                             offload_type="block_level", num_blocks_per_group=STREAM_BLOCKS, use_stream=True)
            pipe.vae.to("cuda")
        else:
            pipe.to(self.device)
        encoder.set_progress_bar_config(disable=True)
        self.encoder = encoder
        return pipe

    def generate(self, req: dict) -> dict:
        import torch
        from PIL import Image

        started = time.time()
        pipe = self.load(req["spec"])
        loaded = time.time()
        steps = int(req.get("steps") or 4)
        generator = torch.Generator("cpu").manual_seed(int(req.get("seed") or 0))

        def on_step(_pipe, step, _timestep, kwargs):
            emit({"event": "progress", "step": step + 1, "steps": steps})
            return kwargs

        guidance = float(req.get("guidance") or 0.0)
        args = {"num_inference_steps": steps, "guidance_scale": guidance, "generator": generator, "callback_on_step_end": on_step}
        if req["spec"]["family"] == "sdxl":
            args.update(sdxl_embeds(pipe, req["prompt"], req.get("negative") or "", guidance > 1))
        else:
            with torch.no_grad():
                embeds, pooled, _ = self.encoder.encode_prompt(prompt=req["prompt"], prompt_2=None, max_sequence_length=512)
            args.update(prompt_embeds=embeds.to(self.device), pooled_prompt_embeds=pooled.to(self.device))
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        if req.get("init_image"):
            from diffusers import AutoPipelineForImage2Image

            img2img = AutoPipelineForImage2Image.from_pipe(pipe)
            init = Image.open(req["init_image"]).convert("RGB").resize((int(req["width"]), int(req["height"])))
            strength = float(req.get("strength") or 0.6)
            # Image-to-image runs only the last `strength` share of the steps; keep at least a few of them.
            args["num_inference_steps"] = max(steps, int(round(steps / max(strength, 0.1))))
            steps = int(args["num_inference_steps"] * strength)
            image = img2img(image=init, strength=strength, **args).images[0]
        else:
            image = pipe(width=int(req["width"]), height=int(req["height"]), **args).images[0]
        image.save(req["out"])
        peak = round(torch.cuda.max_memory_allocated() / 1024**3, 2) if torch.cuda.is_available() else 0.0
        return {"ok": True, "out": req["out"], "seconds": round(time.time() - loaded, 2), "load_seconds": round(loaded - started, 2), "peak_vram_gb": peak}


def serve() -> None:
    engine = Engine()
    emit({"event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            emit({"ok": False, "error": "bad request"})
            continue
        cmd = req.get("cmd")
        if cmd == "quit":
            emit({"ok": True})
            return
        if cmd == "ping":
            emit({"ok": True})
            continue
        if cmd == "unload":
            engine.unload()
            emit({"ok": True})
            continue
        try:
            emit(engine.cutout(req) if cmd == "cutout" else engine.generate(req))
        except Exception as err:  # noqa: BLE001
            oom = "out of memory" in str(err).lower() or type(err).__name__ == "OutOfMemoryError"
            try:
                engine.unload() if oom else None
            except Exception:  # noqa: BLE001
                pass
            emit({"ok": False, "oom": oom, "error": f"{type(err).__name__}: {str(err)[:400]}"})


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if command == "probe":
        probe()
    elif command == "download":
        download(json.loads(sys.argv[2]))
    else:
        serve()
