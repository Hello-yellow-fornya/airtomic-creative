"""Browser trigger for ingest: one page with a paste-a-URL form and a status
table of recent videos. Runs on a thread inside the worker process (main.py),
so Railway hosts a single service for both.

Every request must carry the shared token: open /?key=<INGEST_TOKEN>.
The token gates queueing work (each ingest costs a fetch + GPU time), not any
sensitive data. Unset INGEST_TOKEN disables the server entirely.
"""

import hmac
import html
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import db
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
    <input name="url" type="url" required placeholder="https://..." style="width:100%%">
  </label>
  <label>Title <input name="title" placeholder="optional" style="width:100%%"></label>
  <label>Source type
    <select name="source">
      <option value="longform" selected>longform (podcast, IG Live)</option>
      <option value="ad_creative">ad_creative</option>
    </select>
  </label>
  <button>Queue ingest</button>
</form>
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

        def do_GET(self):
            url = urlparse(self.path)
            if url.path != "/":
                self._respond(404, "not found")
                return
            params = parse_qs(url.query)
            key = params.get("key", [""])[0]
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

        def do_POST(self):
            if urlparse(self.path).path != "/ingest":
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

    return ThreadingHTTPServer(("", cfg.port), Handler)
