"""The `ingest` job: source video → R2 → transcript rows in Postgres.

The video row's storage_uri is either r2:// (uploaded directly) or http(s)://
(URL ingest — the primary path). URL sources are fetched with yt-dlp, which
handles both direct media files and podcast/video page URLs, then archived to
R2 first — Meta and most hosts serve short-lived URLs, so we never depend on
the source URL again (see CLAUDE.md known traps). storage_uri is rewritten to
the R2 copy at that point, which also makes a retried job skip the re-fetch.

Then: probe metadata, extract 16kHz mono WAV, park the WAV in R2, hand Modal
a presigned URL, and write transcripts / transcript_segments /
transcript_words in one transaction.

Idempotent: a re-run replaces the video's transcripts rather than appending,
so a retried or double-claimed job can't leave duplicates.
"""

import logging
import mimetypes
import tempfile
from pathlib import Path
from typing import Any

import psycopg

from . import db, media, modal_client, pipeline, r2
from .config import Config


log = logging.getLogger("worker.ingest")


class IngestError(Exception):
    pass


def _sha256(path: str) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def handle(conn: psycopg.Connection, cfg: Config, s3, job: dict[str, Any]) -> None:
    video_id = job["payload"].get("video_id")
    if not video_id:
        raise IngestError(f"job {job['id']} has no video_id in payload")

    video = conn.execute(
        "SELECT * FROM videos WHERE id = %s", (video_id,)
    ).fetchone()
    if video is None:
        raise IngestError(f"video {video_id} not found")

    with tempfile.TemporaryDirectory(prefix="ingest-") as tmp:
        wav_path = str(Path(tmp) / "audio.wav")
        storage_uri = video["storage_uri"]

        if storage_uri.startswith(("http://", "https://")):
            db.set_video_status(conn, video_id, "transcribing", "fetching source from url")
            src_path = _fetch_source(storage_uri, tmp)
            key = f"sources/{video_id}/{Path(src_path).name}"
            content_type = (
                mimetypes.guess_type(src_path)[0] or "application/octet-stream"
            )
            db.set_video_status(conn, video_id, "transcribing", "archiving source to r2")
            r2.upload_file(s3, cfg.r2_bucket, key, src_path, content_type)
            conn.execute(
                "UPDATE videos SET storage_uri = %s WHERE id = %s",
                (r2.make_uri(cfg.r2_bucket, key), video_id),
            )
        else:
            db.set_video_status(conn, video_id, "transcribing", "downloading source")
            bucket, key = r2.parse_uri(storage_uri)
            src_path = str(Path(tmp) / Path(key).name)
            r2.download_file(s3, bucket, key, src_path)

        content_hash = _sha256(src_path)
        conn.execute(
            "UPDATE videos SET content_hash = %s WHERE id = %s",
            (content_hash, video_id),
        )

        meta = media.probe(src_path)
        conn.execute(
            """
            UPDATE videos
            SET duration_s = %s, width = %s, height = %s, fps = %s, has_audio = %s
            WHERE id = %s
            """,
            (meta["duration_s"], meta["width"], meta["height"], meta["fps"],
             meta["has_audio"], video_id),
        )
        if not meta["has_audio"]:
            # Silent sources (static-style ad videos) still carry visual
            # signal: skip transcription and continue to scene detection and
            # tagging, so their visual tags count in the corpus. No
            # transcript rows are written — downstream already treats a
            # missing transcript honestly (tag sends "(no transcript)",
            # recommend has nothing to score, subtitle burns are empty).
            log.info("video %s has no audio stream — skipping transcription, "
                     "continuing to scene detection", video_id)
            db.set_video_status(conn, video_id, "transcribing",
                                "no audio — visual-only pipeline")
            pipeline.advance(conn, video_id, "ingest")
            return

        db.set_video_status(conn, video_id, "transcribing", "extracting audio")
        media.extract_wav(src_path, wav_path)

        wav_key = f"audio/{video_id}.wav"
        r2.upload_file(s3, cfg.r2_bucket, wav_key, wav_path, "audio/wav")

    audio_url = r2.presign_get(s3, cfg.r2_bucket, wav_key)

    db.set_video_status(conn, video_id, "transcribing", "waiting on whisperx")
    result = modal_client.transcribe(
        cfg.modal_transcribe_url, cfg.modal_token, audio_url, diarise=cfg.diarise
    )
    if result.get("diarisation_error"):
        log.warning(
            "video %s: diarisation degraded, transcript has no speaker labels: %s",
            video_id, result["diarisation_error"],
        )

    _write_transcript(conn, video_id, result)

    pipeline.advance(conn, video_id, "ingest")


def _fetch_source(url: str, dest_dir: str) -> str:
    """Download a remote source with yt-dlp — handles direct .mp4/.mp3 links
    and podcast/video page URLs alike. Returns the local file path."""
    import yt_dlp

    opts = {
        "outtmpl": str(Path(dest_dir) / "source.%(ext)s"),
        "format": "bv*+ba/b",          # best video+audio, else best single file
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        raise IngestError(f"could not fetch source url: {exc}") from exc

    files = sorted(Path(dest_dir).glob("source.*"))
    if not files:
        raise IngestError("fetch produced no file")
    return str(files[0])


def _write_transcript(
    conn: psycopg.Connection, video_id: str, result: dict[str, Any]
) -> None:
    """Words are rows, not JSON (see CLAUDE.md) — ~13k for a 90-minute
    podcast, so segments and words go in via COPY, all in one transaction."""
    segments = result["segments"]

    with conn.transaction():
        # Replace, don't append — cascades to segments and words.
        conn.execute("DELETE FROM transcripts WHERE video_id = %s", (video_id,))

        transcript_id = conn.execute(
            """
            INSERT INTO transcripts (video_id, engine, model, language, diarised)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (video_id, result.get("engine", "whisperx"),
             result.get("model", "large-v3"), result.get("language"),
             result.get("diarised", True)),
        ).fetchone()["id"]

        with conn.cursor() as cur:
            with cur.copy(
                "COPY transcript_segments (transcript_id, idx, start_s, end_s, speaker, text) FROM STDIN"
            ) as copy:
                for idx, seg in enumerate(segments):
                    copy.write_row((
                        transcript_id, idx,
                        _num(seg.get("start")), _num(seg.get("end")),
                        seg.get("speaker"), seg.get("text", ""),
                    ))

            cur.execute(
                "SELECT id, idx FROM transcript_segments WHERE transcript_id = %s",
                (transcript_id,),
            )
            segment_id_by_idx = {row["idx"]: row["id"] for row in cur.fetchall()}

            word_idx = 0
            with cur.copy(
                "COPY transcript_words (transcript_id, segment_id, idx, word, start_s, end_s, speaker, confidence) FROM STDIN"
            ) as copy:
                for seg_idx, seg in enumerate(segments):
                    for w in seg.get("words", []):
                        copy.write_row((
                            transcript_id, segment_id_by_idx[seg_idx], word_idx,
                            w.get("word", ""),
                            _num(w.get("start")), _num(w.get("end")),
                            w.get("speaker"), _num(w.get("score")),
                        ))
                        word_idx += 1


def _num(value: Any) -> float | None:
    return round(float(value), 4) if value is not None else None
