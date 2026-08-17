"use client";

/** Brand asset upload + grid. Same browser→R2 presigned path as video
 * upload (worker presigns with target=asset, token stays server-side);
 * completion writes the assets row, so new assets appear in the builder's
 * strip immediately. Multiple files, kind defaulted from the file, name
 * editable before upload, delete per asset via the worker cleanup job. */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type AssetRow = {
  id: string; name: string; kind: string;
  width: number | null; height: number | null; duration: number | null;
};

const KIND_LABEL: Record<string, string> = {
  product_still: "Product still",
  end_card: "End card",
  logo: "Logo",
  broll: "B-roll",
  other: "Other",
};
const KINDS = Object.keys(KIND_LABEL);

type Staged = {
  file: File;
  name: string;
  kind: string;
  state: "staged" | "uploading" | "failed";
  error?: string;
};

function defaultKind(f: File): string {
  if (f.type.startsWith("video/")) return "broll";
  const n = f.name.toLowerCase();
  if (n.includes("logo") || n.includes("wordmark")) return "logo";
  if (n.includes("card") || n.includes("cta")) return "end_card";
  return "product_still";
}

/** Image dimensions / video duration, read client-side before upload. */
function probeFile(f: File): Promise<{ width?: number; height?: number; duration_s?: number }> {
  return new Promise((res) => {
    const url = URL.createObjectURL(f);
    const done = (v: { width?: number; height?: number; duration_s?: number }) => {
      URL.revokeObjectURL(url);
      res(v);
    };
    if (f.type.startsWith("image/")) {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    } else if (f.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () =>
        done({ width: v.videoWidth, height: v.videoHeight, duration_s: v.duration });
      v.onerror = () => done({});
      v.src = url;
    } else {
      done({});
    }
  });
}

export default function AssetManager({
  assets, workerUp,
}: {
  assets: AssetRow[]; workerUp: boolean;
}) {
  const router = useRouter();
  const [staged, setStaged] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | File[]) {
    const next = [...list]
      .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
      .map((f): Staged => ({
        file: f,
        name: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || f.name,
        kind: defaultKind(f),
        state: "staged",
      }));
    if (next.length) setStaged((s) => [...s, ...next]);
  }

  const patch = (i: number, p: Partial<Staged>) =>
    setStaged((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));

  async function uploadOne(item: Staged, i: number) {
    patch(i, { state: "uploading", error: undefined });
    try {
      const dims = await probeFile(item.file);
      const start = await fetch("/api/upload/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "asset",
          filename: item.file.name,
          size: item.file.size,
          content_type: item.file.type || "application/octet-stream",
        }),
      });
      if (!start.ok) throw new Error((await start.json()).error ?? start.statusText);
      const s = await start.json();
      const parts: { PartNumber: number; ETag: string }[] = [];
      if (s.mode === "single") {
        const put = await fetch(s.url, {
          method: "PUT", body: item.file,
          headers: { "Content-Type": item.file.type || "application/octet-stream" },
        });
        if (!put.ok) throw new Error(`upload failed: ${put.status}`);
      } else {
        for (let p = 0; p < s.urls.length; p++) {
          const chunk = item.file.slice(p * s.part_size, Math.min((p + 1) * s.part_size, item.file.size));
          const put = await fetch(s.urls[p], { method: "PUT", body: chunk });
          if (!put.ok) throw new Error(`part ${p + 1} failed: ${put.status}`);
          const etag = put.headers.get("ETag");
          if (!etag) throw new Error("no ETag — check the R2 CORS rule");
          parts.push({ PartNumber: p + 1, ETag: etag });
        }
      }
      const done = await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "asset",
          video_id: s.video_id, r2_key: s.r2_key, mode: s.mode,
          upload_id: s.upload_id ?? null, parts,
          kind: item.kind, name: item.name, ...dims,
        }),
      });
      if (!done.ok) throw new Error((await done.json()).error ?? done.statusText);
      return true;
    } catch (e) {
      patch(i, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  async function uploadAll() {
    setBusy(true);
    setNote(null);
    let ok = 0;
    for (let i = 0; i < staged.length; i++) {
      if (staged[i].state === "uploading") continue;
      if (await uploadOne(staged[i], i)) ok++;
    }
    setBusy(false);
    setStaged((s) => s.filter((x) => x.state === "failed"));
    if (ok) setNote(`${ok} asset${ok > 1 ? "s" : ""} uploaded — available in the builder now.`);
    router.refresh();
  }

  async function deleteAsset(a: AssetRow) {
    if (!window.confirm(`Delete "${a.name}"? Scenes using it fall back to an empty slot. This is permanent.`)) return;
    const res = await fetch(`/api/assets/${a.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNote(body.error ?? res.statusText);
      return;
    }
    setNote(body.r2_cleanup
      ? "Asset deleted — R2 cleanup queued on the worker."
      : "Asset row deleted. Its file was outside the managed assets/ path, so remove it in the Cloudflare dashboard if needed.");
    router.refresh();
  }

  const grouped = new Map<string, AssetRow[]>();
  for (const a of assets) {
    grouped.set(a.kind, [...(grouped.get(a.kind) ?? []), a]);
  }

  return (
    <div className="stack">
      {!workerUp && (
        <div className="note">
          <strong>Worker not connected.</strong> Set WORKER_URL and INGEST_TOKEN
          to upload assets from here.
        </div>
      )}
      <input ref={fileRef} type="file" multiple accept="image/*,video/*"
        style={{ display: "none" }}
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
      <div
        className={`drop${dragOver ? " over" : ""}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <h3>Upload brand assets</h3>
        <p>Product stills, end cards, logos, b-roll. Square and 4:5 stills drop straight into a split without reframing.</p>
        <span className="pill">Choose files</span>
      </div>

      {staged.length > 0 && (
        <div className="card">
          {staged.map((s, i) => (
            <div className="ingest" key={`${s.file.name}-${i}`}>
              <input type="text" value={s.name} disabled={s.state === "uploading"}
                style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => patch(i, { name: e.target.value })} />
              <select value={s.kind} disabled={s.state === "uploading"}
                onChange={(e) => patch(i, { kind: e.target.value })}>
                {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
              <span className="stage-lbl">
                {s.state === "uploading" ? "uploading" : s.state === "failed" ? "failed" : "ready to upload"}
              </span>
              {s.error && <span style={{ fontSize: 10.5, color: "#9A2F53" }}>{s.error}</span>}
              {s.state !== "uploading" && (
                <button className="chip" title="Remove from list"
                  onClick={() => setStaged((x) => x.filter((_, j) => j !== i))}>×</button>
              )}
            </div>
          ))}
          <div style={{ padding: "10px 12px", display: "flex", justifyContent: "flex-end" }}>
            <button className="btn sm" disabled={busy || !workerUp} onClick={() => void uploadAll()}>
              {busy ? "Uploading…" : `Upload ${staged.length} file${staged.length > 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      )}
      {note && <p className="hint">{note}</p>}

      {assets.length === 0 ? (
        <div className="card qempty">
          No brand assets yet. Upload stills above — they appear in the
          builder&apos;s asset strip and in splits immediately.
        </div>
      ) : (
        [...grouped.entries()].map(([kind, list]) => (
          <div key={kind}>
            <h2 className="sec">{KIND_LABEL[kind] ?? kind}s</h2>
            <div className="assets">
              {list.map((a) => (
                <div key={a.id} className="ass" style={{ position: "relative" }}>
                  <div className="sq" style={workerUp
                    ? { backgroundImage: `url(/api/assets/${a.id}/file)` }
                    : undefined}>
                    {a.width && a.height && <span>{a.width}×{a.height}</span>}
                    {a.duration && <span>{a.duration.toFixed(1)}s</span>}
                  </div>
                  <div className="nm">{a.name}</div>
                  <div className="kd" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    {KIND_LABEL[a.kind] ?? a.kind}
                    <button className="chip" title="Delete asset"
                      onClick={() => void deleteAsset(a)}>×</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="note">
        A vertical split makes each half 1080×960. Anything square or 4:5 fits
        without cropping — anything wider gets centre-cropped on render, so
        check the framing before it ships.
      </div>
    </div>
  );
}
