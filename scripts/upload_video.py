"""Upload a video to R2 and queue it for ingest.

    python scripts/upload_video.py path/to/podcast.mp4 --title "Ep 12" [--source longform]

Deliberately uploads through presigned URLs (multipart above 64 MiB) rather
than boto3's managed transfer: the PUTs use plain `requests` with no AWS
credentials, exactly what the browser will do later. The presign/complete
calls live in worker/r2.py so the future Next.js API route has a worked
reference for the server side of the flow.
"""

import argparse
import getpass
import mimetypes
import os
import sys
import uuid
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker import config, db, r2  # noqa: E402


def upload_via_presigned(s3, bucket: str, key: str, path: Path, content_type: str) -> None:
    size = path.stat().st_size

    if size <= r2.PART_SIZE:
        url = r2.presign_put(s3, bucket, key, content_type)
        with open(path, "rb") as f:
            resp = requests.put(url, data=f, headers={"Content-Type": content_type})
        resp.raise_for_status()
        return

    upload_id = r2.create_multipart(s3, bucket, key, content_type)
    parts = []
    try:
        with open(path, "rb") as f:
            part_number = 1
            while chunk := f.read(r2.PART_SIZE):
                url = r2.presign_part(s3, bucket, key, upload_id, part_number)
                resp = requests.put(url, data=chunk)
                resp.raise_for_status()
                parts.append({"PartNumber": part_number, "ETag": resp.headers["ETag"]})
                done = min(part_number * r2.PART_SIZE, size)
                print(f"  part {part_number}: {done / (1 << 20):.0f}/{size / (1 << 20):.0f} MiB")
                part_number += 1
        r2.complete_multipart(s3, bucket, key, upload_id, parts)
    except BaseException:
        r2.abort_multipart(s3, bucket, key, upload_id)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("file", type=Path)
    parser.add_argument("--title", help="defaults to the filename")
    parser.add_argument("--source", choices=["longform", "ad_creative"], default="longform")
    parser.add_argument("--by", default=os.environ.get("USER") or getpass.getuser())
    args = parser.parse_args()

    if not args.file.is_file():
        parser.error(f"no such file: {args.file}")

    cfg = config.load()
    s3 = r2.client(cfg.r2_account_id, cfg.r2_access_key_id, cfg.r2_secret_access_key)

    video_id = str(uuid.uuid4())
    key = f"sources/{video_id}/{args.file.name}"
    content_type = mimetypes.guess_type(args.file.name)[0] or "application/octet-stream"

    print(f"uploading {args.file} -> {r2.make_uri(cfg.r2_bucket, key)}")
    upload_via_presigned(s3, cfg.r2_bucket, key, args.file, content_type)

    conn = db.connect(cfg.database_url)
    conn.execute(
        """
        INSERT INTO videos (id, source, title, storage_uri, status, uploaded_by)
        VALUES (%s, %s, %s, %s, 'queued', %s)
        """,
        (video_id, args.source, args.title or args.file.stem,
         r2.make_uri(cfg.r2_bucket, key), args.by),
    )
    job_id = db.enqueue_job(conn, "ingest", {"video_id": video_id})

    print(f"video {video_id} queued as job {job_id}")


if __name__ == "__main__":
    main()
