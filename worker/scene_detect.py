"""The `scene_detect` job: PySceneDetect over the source video, one keyframe
per scene extracted with ffmpeg and stored in R2, scene rows in Postgres.

A source with no detected cuts (single-take podcast) gets one scene spanning
the whole video. Audio-only sources (podcast MP3s) get the same single scene
with no keyframe — the tag stage then works from the transcript alone.

Idempotent: a re-run replaces the video's scenes.
"""

import subprocess
import tempfile
from pathlib import Path
from typing import Any

import psycopg

from . import db, pipeline, r2
from .config import Config

KEYFRAME_WIDTH = 640


class SceneDetectError(Exception):
    pass


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    video_id = job["payload"].get("video_id")
    if not video_id:
        raise SceneDetectError(f"job {job['id']} has no video_id in payload")

    video = conn.execute("SELECT * FROM videos WHERE id = %s", (video_id,)).fetchone()
    if video is None:
        raise SceneDetectError(f"video {video_id} not found")

    duration = float(video["duration_s"] or 0)
    db.set_video_status(conn, video_id, "detecting", "detecting scenes")

    if not video["width"]:
        # Audio-only source: one full-length scene, nothing to keyframe.
        _write_scenes(conn, video_id, [(0.0, duration)], [None])
        pipeline.advance(conn, video_id, "scene_detect")
        return

    bucket, key = r2.parse_uri(video["storage_uri"])
    with tempfile.TemporaryDirectory(prefix="scenes-") as tmp:
        src_path = str(Path(tmp) / Path(key).name)
        r2.download_file(s3, bucket, key, src_path)

        spans = _detect_scenes(src_path, duration)

        db.set_video_status(
            conn, video_id, "detecting", f"extracting {len(spans)} keyframes"
        )
        keyframe_uris = []
        for idx, (start, end) in enumerate(spans):
            jpg_path = str(Path(tmp) / f"{idx:04d}.jpg")
            _extract_keyframe(src_path, (start + end) / 2, jpg_path)
            kf_key = f"keyframes/{video_id}/{idx:04d}.jpg"
            r2.upload_file(s3, cfg.r2_bucket, kf_key, jpg_path, "image/jpeg")
            keyframe_uris.append(r2.make_uri(cfg.r2_bucket, kf_key))

    _write_scenes(conn, video_id, spans, keyframe_uris)
    pipeline.advance(conn, video_id, "scene_detect")


def _detect_scenes(path: str, duration: float) -> list[tuple[float, float]]:
    from scenedetect import ContentDetector, detect

    scene_list = detect(path, ContentDetector())
    spans = [(start.get_seconds(), end.get_seconds()) for start, end in scene_list]
    if not spans:
        # No cuts found — a single-take video is one scene, not zero.
        spans = [(0.0, duration)]
    return spans


def _extract_keyframe(src_path: str, at_s: float, dest_path: str) -> None:
    proc = subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-ss", f"{at_s:.3f}", "-i", src_path,
            "-frames:v", "1", "-vf", f"scale={KEYFRAME_WIDTH}:-2", "-q:v", "3",
            dest_path,
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not Path(dest_path).is_file():
        raise SceneDetectError(
            f"keyframe extraction at {at_s:.3f}s failed: {proc.stderr.strip()[:300]}"
        )


def _write_scenes(
    conn: psycopg.Connection,
    video_id: str,
    spans: list[tuple[float, float]],
    keyframe_uris: list[str | None],
) -> None:
    with conn.transaction():
        conn.execute("DELETE FROM scenes WHERE video_id = %s", (video_id,))
        with conn.cursor() as cur:
            with cur.copy(
                "COPY scenes (video_id, idx, start_s, end_s, keyframe_uri) FROM STDIN"
            ) as copy:
                for idx, ((start, end), uri) in enumerate(zip(spans, keyframe_uris)):
                    copy.write_row((video_id, idx, round(start, 3), round(end, 3), uri))
