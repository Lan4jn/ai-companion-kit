# -*- coding: utf-8 -*-
"""离线角色素材准备与去白/底板清理管线 (Prepare Room Character Assets)."""
import argparse
import datetime
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image, ImageFilter, ImageMath

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("prepare_room_character")

UNBLEND_MIN_ALPHA = 21
UNBLEND_MAX_ALPHA = 250

CLIP_MAPPINGS = {
    "idle": {"file": "idle/待机呼吸休闲.webm", "loop": True},
    "move": {"file": "move/漂浮踏步.webm", "loop": True},
    "sleep": {"file": "random/原地小憩沉眠.webm", "loop": True},
    "work": {"file": "random/写代码.webm", "loop": True},
    "think": {"file": "random/工作状态-思考冒泡.webm", "loop": True},
    "greet": {"file": "click/点击回应-元气挥手.webm", "loop": False},
}


def get_ffmpeg_version() -> str:
    try:
        res = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            errors="replace",
        )
        if res.returncode == 0:
            first_line = res.stdout.splitlines()[0]
            return first_line.strip()
    except Exception:
        pass
    return "ffmpeg (system default)"


def floor_faint_alpha(im: Image.Image) -> Image.Image:
    """清理 a <= 1 的抠图底板残留像素为完全透明 (0, 0, 0, 0)."""
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    r, g, b, a = im.split()
    mask = a.point(lambda v: 0 if v <= 1 else 255)
    clean_a = a.point(lambda v: 0 if v <= 1 else v)
    black = Image.new("RGB", im.size, (0, 0, 0))
    clean_rgb = Image.composite(im.convert("RGB"), black, mask)
    return Image.merge("RGBA", (*clean_rgb.split(), clean_a))


def unblend_rgba(im: Image.Image) -> Image.Image:
    """白底反解：rec = clip((stored - 255 * (1 - a)) / a, 0, 255)."""
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    red, green, blue, alpha = im.split()
    size = im.size
    alpha_i = alpha.convert("I")
    level = Image.new("I", size, 255)

    white = ImageMath.lambda_eval(
        lambda d: d["level"] - d["alpha"], level=level, alpha=alpha_i
    )
    denom = ImageMath.lambda_eval(
        lambda d: d["max"](d["alpha"], d["one"]),
        alpha=alpha_i,
        one=Image.new("I", size, 1),
    )
    fixed = [
        ImageMath.lambda_eval(
            lambda d: (d["c"] - d["w"]) * d["level"] / d["d"],
            c=band.convert("I"),
            w=white,
            level=level,
            d=denom,
        ).convert("L")
        for band in (red, green, blue)
    ]
    mask = alpha.point(
        lambda v: 255 if UNBLEND_MIN_ALPHA <= v < UNBLEND_MAX_ALPHA else 0
    )
    clean_rgb = Image.composite(Image.merge("RGB", fixed), im.convert("RGB"), mask)
    return Image.merge("RGBA", (*clean_rgb.split(), alpha))


def erode_alpha(im: Image.Image, px: int = 1) -> Image.Image:
    """对 alpha 通道做最小值滤波微缩，消除外圈杂色毛刺. px 对应核半径，默认 px=1 对应 3x3 核."""
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    if px <= 0:
        return im
    r, g, b, a = im.split()
    kernel_size = 2 * px + 1
    eroded_a = a.filter(ImageFilter.MinFilter(kernel_size))
    return Image.merge("RGBA", (r, g, b, eroded_a))


def process_frame(im: Image.Image) -> Image.Image:
    """组合流水线：白底反解 -> 边缘微缩 -> 底板清理."""
    step1 = unblend_rgba(im)
    step2 = erode_alpha(step1, px=1)
    step3 = floor_faint_alpha(step2)
    return step3


def sha256_file(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def should_reuse_clip(
    clip_id: str,
    dest_webm: Path,
    dest_poster: Path,
    cached_meta: dict | None,
    actual_src_hash: str | None,
    force: bool = False,
) -> tuple[bool, str]:
    """严谨判定某个 clip 是否可以安全复用已有的衍生文件。
    返回: (can_reuse: bool, reason: str)
    """
    if force:
        return False, "force_requested"
    if not dest_webm.exists() or not dest_poster.exists():
        return False, "derivative_files_missing"
    if dest_webm.stat().st_size <= 1024 or dest_poster.stat().st_size <= 512:
        return False, "derivative_files_too_small"
    if not cached_meta:
        return False, "cached_meta_missing"

    cached_src_hash = cached_meta.get("source_sha256")
    if not cached_src_hash:
        return False, "cached_source_hash_missing"

    if actual_src_hash is not None:
        if cached_src_hash != actual_src_hash:
            return False, f"source_hash_changed (cached={cached_src_hash[:8]}, actual={actual_src_hash[:8]})"

    return True, "cache_valid"


def process_single_clip(
    clip_id: str,
    source_webm: Path,
    output_clips_dir: Path,
) -> dict:
    logger.info("Processing clip [%s] from %s ...", clip_id, source_webm.name)
    src_hash = sha256_file(source_webm)

    dest_webm = output_clips_dir / f"{clip_id}.webm"
    dest_poster = output_clips_dir / f"{clip_id}.webp"

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        raw_frames_dir = tmp_path / "raw"
        clean_frames_dir = tmp_path / "clean"
        raw_frames_dir.mkdir(parents=True, exist_ok=True)
        clean_frames_dir.mkdir(parents=True, exist_ok=True)

        # 1. 拆帧：强制 libvpx-vp9 解码与 bgra 像素格式以确保 alpha 完整保留
        cmd_extract = [
            "ffmpeg", "-y", "-nostdin",
            "-c:v", "libvpx-vp9",
            "-i", str(source_webm),
            "-pix_fmt", "bgra",
            str(raw_frames_dir / "f_%04d.png"),
        ]
        res = subprocess.run(
            cmd_extract, capture_output=True, text=True, errors="replace"
        )
        if res.returncode != 0:
            raise RuntimeError(f"ffmpeg extraction failed: {res.stderr}")

        frame_files = sorted(raw_frames_dir.glob("f_*.png"))
        if not frame_files:
            raise RuntimeError(f"No frames extracted for {source_webm}")

        total_frames = len(frame_files)
        logger.info(
            "  Extracted %d frames. Applying unblend and alpha floor cleaning...",
            total_frames,
        )

        # 2. 逐帧处理
        for f in frame_files:
            with Image.open(f) as im:
                cleaned = process_frame(im)
                cleaned.save(clean_frames_dir / f.name, format="PNG")

        # 3. 提取中段海报 (N // 2)
        mid_idx = total_frames // 2
        mid_frame_path = clean_frames_dir / frame_files[mid_idx].name
        with Image.open(mid_frame_path) as im:
            im.save(dest_poster, format="WEBP", lossless=True)
        logger.info("  Poster exported to %s", dest_poster.name)

        # 4. 重新压制无白边透明 VP9 WebM
        cmd_encode = [
            "ffmpeg", "-y", "-nostdin",
            "-framerate", "24",
            "-i", str(clean_frames_dir / "f_%04d.png"),
            "-c:v", "libvpx-vp9",
            "-pix_fmt", "yuva420p",
            "-b:v", "0",
            "-crf", "26",
            str(dest_webm),
        ]
        res = subprocess.run(
            cmd_encode, capture_output=True, text=True, errors="replace"
        )
        if res.returncode != 0:
            raise RuntimeError(f"ffmpeg encoding failed: {res.stderr}")

    out_hash = sha256_file(dest_webm)
    poster_hash = sha256_file(dest_poster)
    webm_size_kb = dest_webm.stat().st_size / 1024
    logger.info(
        "  Finished [%s]: size=%.1f KB, webm_sha256=%s",
        clip_id,
        webm_size_kb,
        out_hash[:12],
    )

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {
        "clip_id": clip_id,
        "src_file": str(source_webm.name),
        "source_sha256": src_hash,
        "derived_webm_sha256": out_hash,
        "derived_poster_sha256": poster_hash,
        "frames": total_frames,
        "size_kb": round(webm_size_kb, 1),
        "encoded_at": now_iso,
    }


def write_notice(output_dir: Path) -> None:
    notice_text = """# Third-Party Character Asset Attribution & License Notice

## 角色动画素材来源与授权声明

本项目虚拟居室使用的角色动画切片素材（`shenshen` / 溟月）派生自开源社区项目：

- **源项目 / Source Repository**: [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- **原始作品 / Character OC**: 角色 OC「溟月」出自画师 **上善无形**，素材由社区成员整理制作。
- **授权协议 / License**: **CC BY-NC-SA 类条款（署名-非商业性使用-相同方式共享）**
- **依据与范围说明**:
  依据本地 `THIRD_PARTY_NOTICES`，同人素材按 CC BY-NC-SA 类条款发布（不指定具体版本）：
  1. **仅限个人非商业使用**：本项目仅供学习、交流与个人研究使用，禁止用于任何商业或盈利场景；
  2. **保留署名与来源**：再分发或二次创作须完整保留原画师「上善无形」及源项目社区署名；
  3. **非 MIT 许可资产**：本项目代码采用开源协议，但本目录下的角色素材**绝非 MIT 许可**，不得将该同人角色资产作为宽松商业开源资产分发。
"""
    notice_path = output_dir / "NOTICE.md"
    notice_path.write_text(notice_text, encoding="utf-8")
    logger.info("NOTICE.md written to %s", notice_path)


def write_manifest(
    output_dir: Path,
    processed_meta: list[dict],
    all_reused: bool = False,
    existing_provenance: dict | None = None,
) -> None:
    clips_manifest = {}
    for meta in processed_meta:
        cid = meta["clip_id"]
        cfg = CLIP_MAPPINGS[cid]
        clips_manifest[cid] = {
            "src": f"clips/{cid}.webm",
            "poster": f"clips/{cid}.webp",
            "loop": cfg["loop"],
        }

    now_date = datetime.date.today().isoformat()
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

    if all_reused and existing_provenance:
        prov = dict(existing_provenance)
        prov["manifest_refreshed_at"] = now_iso
        prov["clips_meta"] = processed_meta
    else:
        prov = {
            "encoder": "unblend-white-floor-v1",
            "date": now_date,
            "manifest_refreshed_at": now_iso,
            "parameters": {
                "min_alpha": UNBLEND_MIN_ALPHA,
                "max_alpha": UNBLEND_MAX_ALPHA,
                "floor_alpha": 1,
                "erosion_kernel": 3,
                "erosion_px": 1,
                "crf": 26,
                "fps": 24,
            },
            "tools": {
                "python": sys.version.split()[0],
                "pillow": getattr(Image, "__version__", "unknown"),
                "ffmpeg": get_ffmpeg_version(),
            },
            "clips_meta": processed_meta,
        }

    manifest_obj = {
        "schema": 1,
        "id": "shenshen",
        "canvas": [640, 360],
        "bodyBox": [212, 60, 428, 330],
        "anchor": [320, 330],
        "clips": clips_manifest,
        "attribution": {
            "character": "溟月 (深深)",
            "artist": "上善无形",
            "origin": "PC2005-cloud/dsh-pet",
            "notice": "同人素材遵循 CC BY-NC-SA 类条款，仅限个人非商业使用，保留署名与来源，禁止商用（依据本地 THIRD_PARTY_NOTICES，不指定具体版本）",
        },
        "_provenance": prov,
    }

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest_obj, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info("manifest.json written to %s", manifest_path)


def main():
    default_output = (
        Path(__file__).resolve().parent.parent
        / "packages"
        / "companion"
        / "public"
        / "room_assets"
        / "character"
    )

    parser = argparse.ArgumentParser(
        description="Prepare room character clips with unblend & alpha floor cleaning"
    )
    parser.add_argument(
        "--source",
        type=str,
        required=False,
        default=None,
        help="Source directory containing character webm assets (e.g. path/to/dsh-pet-indesktop/assets/characters/shenshen/videos)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=str(default_output),
        help="Target output directory for character manifest and clips (default: derived from repository root)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-encoding even if destination clips already exist",
    )
    parser.add_argument(
        "--meta-only",
        action="store_true",
        help="Only refresh manifest.json and NOTICE.md without touching media clips (fails if clips missing)",
    )
    args = parser.parse_args()

    output_dir = Path(args.output).resolve()
    clips_output_dir = output_dir / "clips"
    clips_output_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = output_dir / "manifest.json"
    existing_meta_by_id = {}
    existing_prov = None
    if manifest_path.exists():
        try:
            old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            existing_prov = old_manifest.get("_provenance")
            for m in old_manifest.get("_provenance", {}).get("clips_meta", []):
                existing_meta_by_id[m.get("clip_id")] = m
        except Exception:
            pass

    source_dir = Path(args.source).resolve() if args.source else None
    if source_dir and not source_dir.exists():
        raise FileNotFoundError(f"Source directory not found: {source_dir}")

    # 1. 严格模式：--meta-only 模式快速处理
    if args.meta_only:
        logger.info("=== Meta-Only Mode ===")
        processed_meta = []
        for clip_id, mapping in CLIP_MAPPINGS.items():
            dest_webm = clips_output_dir / f"{clip_id}.webm"
            dest_poster = clips_output_dir / f"{clip_id}.webp"
            if not dest_webm.exists() or not dest_poster.exists():
                raise FileNotFoundError(
                    f"--meta-only failed: missing derivative file for clip '{clip_id}'"
                )
            cached = existing_meta_by_id.get(clip_id)
            if not cached or not cached.get("source_sha256"):
                raise ValueError(
                    f"--meta-only failed: no provenance source metadata found for '{clip_id}'. Run with --source first."
                )

            processed_meta.append({
                "clip_id": clip_id,
                "src_file": cached.get("src_file", mapping["file"]),
                "source_sha256": cached["source_sha256"],
                "derived_webm_sha256": sha256_file(dest_webm),
                "derived_poster_sha256": sha256_file(dest_poster),
                "frames": cached.get("frames", 241),
                "size_kb": round(dest_webm.stat().st_size / 1024, 1),
                "encoded_at": cached.get("encoded_at", "2026-11-04"),
            })
        write_notice(output_dir)
        write_manifest(
            output_dir, processed_meta, all_reused=True, existing_provenance=existing_prov
        )
        logger.info("Meta-only refresh complete.")
        return

    logger.info("=== Starting Room Character Preparation ===")
    logger.info("Output: %s", output_dir)
    if source_dir:
        logger.info("Source: %s", source_dir)

    processed_meta = []
    total_size_kb = 0
    all_reused = True

    for clip_id, mapping in CLIP_MAPPINGS.items():
        dest_webm = clips_output_dir / f"{clip_id}.webm"
        dest_poster = clips_output_dir / f"{clip_id}.webp"

        cached = existing_meta_by_id.get(clip_id)
        src_file = None
        actual_src_hash = None

        if source_dir:
            cand = source_dir / mapping["file"]
            if cand.exists():
                src_file = cand
                actual_src_hash = sha256_file(src_file)

        can_reuse, reason = should_reuse_clip(
            clip_id=clip_id,
            dest_webm=dest_webm,
            dest_poster=dest_poster,
            cached_meta=cached,
            actual_src_hash=actual_src_hash,
            force=args.force,
        )

        if can_reuse:
            logger.info("Reusing existing encoded clip [%s] (reason: %s)", clip_id, reason)
            meta = {
                "clip_id": clip_id,
                "src_file": cached.get("src_file", mapping["file"]),
                "source_sha256": cached["source_sha256"],
                "derived_webm_sha256": sha256_file(dest_webm),
                "derived_poster_sha256": sha256_file(dest_poster),
                "frames": cached["frames"],
                "size_kb": round(dest_webm.stat().st_size / 1024, 1),
                "encoded_at": cached.get("encoded_at", "2026-11-04"),
            }
            processed_meta.append(meta)
            total_size_kb += meta["size_kb"]
            continue

        # 无法复用，必须重新编码
        all_reused = False
        logger.info("Cannot reuse [%s]: %s. Triggering re-encode...", clip_id, reason)
        if not src_file or not src_file.exists():
            raise FileNotFoundError(
                f"Source clip for '{clip_id}' needed ({reason}) but --source not provided or file missing at '{src_file}'"
            )

        meta = process_single_clip(clip_id, src_file, clips_output_dir)
        processed_meta.append(meta)
        total_size_kb += meta["size_kb"]

    write_notice(output_dir)
    write_manifest(
        output_dir,
        processed_meta,
        all_reused=all_reused,
        existing_provenance=existing_prov,
    )

    logger.info("=== Finished ===")
    logger.info(
        "Total WebM size for 6 actions: %.1f KB (≈ %.2f MB)",
        total_size_kb,
        total_size_kb / 1024,
    )


if __name__ == "__main__":
    main()
