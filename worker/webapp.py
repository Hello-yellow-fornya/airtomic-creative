"""Browser trigger for ingest: one page with a paste-a-URL form, a direct
browser upload (presigned single PUT or multipart for large files), and a
status table of recent videos. Runs on a thread inside the worker process
(main.py), so Railway hosts a single service for both.

Browser upload flow: POST /upload/start returns presigned URLs; the browser
PUTs the file (in 64 MiB parts when large) straight to R2; POST
/upload/complete finishes the multipart, inserts the videos row, and queues
ingest. The R2 bucket needs a CORS rule allowing PUT from this origin with
the ETag header exposed — see README.

GET /kf/<scene_id> 302-redirects to a short-lived presigned URL for that
scene's keyframe — raw footage never sits on public URLs. /media/<video_id>,
/asset/<asset_id> and /export/<variant_id>/<ratio> do the same for source
video, brand assets and rendered exports, so the web app can play real
footage without R2 credentials of its own.

Every request must carry the shared token: open /?key=<INGEST_TOKEN>.
The token gates queueing work and media access. Unset INGEST_TOKEN disables
the server entirely.
"""

import hmac
import html
import json
import logging
import math
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import db, meta, r2
from .config import Config

log = logging.getLogger("worker.web")

PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>airtomic-creative ingest</title>
<style>
  body {{ font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }}
  h1 {{ font-size: 1.2rem; }}
  form {{ display: grid; gap: .6rem; max-width: 34rem; margin-bottom: 2rem; }}
  input, select, button {{ font: inherit; padding: .45rem .6rem; }}
  button {{ cursor: pointer; }}
  table {{ border-collapse: collapse; width: 100%; font-size: .875rem; }}
  th, td {{ text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; vertical-align: top; }}
  .ok {{ color: #0a7a2f; }} .bad {{ color: #b00020; }} .note {{ color: #666; }}
</style>
<h1>airtomic-creative — ingest</h1>
{banner}
<form method="post" action="/ingest">
  <input type="hidden" name="key" value="{key}">
  <label>Source URL (direct file or episode page)
    <input name="url" type="url" required placeholder="https://..." style="width:100%">
  </label>
  <label>Title <input name="title" placeholder="optional" style="width:100%"></label>
  <label>Source type
    <select name="source">
      <option value="longform" selected>longform (podcast, IG Live)</option>
      <option value="ad_creative">ad_creative</option>
    </select>
  </label>
  <button>Queue ingest</button>
</form>

<h1>Upload a file</h1>
<form id="upform" onsubmit="return false" >
  <input type="file" id="upfile" required>
  <label>Title <input id="uptitle" placeholder="optional" style="width:100%"></label>
  <label>Source type
    <select id="upsource">
      <option value="longform" selected>longform (podcast, IG Live)</option>
      <option value="ad_creative">ad_creative</option>
    </select>
  </label>
  <button id="upbtn" onclick="doUpload()">Upload &amp; ingest</button>
  <div id="upstat" class="note"></div>
</form>
<script>
const KEY = new URLSearchParams(location.search).get("key");
async function doUpload() {{
  const f = document.getElementById("upfile").files[0];
  const stat = document.getElementById("upstat");
  const btn = document.getElementById("upbtn");
  if (!f) {{ stat.textContent = "pick a file first"; return; }}
  btn.disabled = true;
  try {{
    stat.textContent = "starting…";
    const start = await fetch("/upload/start", {{ method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ key: KEY, filename: f.name, size: f.size,
                              content_type: f.type || "application/octet-stream" }}) }});
    if (!start.ok) throw new Error((await start.json()).error || start.statusText);
    const s = await start.json();
    let parts = [];
    if (s.mode === "single") {{
      stat.textContent = "uploading…";
      const put = await fetch(s.url, {{ method: "PUT", body: f,
        headers: {{ "Content-Type": f.type || "application/octet-stream" }} }});
      if (!put.ok) throw new Error("upload failed: " + put.status);
    }} else {{
      for (let i = 0; i < s.urls.length; i++) {{
        const chunk = f.slice(i * s.part_size, Math.min((i + 1) * s.part_size, f.size));
        stat.textContent = `uploading part ${{i + 1}}/${{s.urls.length}} `
          + `(${{Math.round(Math.min((i + 1) * s.part_size, f.size) / 1048576)}}`
          + `/${{Math.round(f.size / 1048576)}} MiB)`;
        const put = await fetch(s.urls[i], {{ method: "PUT", body: chunk }});
        if (!put.ok) throw new Error(`part ${{i + 1}} failed: ` + put.status);
        const etag = put.headers.get("ETag");
        if (!etag) throw new Error("no ETag on part response — check the R2 CORS rule exposes ETag");
        parts.push({{ PartNumber: i + 1, ETag: etag }});
      }}
    }}
    stat.textContent = "finalising…";
    const done = await fetch("/upload/complete", {{ method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ key: KEY, video_id: s.video_id, r2_key: s.r2_key,
        mode: s.mode, upload_id: s.upload_id || null, parts: parts,
        title: document.getElementById("uptitle").value || null,
        source: document.getElementById("upsource").value }}) }});
    if (!done.ok) throw new Error((await done.json()).error || done.statusText);
    location.href = "/?key=" + encodeURIComponent(KEY) + "&queued="
      + (await done.json()).video_id;
  }} catch (e) {{
    stat.textContent = "error: " + e.message;
    btn.disabled = false;
  }}
}}
</script>
<h1>Recent videos</h1>
<table>
  <tr><th>Title</th><th>Status</th><th>Detail</th><th>Words</th><th>Queued at (UTC)</th></tr>
  {rows}
</table>
<p class="note">Statuses move queued &rarr; transcribing &rarr; ready. Refresh the page for progress.</p>
"""

ROW = "<tr><td>{title}</td><td class='{cls}'>{status}</td><td>{detail}</td><td>{words}</td><td>{at}</td></tr>"


def make_server(cfg: Config) -> ThreadingHTTPServer:
    assert cfg.ingest_token

    s3 = r2.client(cfg.r2_account_id, cfg.r2_access_key_id, cfg.r2_secret_access_key)

    def authed(supplied: str) -> bool:
        return hmac.compare_digest(supplied, cfg.ingest_token)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # default logs full query string — keep the token out
            log.info("%s %s", self.command, urlparse(self.path).path)

        def _respond(self, code: int, body: str, extra: dict | None = None) -> None:
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _json(self, code: int, obj) -> None:
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            try:
                return json.loads(self.rfile.read(length).decode())
            except Exception:
                return {}

        def do_GET(self):
            url = urlparse(self.path)
            params = parse_qs(url.query)
            key = params.get("key", [""])[0]

            # Keyframe presign redirect: raw footage never sits on public
            # URLs — this 303s to a 1-hour presigned URL, token-gated.
            # scenes.id is a bigserial, not a uuid.
            m = re.fullmatch(r"/kf/(\d+)", url.path)
            if m:
                if not authed(key):
                    self._respond(401, "unauthorised")
                    return
                try:
                    with db.connect(cfg.database_url) as conn:
                        row = conn.execute(
                            "SELECT keyframe_uri FROM scenes WHERE id = %s",
                            (int(m.group(1)),),
                        ).fetchone()
                except Exception:
                    log.exception("keyframe lookup failed")
                    self._respond(500, "db error")
                    return
                if not row or not row["keyframe_uri"]:
                    self._respond(404, "no keyframe")
                    return
                bucket, kf_key = r2.parse_uri(row["keyframe_uri"])
                self._respond(303, "", {
                    "Location": r2.presign_get(s3, bucket, kf_key, expires_s=3600),
                })
                return

            # Source video presign — the builder's <video> element points at
            # the web app's proxy, which 302s here, which 303s to R2.
            # Read-only Meta diagnostics: token scopes, version check,
            # campaigns + ad sets. Proves the credentials end to end
            # without creating anything on the account.
            if url.path == "/meta/diag":
                if not authed(key):
                    self._json(401, {"error": "unauthorised"})
                    return
                # The account id is optional for diagnostics: without it the
                # client lists the ad accounts the token can reach instead
                # of campaigns/ad sets — which reveals the right id.
                missing = [
                    n for n, v in (
                        ("META_APP_ID", cfg.meta_app_id),
                        ("META_APP_SECRET", cfg.meta_app_secret),
                        ("META_SYSTEM_USER_TOKEN", cfg.meta_system_user_token),
                    ) if not v
                ]
                if missing:
                    self._json(409, {"error": "meta not configured",
                                     "missing": missing})
                    return
                client = meta.MetaClient(
                    app_id=cfg.meta_app_id,
                    app_secret=cfg.meta_app_secret,
                    access_token=cfg.meta_system_user_token,
                    ad_account_id=cfg.meta_ad_account_id or "",
                    api_version=cfg.meta_api_version,
                    page_id=cfg.meta_page_id,
                    instagram_actor_id=cfg.meta_instagram_actor_id,
                )
                self._json(200, {
                    "identity": {
                        "page_id_set": bool(cfg.meta_page_id),
                        "instagram_actor_id_set": bool(cfg.meta_instagram_actor_id),
                        "ad_account_id_set": bool(cfg.meta_ad_account_id),
                    },
                    **client.diag(),
                })
                return

            m = re.fullmatch(r"/media/([0-9a-f-]{36})", url.path)
            if m:
                self._presign_lookup(
                    key,
                    "SELECT storage_uri AS uri FROM videos WHERE id = %s",
                    (m.group(1),),
                )
                return

            m = re.fullmatch(r"/asset/([0-9a-f-]{36})", url.path)
            if m:
                self._presign_lookup(
                    key,
                    "SELECT storage_uri AS uri FROM assets WHERE id = %s",
                    (m.group(1),),
                )
                return

            m = re.fullmatch(r"/export/([0-9a-f-]{36})/([0-9a-z.]+)", url.path)
            if m:
                # export_uri on the variant is the LAST render; a specific
                # ratio lives at the conventional key exports/{id}/{ratio}.mp4
                self._presign_key(key, f"exports/{m.group(1)}/{m.group(2)}.mp4")
                return

            if url.path != "/":
                self._respond(404, "not found")
                return
            if not authed(key):
                self._respond(401, "<p>Missing or wrong <code>?key=</code>.</p>")
                return
            try:
                with db.connect(cfg.database_url) as conn:
                    videos = conn.execute(
                        """
                        SELECT v.title, v.status::text, v.status_detail, v.ingested_at,
                               (SELECT count(*) FROM transcript_words w
                                JOIN transcripts t ON t.id = w.transcript_id
                                WHERE t.video_id = v.id) AS words
                        FROM videos v ORDER BY v.ingested_at DESC LIMIT 20
                        """
                    ).fetchall()
            except Exception:
                log.exception("status query failed")
                self._respond(500, "<p>Database error — check worker logs.</p>")
                return

            rows = "".join(
                ROW.format(
                    title=html.escape(v["title"] or "—"),
                    cls={"ready": "ok", "failed": "bad"}.get(v["status"], ""),
                    status=html.escape(v["status"]),
                    detail=html.escape(v["status_detail"] or ""),
                    words=v["words"] or "",
                    at=v["ingested_at"].strftime("%Y-%m-%d %H:%M"),
                )
                for v in videos
            ) or "<tr><td colspan=5 class=note>nothing yet</td></tr>"

            queued = params.get("queued", [""])[0]
            banner = (
                f"<p class=ok>Queued — video {html.escape(queued)}</p>" if queued else ""
            )
            self._respond(200, PAGE.format(key=html.escape(key), banner=banner, rows=rows))

        def _presign_lookup(self, key: str, sql: str, args: tuple) -> None:
            """303 to a presigned URL for a storage_uri looked up by SQL.
            Only r2:// URIs are presignable — a video still at an http(s)
            source URL hasn't been archived yet."""
            if not authed(key):
                self._respond(401, "unauthorised")
                return
            try:
                with db.connect(cfg.database_url) as conn:
                    row = conn.execute(sql, args).fetchone()
            except Exception:
                log.exception("presign lookup failed")
                self._respond(500, "db error")
                return
            if not row or not row["uri"]:
                self._respond(404, "not found")
                return
            if not row["uri"].startswith("r2://"):
                self._respond(409, "not archived to r2 yet")
                return
            bucket, obj_key = r2.parse_uri(row["uri"])
            self._respond(303, "", {
                "Location": r2.presign_get(s3, bucket, obj_key, expires_s=3600),
            })

        def _presign_key(self, key: str, obj_key: str) -> None:
            if not authed(key):
                self._respond(401, "unauthorised")
                return
            self._respond(303, "", {
                "Location": r2.presign_get(s3, cfg.r2_bucket, obj_key, expires_s=3600),
            })

        def do_POST(self):
            path = urlparse(self.path).path
            if path == "/upload/start":
                self._upload_start()
                return
            if path == "/upload/complete":
                self._upload_complete()
                return
            if path != "/ingest":
                self._respond(404, "not found")
                return
            length = int(self.headers.get("Content-Length", 0))
            form = parse_qs(self.rfile.read(length).decode())
            key = form.get("key", [""])[0]
            if not authed(key):
                self._respond(401, "<p>Missing or wrong key.</p>")
                return

            source_url = form.get("url", [""])[0].strip()
            source = form.get("source", ["longform"])[0]
            title = form.get("title", [""])[0].strip() or None
            if not source_url.startswith(("http://", "https://")):
                self._respond(400, "<p>Source URL must be http(s).</p>")
                return
            if source not in ("longform", "ad_creative"):
                self._respond(400, "<p>Bad source type.</p>")
                return

            try:
                with db.connect(cfg.database_url) as conn:
                    video_id, job_id = db.create_video_and_ingest_job(
                        conn,
                        storage_uri=source_url,
                        title=title,
                        source=source,
                        uploaded_by="web",
                    )
            except Exception:
                log.exception("enqueue failed")
                self._respond(500, "<p>Database error — check worker logs.</p>")
                return

            log.info("queued video %s as job %s from web", video_id, job_id)
            self._respond(
                303, "", {"Location": f"/?key={quote(key)}&queued={video_id}"}
            )

        def _upload_start(self):
            body = self._read_json()
            if not authed(str(body.get("key", ""))):
                self._json(401, {"error": "unauthorised"})
                return
            filename = str(body.get("filename", "upload.bin"))
            safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename) or "upload.bin"
            size = int(body.get("size", 0))
            content_type = str(body.get("content_type") or "application/octet-stream")
            if size <= 0:
                self._json(400, {"error": "size required"})
                return

            # target=asset presigns into assets/{id}/ instead — same PUT
            # flow, completion writes an assets row rather than a video.
            video_id = str(uuid.uuid4())
            if body.get("target") == "asset":
                r2_key = f"assets/{video_id}/{safe_name}"
            else:
                r2_key = f"sources/{video_id}/{safe_name}"
            try:
                if size <= r2.PART_SIZE:
                    resp = {
                        "mode": "single", "video_id": video_id, "r2_key": r2_key,
                        "url": r2.presign_put(s3, cfg.r2_bucket, r2_key, content_type),
                    }
                else:
                    upload_id = r2.create_multipart(
                        s3, cfg.r2_bucket, r2_key, content_type
                    )
                    n_parts = math.ceil(size / r2.PART_SIZE)
                    resp = {
                        "mode": "multipart", "video_id": video_id, "r2_key": r2_key,
                        "upload_id": upload_id, "part_size": r2.PART_SIZE,
                        "urls": [
                            r2.presign_part(s3, cfg.r2_bucket, r2_key, upload_id, i + 1)
                            for i in range(n_parts)
                        ],
                    }
            except Exception:
                log.exception("upload start failed")
                self._json(500, {"error": "could not presign upload — check R2 creds"})
                return
            log.info("upload started: %s (%s bytes, %s)", r2_key, size, resp["mode"])
            self._json(200, resp)

        def _upload_complete(self):
            body = self._read_json()
            if not authed(str(body.get("key", ""))):
                self._json(401, {"error": "unauthorised"})
                return
            if body.get("target") == "asset":
                self._asset_complete(body)
                return
            video_id = str(body.get("video_id", ""))
            r2_key = str(body.get("r2_key", ""))
            source = str(body.get("source", "longform"))
            if source not in ("longform", "ad_creative"):
                self._json(400, {"error": "bad source type"})
                return
            if not video_id or not r2_key.startswith(f"sources/{video_id}/"):
                self._json(400, {"error": "bad video_id/r2_key"})
                return

            try:
                if body.get("mode") == "multipart":
                    parts = body.get("parts") or []
                    if not parts:
                        self._json(400, {"error": "multipart complete needs parts"})
                        return
                    r2.complete_multipart(
                        s3, cfg.r2_bucket, r2_key, str(body.get("upload_id")),
                        [{"PartNumber": int(p["PartNumber"]), "ETag": str(p["ETag"])}
                         for p in parts],
                    )
                with db.connect(cfg.database_url) as conn:
                    vid, job_id = db.create_video_and_ingest_job(
                        conn,
                        storage_uri=r2.make_uri(cfg.r2_bucket, r2_key),
                        title=(body.get("title") or None),
                        source=source,
                        uploaded_by="web-upload",
                        video_id=video_id,
                    )
            except Exception as exc:
                log.exception("upload complete failed")
                self._json(500, {"error": str(exc)[:300]})
                return
            log.info("upload complete: video %s queued as job %s", vid, job_id)
            self._json(200, {"video_id": vid, "job_id": job_id})

        def _asset_complete(self, body: dict) -> None:
            """Finish an asset upload: complete multipart if needed, insert
            the assets row. asset_id doubles as the upload's video_id slot."""
            asset_id = str(body.get("video_id", ""))
            r2_key = str(body.get("r2_key", ""))
            kind = str(body.get("kind", "product_still"))
            if kind not in ("product_still", "end_card", "logo", "broll", "other"):
                self._json(400, {"error": "bad asset kind"})
                return
            if not asset_id or not r2_key.startswith(f"assets/{asset_id}/"):
                self._json(400, {"error": "bad asset_id/r2_key"})
                return
            name = str(body.get("name") or r2_key.rsplit("/", 1)[-1])[:120]

            def _num(v, cast):
                try:
                    return cast(v) if v is not None else None
                except (TypeError, ValueError):
                    return None

            try:
                if body.get("mode") == "multipart":
                    parts = body.get("parts") or []
                    if not parts:
                        self._json(400, {"error": "multipart complete needs parts"})
                        return
                    r2.complete_multipart(
                        s3, cfg.r2_bucket, r2_key, str(body.get("upload_id")),
                        [{"PartNumber": int(p["PartNumber"]), "ETag": str(p["ETag"])}
                         for p in parts],
                    )
                with db.connect(cfg.database_url) as conn:
                    db.create_asset(
                        conn,
                        asset_id=asset_id,
                        kind=kind,
                        name=name,
                        storage_uri=r2.make_uri(cfg.r2_bucket, r2_key),
                        width=_num(body.get("width"), int),
                        height=_num(body.get("height"), int),
                        duration_s=_num(body.get("duration_s"), float),
                        uploaded_by="web-upload",
                    )
            except Exception as exc:
                log.exception("asset upload complete failed")
                self._json(500, {"error": str(exc)[:300]})
                return
            log.info("asset upload complete: %s (%s)", asset_id, kind)
            self._json(200, {"asset_id": asset_id})

    return ThreadingHTTPServer(("", cfg.port), Handler)
