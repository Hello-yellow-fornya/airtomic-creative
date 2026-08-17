"""Cloudflare R2 via the S3 API.

storage_uri convention throughout the DB: `r2://{bucket}/{key}` — bucket kept
in the URI so re-pointing environments never re-interprets old rows.

The multipart presign functions here are the upload path for large files: the
server creates the multipart upload and presigns one URL per part, the client
(browser later, scripts/upload_video.py today) PUTs the parts, the server
completes. R2 requires every part except the last to be the same size,
minimum 5 MiB.
"""

from typing import Any

import boto3
from botocore.config import Config as BotoConfig

PART_SIZE = 64 * 1024 * 1024
PRESIGN_EXPIRY_S = 6 * 3600


def client(account_id: str, access_key_id: str, secret_access_key: str):
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=BotoConfig(signature_version="s3v4", region_name="auto"),
    )


def make_uri(bucket: str, key: str) -> str:
    return f"r2://{bucket}/{key}"


def parse_uri(uri: str) -> tuple[str, str]:
    if not uri.startswith("r2://"):
        raise ValueError(f"not an r2 uri: {uri}")
    bucket, _, key = uri.removeprefix("r2://").partition("/")
    if not bucket or not key:
        raise ValueError(f"malformed r2 uri: {uri}")
    return bucket, key


def presign_get(s3, bucket: str, key: str, expires_s: int = PRESIGN_EXPIRY_S) -> str:
    return s3.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_s
    )


def presign_put(s3, bucket: str, key: str, content_type: str,
                expires_s: int = PRESIGN_EXPIRY_S) -> str:
    return s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=expires_s,
    )


def create_multipart(s3, bucket: str, key: str, content_type: str) -> str:
    resp = s3.create_multipart_upload(Bucket=bucket, Key=key, ContentType=content_type)
    return resp["UploadId"]


def presign_part(s3, bucket: str, key: str, upload_id: str, part_number: int,
                 expires_s: int = PRESIGN_EXPIRY_S) -> str:
    return s3.generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": bucket,
            "Key": key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=expires_s,
    )


def complete_multipart(
    s3, bucket: str, key: str, upload_id: str, parts: list[dict[str, Any]]
) -> None:
    """parts: [{"PartNumber": 1, "ETag": "..."}] in part order."""
    s3.complete_multipart_upload(
        Bucket=bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}
    )


def abort_multipart(s3, bucket: str, key: str, upload_id: str) -> None:
    s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)


def download_file(s3, bucket: str, key: str, dest_path: str) -> None:
    s3.download_file(bucket, key, dest_path)


def upload_file(s3, bucket: str, key: str, src_path: str, content_type: str) -> None:
    s3.upload_file(src_path, bucket, key, ExtraArgs={"ContentType": content_type})


def get_bytes(s3, bucket: str, key: str) -> bytes:
    return s3.get_object(Bucket=bucket, Key=key)["Body"].read()


def delete_prefix(s3, bucket: str, prefix: str) -> int:
    """Delete every object under a prefix. Returns the count removed.
    Empty prefix listings are a no-op, so retries are safe."""
    deleted = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
        if not keys:
            continue
        s3.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
        deleted += len(keys)
    return deleted
