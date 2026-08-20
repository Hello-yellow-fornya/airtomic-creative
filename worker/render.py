"""Render a clip variant to MP4: ordered scenes -> one ffmpeg filter_complex.

Every input is normalised to the target resolution, fps, SAR, and pixel
format before concat — THE NORMALISE STEP IS NOT OPTIONAL (see CLAUDE.md,
composition model): concat produces garbage when inputs differ, and brand
assets always will. Audio is likewise normalised to 48kHz stereo fltp.

Crops come from scene_crops, keyed (scene_id, ratio) — a 9:16 crop does not
transfer to 1:1, and 1.91:1 crops HEIGHT, not width (it is wider than the
16:9 source). Missing crops fall back to a centred window with the correct
axis for the ratio (cropBox() in docs/prototype.html).

Subtitles are generated AFTER scene order resolves (worker/subtitles.py) and
burned in with the ass filter after concat.

Audio rules: speaker audio wins in splits; assets are always muted. Card
scenes and audio='mute' scenes get silence.
"""

import subprocess
import tempfile
from pathlib import Path
from typing import Any

import psycopg

from . import r2, subtitles
from .config import Config

# Output pixel sizes per output_ratio (docs/prototype.html RATIOS).
RATIOS = {
    "9x16": (1080, 1920),
    "4x5": (1080, 1350),
    "1x1": (1080, 1080),
    "1.91x1": (1200, 628),
}
FPS = 30

AUDIO_NORM = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


class RenderError(Exception):
    pass


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    """The `render` job: render one variant at one ratio, upload the MP4 to
    R2, write export_uri back to the variant. Standalone job type — not part
    of the ingest pipeline chain."""
    variant_id = job["payload"].get("variant_id")
    if not variant_id:
        raise RenderError(f"job {job['id']} has no variant_id in payload")
    ratio = job["payload"].get("ratio", "9x16")

    with tempfile.TemporaryDirectory(prefix="render-") as tmp:
        out_path = render_variant(conn, cfg, s3, variant_id, ratio, tmp)
        key = f"exports/{variant_id}/{ratio}.mp4"
        r2.upload_file(s3, cfg.r2_bucket, key, out_path, "video/mp4")
        # Sidecar SRT from the same remapped words as the burn-in — lets
        # the team drop our transcription into their own edit unstyled.
        srt_path = Path(tmp) / "subs.srt"
        if srt_path.exists():
            r2.upload_file(
                s3, cfg.r2_bucket, f"exports/{variant_id}/{ratio}.srt",
                str(srt_path), "application/x-subrip",
            )

    conn.execute(
        "UPDATE clip_variants SET export_uri = %s WHERE id = %s",
        (r2.make_uri(cfg.r2_bucket, key), variant_id),
    )


def render_variant(conn: psycopg.Connection, cfg: Config, s3, variant_id: str,
                   ratio: str, workdir: str) -> str:
    """Renders the variant at the given ratio; returns the local MP4 path."""
    if ratio not in RATIOS:
        raise RenderError(f"unknown ratio {ratio!r}")
    target_w, target_h = RATIOS[ratio]

    variant = conn.execute(
        "SELECT * FROM clip_variants WHERE id = %s", (variant_id,)
    ).fetchone()
    if variant is None:
        raise RenderError(f"variant {variant_id} not found")
    clip = conn.execute(
        "SELECT * FROM clips WHERE id = %s", (variant["clip_id"],)
    ).fetchone()
    video = conn.execute(
        "SELECT * FROM videos WHERE id = %s", (clip["video_id"],)
    ).fetchone()
    scenes = conn.execute(
        "SELECT * FROM variant_scenes WHERE variant_id = %s ORDER BY idx",
        (variant_id,),
    ).fetchall()
    if not scenes:
        raise RenderError("variant has no scenes")

    crops = {
        row["scene_id"]: row
        for row in conn.execute(
            "SELECT * FROM scene_crops WHERE ratio = %s AND scene_id = ANY(%s)",
            (ratio, [s["id"] for s in scenes]),
        ).fetchall()
    }

    src_bucket, src_key = r2.parse_uri(video["storage_uri"])
    src_path = str(Path(workdir) / Path(src_key).name)
    r2.download_file(s3, src_bucket, src_key, src_path)
    if not video["width"] or not video["height"]:
        raise RenderError("source has no video stream — cannot render")
    src_ar = float(video["width"]) / float(video["height"])

    assets = _load_assets(conn, s3, scenes, workdir)

    # Subtitles — generated only now, after the scene order is final.
    words = conn.execute(
        """
        SELECT w.word, w.start_s, w.end_s FROM transcript_words w
        JOIN transcripts t ON t.id = w.transcript_id
        WHERE t.video_id = %s AND w.start_s IS NOT NULL AND w.end_s IS NOT NULL
        ORDER BY w.idx
        """,
        (clip["video_id"],),
    ).fetchall()
    word_dicts = [
        {"word": w["word"], "start": float(w["start_s"]), "end": float(w["end_s"])}
        for w in words
    ]
    _apply_fixes(word_dicts, clip["subtitle_overrides"] or {})
    out_words = subtitles.output_words(scenes, word_dicts)
    preset = _load_preset(conn, clip)
    ass_path = str(Path(workdir) / "subs.ass")
    Path(ass_path).write_text(
        subtitles.build_ass(out_words, preset, target_w, target_h)
    )
    # Sidecar SRT from the SAME out_words list — same remap, cannot drift.
    wpl = max(1, int((preset or {}).get("wpl", subtitles.DEFAULT_PRESET["wpl"])))
    (Path(workdir) / "subs.srt").write_text(subtitles.build_srt(out_words, wpl))

    out_path = str(Path(workdir) / f"render_{ratio}.mp4")
    cmd = _build_command(
        scenes, crops, assets, src_path, src_ar, target_w, target_h,
        ass_path, out_path,
    )
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RenderError(f"ffmpeg failed: {proc.stderr.strip()[-800:]}")
    return out_path


def _load_assets(conn, s3, scenes, workdir: str) -> dict[str, dict[str, Any]]:
    asset_ids = {
        aid
        for s in scenes
        for aid in (s["slot_a_asset"], s["slot_b_asset"])
        if aid
    }
    assets: dict[str, dict[str, Any]] = {}
    for aid in asset_ids:
        row = conn.execute("SELECT * FROM assets WHERE id = %s", (aid,)).fetchone()
        if row is None:
            raise RenderError(f"asset {aid} not found")
        bucket, key = r2.parse_uri(row["storage_uri"])
        local = str(Path(workdir) / f"asset_{aid}{Path(key).suffix}")
        r2.download_file(s3, bucket, key, local)
        assets[str(aid)] = {**row, "local": local}
    return assets


def _load_preset(conn: psycopg.Connection, clip: dict[str, Any]) -> dict[str, Any]:
    row = None
    if clip["subtitle_preset_id"]:
        row = conn.execute(
            "SELECT config FROM subtitle_presets WHERE id = %s",
            (clip["subtitle_preset_id"],),
        ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT config FROM subtitle_presets WHERE is_default "
            "ORDER BY created_at LIMIT 1"
        ).fetchone()
    preset = dict(row["config"]) if row else {}
    overrides = dict(clip["subtitle_overrides"] or {})
    overrides.pop("fixes", None)  # word corrections, not style — applied to words
    return {**preset, **overrides}


_PUNCT = ".,!?;:\"'"


def _apply_fixes(word_dicts: list[dict[str, Any]], overrides: dict[str, Any]) -> None:
    """Clip-scoped transcript corrections (subtitle_overrides.fixes:
    {"wrong": "right"}). Case-insensitive whole-token match; trailing
    punctuation survives the swap. The source transcript is untouched."""
    fixes = {
        str(k).lower(): str(v)
        for k, v in (overrides.get("fixes") or {}).items()
        if str(v).strip()
    }
    if not fixes:
        return
    for w in word_dicts:
        token = w["word"].strip()
        bare = token.rstrip(_PUNCT)
        rep = fixes.get(bare.lower())
        if rep:
            w["word"] = rep + token[len(bare):]


def default_crop(src_ar: float, window_ar: float) -> dict[str, float]:
    """Centred crop window, normalised 0-1 — cropBox() from the prototype.
    A window narrower than the source crops WIDTH (drags horizontally); a
    window wider than the source (1.91:1 against 16:9) crops HEIGHT and
    drags vertically."""
    if window_ar < src_ar:
        w = window_ar / src_ar
        return {"x": (1 - w) / 2, "y": 0.0, "w": w, "h": 1.0}
    h = src_ar / window_ar
    return {"x": 0.0, "y": (1 - h) / 2, "w": 1.0, "h": h}


def _crop_dict(row) -> dict[str, float] | None:
    if row is None:
        return None
    return {k: float(row[f"crop_{k}"]) for k in ("x", "y", "w", "h")}


def _mirror_crop(crop: dict[str, float]) -> dict[str, float]:
    """Second speaker window in split_speakers: mirror the first horizontally."""
    return {**crop, "x": max(0.0, min(1.0 - crop["w"], 1.0 - crop["w"] - crop["x"]))}


def _crop_chain(crop: dict[str, float], out_w: int, out_h: int) -> str:
    return (
        f"crop=floor(iw*{crop['w']:.5f}/2)*2:floor(ih*{crop['h']:.5f}/2)*2:"
        f"iw*{crop['x']:.5f}:ih*{crop['y']:.5f},"
        f"scale={out_w}:{out_h},fps={FPS},setsar=1,format=yuv420p"
    )


def _cover_chain(out_w: int, out_h: int) -> str:
    """Scale-to-cover + centre-crop, for assets of arbitrary size."""
    return (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
        f"crop={out_w}:{out_h},fps={FPS},setsar=1,format=yuv420p"
    )


def _silence(dur: float, label: str) -> str:
    return f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.3f},{AUDIO_NORM}[{label}]"


def _build_command(
    scenes, crops, assets, src_path: str, src_ar: float,
    target_w: int, target_h: int, ass_path: str, out_path: str,
) -> list[str]:
    # Inputs: [0] source, then one per asset (stills looped to fill duration).
    inputs: list[str] = ["-i", src_path]
    input_index: dict[str, int] = {}
    next_input = 1
    for aid, a in assets.items():
        if a["duration_s"] is None:
            inputs += ["-loop", "1", "-framerate", str(FPS), "-i", a["local"]]
        else:
            inputs += ["-i", a["local"]]
        input_index[aid] = next_input
        next_input += 1

    # The source can only be consumed once per stream — split it as many
    # times as scenes reference it (split_speakers uses two video windows).
    n_video_refs = sum(
        (0 if s["layout"] == "card" else 2 if s["layout"] == "split_speakers" else 1)
        for s in scenes
    )
    n_audio_refs = sum(
        1 for s in scenes if s["layout"] != "card" and s["audio"] != "mute"
    )

    filters: list[str] = []
    if n_video_refs:
        filters.append(
            f"[0:v]split={n_video_refs}"
            + "".join(f"[sv{k}]" for k in range(n_video_refs))
        )
    if n_audio_refs:
        filters.append(
            f"[0:a]asplit={n_audio_refs}"
            + "".join(f"[sa{k}]" for k in range(n_audio_refs))
        )

    sv = iter(range(n_video_refs))
    sa = iter(range(n_audio_refs))
    concat_pads: list[str] = []

    for i, s in enumerate(scenes):
        dur = subtitles.scene_duration(s)
        layout = s["layout"]

        if layout == "card":
            ai = _asset_input(s, assets, input_index, "card")
            filters.append(
                f"[{ai}:v]{_cover_chain(target_w, target_h)},"
                f"trim=0:{dur:.3f},setpts=PTS-STARTPTS[v{i}]"
            )
            filters.append(_silence(dur, f"a{i}"))  # assets are muted
        else:
            s_in, s_out = float(s["source_in_s"]), float(s["source_out_s"])
            crop_row = _crop_dict(crops.get(s["id"]))

            if layout == "full":
                crop = crop_row or default_crop(src_ar, target_w / target_h)
                filters.append(
                    f"[sv{next(sv)}]trim={s_in:.3f}:{s_out:.3f},setpts=PTS-STARTPTS,"
                    f"{_crop_chain(crop, target_w, target_h)}[v{i}]"
                )
            elif layout in ("split_product", "split_speakers"):
                split_ratio = float(s["split_ratio"] or 0.5)
                upper_h = int(round(target_h * split_ratio / 2) * 2)
                lower_h = target_h - upper_h

                crop = crop_row or default_crop(src_ar, target_w / upper_h)
                filters.append(
                    f"[sv{next(sv)}]trim={s_in:.3f}:{s_out:.3f},setpts=PTS-STARTPTS,"
                    f"{_crop_chain(crop, target_w, upper_h)}[v{i}t]"
                )
                if layout == "split_product":
                    ai = _asset_input(s, assets, input_index, "split_product")
                    filters.append(
                        f"[{ai}:v]{_cover_chain(target_w, lower_h)},"
                        f"trim=0:{dur:.3f},setpts=PTS-STARTPTS[v{i}b]"
                    )
                else:
                    mirror = _mirror_crop(
                        crop_row or default_crop(src_ar, target_w / lower_h)
                    )
                    filters.append(
                        f"[sv{next(sv)}]trim={s_in:.3f}:{s_out:.3f},"
                        f"setpts=PTS-STARTPTS,"
                        f"{_crop_chain(mirror, target_w, lower_h)}[v{i}b]"
                    )
                filters.append(f"[v{i}t][v{i}b]vstack=inputs=2[v{i}]")
            else:
                raise RenderError(f"scene {s['idx']}: unknown layout {layout!r}")

            # Speaker audio wins in splits; 'mute' scenes get silence.
            if s["audio"] == "mute":
                filters.append(_silence(dur, f"a{i}"))
            else:
                filters.append(
                    f"[sa{next(sa)}]atrim={s_in:.3f}:{s_out:.3f},"
                    f"asetpts=PTS-STARTPTS,{AUDIO_NORM}[a{i}]"
                )

        concat_pads.append(f"[v{i}][a{i}]")

    filters.append(
        "".join(concat_pads) + f"concat=n={len(scenes)}:v=1:a=1[vc][ac]"
    )
    filters.append(f"[vc]ass={ass_path}[vout]")

    return [
        "ffmpeg", "-y", "-v", "error",
        *inputs,
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[ac]",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        out_path,
    ]


def _asset_input(scene, assets, input_index, layout: str) -> int:
    aid = str(scene["slot_a_asset"] or scene["slot_b_asset"] or "")
    if aid not in assets:
        raise RenderError(f"scene {scene['idx']}: {layout} layout needs an asset")
    return input_index[aid]
