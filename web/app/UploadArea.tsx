"use client";

/** Library upload: two drop zones (long-form / ad creative) driving the
 * browser-upload flow — presigned PUTs straight to R2 via the worker,
 * token never in the page — plus URL ingest, the primary path. Below,
 * the live processing queue polled from real video status. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type UpItem = { name: string; stage: string; pct: number | null; error?: string };
type ProcItem = {
  id: string; title: string | null; status: string; status_detail: string | null;
  n_words: string | null;
};

/** Pipeline stages in order — real video statuses set by the worker.
 * The bar fills a stage's worth per step; 'ready' fills it completely. */
const STAGES = ["queued", "transcribing", "detecting", "tagging", "ready"];
const READY_LINGER_MS = 10_000;

export default function UploadArea({ workerUp }: { workerUp: boolean }) {
  const router = useRouter();
  const [uploads, setUploads] = useState<UpItem[]>([]);
  const [processing, setProcessing] = useState<ProcItem[]>([]);
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<"longform" | "ad_creative">("longform");
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Videos this session has watched processing. When one turns ready it
  // stays on screen for a moment — landing visibly with its word count and
  // a link to the transcript — instead of vanishing into the grid.
  const watched = useRef<Set<string>>(new Set());
  const readyUntil = useRef<Map<string, number>>(new Map());
  const [, forceTick] = useState(0);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/videos/status");
      if (!res.ok) return;
      const items: ProcItem[] = (await res.json()).items;
      const now = Date.now();
      for (const v of items) {
        if (v.status !== "ready" && v.status !== "failed") watched.current.add(v.id);
        if (v.status === "ready" && watched.current.has(v.id) && !readyUntil.current.has(v.id)) {
          readyUntil.current.set(v.id, now + READY_LINGER_MS);
          router.refresh(); // the grid below picks the video up
        }
      }
      for (const [id, until] of readyUntil.current) {
        if (until < now) {
          readyUntil.current.delete(id);
          watched.current.delete(id);
        }
      }
      setProcessing(items);
    } catch { /* transient */ }
  }, [router]);
  useEffect(() => {
    void poll();
    const iv = setInterval(() => { void poll(); forceTick((t) => t + 1); }, 3000);
    return () => clearInterval(iv);
  }, [poll]);

  const setItem = (name: string, patch: Partial<UpItem>) =>
    setUploads((u) => u.map((x) => (x.name === name ? { ...x, ...patch } : x)));

  async function dismissFailed(v: ProcItem) {
    if (!window.confirm(
      `Dismiss "${v.title ?? "untitled"}"?\n\nThis removes the failed ingest and its uploaded files. ` +
      "Re-ingest the source to try again.",
    )) return;
    const res = await fetch(`/api/videos/${v.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMsg(body.error ?? res.statusText);
      return;
    }
    void poll();
    router.refresh();
  }

  async function uploadFile(f: File, source: "longform" | "ad_creative") {
    setUploads((u) => [{ name: f.name, stage: "starting", pct: null }, ...u]);
    try {
      const start = await fetch("/api/upload/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: f.name, size: f.size,
          content_type: f.type || "application/octet-stream",
        }),
      });
      if (!start.ok) throw new Error((await start.json()).error ?? start.statusText);
      const s = await start.json();
      const parts: { PartNumber: number; ETag: string }[] = [];
      if (s.mode === "single") {
        setItem(f.name, { stage: "uploading", pct: null });
        const put = await fetch(s.url, {
          method: "PUT", body: f,
          headers: { "Content-Type": f.type || "application/octet-stream" },
        });
        if (!put.ok) throw new Error(`upload failed: ${put.status}`);
      } else {
        for (let i = 0; i < s.urls.length; i++) {
          const chunk = f.slice(i * s.part_size, Math.min((i + 1) * s.part_size, f.size));
          setItem(f.name, {
            stage: `part ${i + 1}/${s.urls.length}`,
            pct: Math.round((i / s.urls.length) * 100),
          });
          const put = await fetch(s.urls[i], { method: "PUT", body: chunk });
          if (!put.ok) throw new Error(`part ${i + 1} failed: ${put.status}`);
          const etag = put.headers.get("ETag");
          if (!etag) throw new Error("no ETag on part — check the R2 CORS rule exposes ETag");
          parts.push({ PartNumber: i + 1, ETag: etag });
        }
      }
      setItem(f.name, { stage: "finalising", pct: 100 });
      const done = await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: s.video_id, r2_key: s.r2_key, mode: s.mode,
          upload_id: s.upload_id ?? null, parts,
          title: f.name.replace(/\.[^.]+$/, ""), source,
        }),
      });
      if (!done.ok) throw new Error((await done.json()).error ?? done.statusText);
      const doneBody = await done.json().catch(() => ({}));
      if (doneBody.video_id) watched.current.add(doneBody.video_id);
      setUploads((u) => u.filter((x) => x.name !== f.name));
      void poll();
      router.refresh();
    } catch (e) {
      setItem(f.name, {
        stage: "failed", pct: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function ingestUrl() {
    if (!/^https?:\/\//.test(url.trim())) {
      setMsg("Source URL must be http(s)");
      return;
    }
    setUrlBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/ingest/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), source: "longform" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      if (body.video_id) watched.current.add(body.video_id);
      setUrl("");
      setMsg("Queued — fetching the source now.");
      void poll();
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setUrlBusy(false);
    }
  }

  const drop = (label: string, source: "longform" | "ad_creative", h3: string, p: string) => (
    <div
      className={`drop${dragOver === label ? " over" : ""}`}
      style={{ flex: 1, minWidth: 250 }}
      onClick={() => {
        sourceRef.current = source;
        fileRef.current?.click();
      }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(label); }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(null);
        const f = e.dataTransfer.files[0];
        if (f) void uploadFile(f, source);
      }}
    >
      <h3>{h3}</h3>
      <p>{p}</p>
      <span className="pill">Choose file</span>
    </div>
  );

  return (
    <>
      <input ref={fileRef} type="file" accept="video/*,audio/*" style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadFile(f, sourceRef.current);
          e.target.value = "";
        }}
      />
      {!workerUp && (
        <div className="note" style={{ marginBottom: 14 }}>
          <strong>Worker not connected.</strong> Set WORKER_URL and
          INGEST_TOKEN so uploads and URL ingest can reach the pipeline.
        </div>
      )}
      <div className="row" style={{ gap: 14, marginBottom: 14, alignItems: "stretch", flexWrap: "wrap" }}>
        {drop("long", "longform", "Upload long-form",
          "Podcast episodes, Instagram Lives. MP4, MOV, up to 8 GB.")}
        {drop("ad", "ad_creative", "Upload ad creative",
          "Creative that never ran on Meta — adds to the learning corpus.")}
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
        <input type="text" placeholder="…or paste a source URL (episode page or direct file)"
          value={url} style={{ flex: 1, minWidth: 260 }}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void ingestUrl(); }}
        />
        <button className="btn" disabled={urlBusy || !url.trim()} onClick={() => void ingestUrl()}>
          {urlBusy ? "Queueing…" : "Queue ingest"}
        </button>
      </div>
      {msg && <p className="hint" style={{ marginTop: -14, marginBottom: 14 }}>{msg}</p>}

      <h2 className="sec">Processing</h2>
      <div className="card" style={{ marginBottom: 26 }}>
        {(() => {
          // ready rows linger only if this session watched them process
          const visible = processing.filter(
            (v) => v.status !== "ready" || readyUntil.current.has(v.id),
          );
          if (uploads.length === 0 && visible.length === 0) {
            return (
              <div className="ingest">
                <span className="nm" style={{ color: "var(--muted)", fontWeight: 400 }}>
                  Nothing processing. Drop a file or paste a URL to start.
                </span>
              </div>
            );
          }
          return (
            <>
              {uploads.map((u) => (
                <div className="ingest" key={`up-${u.name}`}>
                  <span className="nm">{u.name}</span>
                  <span className="stage-lbl">{u.error ? "failed" : `uploading · ${u.stage}`}</span>
                  {u.error ? (
                    <span style={{ fontSize: 10.5, color: "#9A2F53" }}>{u.error}</span>
                  ) : (
                    <span className="prog">
                      <i style={{ width: u.pct !== null ? `${u.pct * 0.2}%` : "8%" }} />
                    </span>
                  )}
                </div>
              ))}
              {visible.map((v) => {
                const stageIdx = Math.max(0, STAGES.indexOf(v.status));
                const ready = v.status === "ready";
                const failed = v.status === "failed";
                const row = (
                  <div className="ingest" key={v.id}
                    style={ready ? { background: "#F4F9F8", cursor: "pointer" } : undefined}>
                    <span className="nm">
                      {v.title ?? "untitled"}
                      {ready && (
                        <span style={{ color: "var(--teal)", fontWeight: 600, marginLeft: 8, fontSize: 11.5 }}>
                          ready · {v.n_words ?? 0} words — open transcript →
                        </span>
                      )}
                    </span>
                    <span className="stage-lbl" style={ready ? { color: "var(--teal)" } : undefined}>
                      {failed ? "failed" : ready ? "ready" : v.status}
                    </span>
                    {failed ? (
                      <>
                        <span className="tag flag" title={v.status_detail ?? undefined}>failed</span>
                        <button className="chip" title="Dismiss — removes this failed ingest and its files"
                          onClick={() => void dismissFailed(v)}>×</button>
                      </>
                    ) : (
                      <span className="prog" title={v.status_detail ?? undefined}>
                        <i style={{
                          width: ready ? "100%" : `${((stageIdx + 0.5) / STAGES.length) * 100}%`,
                        }} />
                      </span>
                    )}
                  </div>
                );
                return ready ? (
                  <a key={v.id} href={`/videos/${v.id}`} style={{ display: "block" }}>{row}</a>
                ) : row;
              })}
            </>
          );
        })()}
      </div>
    </>
  );
}
