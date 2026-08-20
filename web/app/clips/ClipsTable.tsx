"use client";

/** Clips list: click any row to open the clip in a side drawer (no
 * navigation) — proxy player looping the clip's range, source range,
 * variant, approval state, overlays, and Edit / Approve / Render / Export
 * actions. Arrow keys move between rows while the drawer is open.
 *
 * Bulk delete keeps the review-queue selection pattern, now via the
 * checkbox only (the row body opens the drawer). Clips with a sent
 * variant can't be selected. Rows carry a first-frame thumbnail (the
 * detected scene at the clip's start) so the list scans without opening
 * anything. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { exportFilename } from "@/lib/adname";

type Row = {
  clipId: string; clipName: string | null;
  videoId: string; videoTitle: string | null; videoSource: string;
  inS: number; outS: number;
  variantId: string; label: string; variantName: string; slug: string;
  status: string; renderStale: boolean;
  renderStatus: string | null; renderError: string | null;
  ratios: string[]; kfScene: string | null; nOverlays: number;
};

const RATIOS: Record<string, { label: string; px: string; ar: number }> = {
  "9x16": { label: "9:16", px: "1080×1920", ar: 9 / 16 },
  "4x5": { label: "4:5", px: "1080×1350", ar: 4 / 5 },
  "1x1": { label: "1:1", px: "1080×1080", ar: 1 },
  "1.91x1": { label: "1.91:1", px: "1200×628", ar: 1.91 },
};
const ratioOrder = (r: string) => Object.keys(RATIOS).indexOf(r);

function renderTag(status: string) {
  if (status === "done") return "tag ok";
  if (status === "failed") return "tag flag";
  return "tag";
}

/** "Snapinsta…_5y"-style readable label with the full name on hover. */
const shortSource = (t: string | null) => {
  const s = t ?? "untitled source";
  return s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s;
};
const displayName = (r: Row) =>
  r.clipName ?? `${shortSource(r.videoTitle)} · ${r.inS.toFixed(0)}s–${r.outS.toFixed(0)}s`;

const exportUrl = (variantId: string, ratio: string, ext: "mp4" | "srt", dl?: string) =>
  `/api/exports/${variantId}/${ratio}.${ext}${dl ? `?dl=${encodeURIComponent(dl)}` : ""}`;

function downloadAll(files: { url: string }[]) {
  files.forEach((f, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = f.url;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 500);
  });
}

/* ------------- export player modal (burned ground truth) ------------- */

function PlayerModal({ row, initialRatio, onClose }: {
  row: Row; initialRatio: string; onClose: () => void;
}) {
  const ratios = [...row.ratios].sort((a, b) => ratioOrder(a) - ratioOrder(b));
  const [ratio, setRatio] = useState(
    ratios.includes(initialRatio) ? initialRatio : ratios[0]);
  const [dur, setDur] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const meta = RATIOS[ratio] ?? { label: ratio, px: "", ar: 9 / 16 };
  const file = (ext: "mp4" | "srt") => exportFilename(row, ratio, ext);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="exmodal" onPointerDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="exmodal-card">
        <div className="exmodal-head">
          <div>
            <div className="mono" style={{ fontSize: 11.5, fontWeight: 700 }}>
              {exportFilename(row, ratio, "mp4").replace(/\.mp4$/, "")}
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
              {meta.label} · {meta.px}
              {dur !== null ? ` · ${dur.toFixed(1)}s` : ""}
              {" · "}{row.label} · {row.variantName}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          {ratios.length > 1 && (
            <div style={{ display: "flex", gap: 4 }}>
              {ratios.map((r) => (
                <button key={r} className="spd" data-on={r === ratio ? "1" : undefined}
                  onClick={() => { setRatio(r); setDur(null); setErr(false); }}>
                  {RATIOS[r]?.label ?? r}
                </button>
              ))}
            </div>
          )}
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="exmodal-stage">
          {err ? (
            <div style={{ color: "#9A9CA2", fontSize: 11.5, padding: 30, textAlign: "center" }}>
              This export couldn&apos;t be loaded — the file may still be
              uploading, or the render predates it. Re-render the variant if
              it persists.
            </div>
          ) : (
            <video key={ratio} controls autoPlay playsInline
              src={exportUrl(row.variantId, ratio, "mp4")}
              style={{ aspectRatio: `${meta.ar}`, maxHeight: "62vh", maxWidth: "100%" }}
              onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
              onError={() => setErr(true)}
            />
          )}
        </div>
        <div className="exmodal-foot">
          <a className="btn sm" href={exportUrl(row.variantId, ratio, "mp4", file("mp4"))}>
            Download MP4
          </a>
          <a className="btn ghost sm" href={exportUrl(row.variantId, ratio, "srt", file("srt"))}
            title="Subtitle sidecar from the same remapped words as the burn-in">
            Download SRT
          </a>
          <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
            SRT matches the burned captions — same words, same timing.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- side drawer ---------------- */

function Drawer({ row, onClose, onNav, refresh }: {
  row: Row; onClose: () => void; onNav: (dir: 1 | -1) => void;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const vidRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown") { e.preventDefault(); onNav(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); onNav(-1); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, onNav]);

  // loop the proxy inside the clip's source range
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    const onMeta = () => { v.currentTime = row.inS; };
    const onTime = () => { if (v.currentTime >= row.outS) v.currentTime = row.inS; };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [row.variantId, row.inS, row.outS]);

  async function move(to: string) {
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/variants/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [row.variantId], to }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !body.moved) { setNote(body.error ?? "not a legal transition"); return; }
    refresh();
  }
  async function render(ratio = "9x16") {
    setBusy(true);
    await fetch(`/api/variants/${row.variantId}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratio }),
    });
    setBusy(false);
    setNote(`render queued (${RATIOS[ratio].label})`);
    refresh();
  }

  const ratios = [...row.ratios].sort((a, b) => ratioOrder(a) - ratioOrder(b));
  return (
    <div className="drawer-scrim" onPointerDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <strong title={row.videoTitle ?? undefined}>{displayName(row)}</strong>
            <div className="sub mono">
              {row.inS.toFixed(1)}s – {row.outS.toFixed(1)}s ·{" "}
              {(row.outS - row.inS).toFixed(1)}s · {row.label} · {row.variantName}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <span className="tag">{row.status}</span>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="drawer-vid">
          <video ref={vidRef} src={`/api/media/${row.videoId}`} controls muted
            playsInline preload="metadata" />
          <span className="mono drawer-range">source proxy · loops the clip range</span>
        </div>

        {row.renderStale && (
          <div className="ov-stale">
            Changed since the last render — the export is stale.
            <button className="btn sm" disabled={busy} onClick={() => void render()}>
              Re-render
            </button>
          </div>
        )}

        <div className="drawer-sec">
          <div className="eyebrow">Render</div>
          {ratios.length ? (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {ratios.map((rt) => (
                <a key={rt} className="exchip"
                  href={exportUrl(row.variantId, rt, "mp4", exportFilename(row, rt, "mp4"))}>
                  ↓ {RATIOS[rt]?.label ?? rt}
                </a>
              ))}
              {ratios.map((rt) => (
                <a key={`s${rt}`} className="exchip"
                  href={exportUrl(row.variantId, rt, "srt", exportFilename(row, rt, "srt"))}>
                  ↓ {RATIOS[rt]?.label ?? rt} SRT
                </a>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                not rendered
                {row.renderStatus && row.renderStatus !== "done"
                  ? ` — last job ${row.renderStatus}` : ""}
              </span>
              <button className="btn sm" disabled={busy} onClick={() => void render()}>
                Render now
              </button>
            </div>
          )}
          {row.renderError && (
            <p style={{ fontSize: 10.5, color: "#B00020", margin: "4px 0 0" }}
              title={row.renderError}>
              last render error: {row.renderError.slice(0, 120)}
            </p>
          )}
        </div>

        <div className="drawer-sec">
          <div className="eyebrow">Overlays</div>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            {row.nOverlays > 0
              ? `${row.nOverlays} overlay${row.nOverlays === 1 ? "" : "s"} on this variant — edit in the builder`
              : "none — add a hook in the builder"}
          </span>
        </div>

        <div className="drawer-foot">
          <Link className="btn sm" href={`/variants/${row.variantId}`}>Edit</Link>
          <Link className="btn ghost sm" href={`/variants/${row.variantId}/preview`}>Preview</Link>
          {row.status === "draft" && (
            <button className="btn ghost sm" disabled={busy}
              onClick={() => void move("in_review")}>Submit for review</button>
          )}
          {row.status === "in_review" && (
            <>
              <button className="btn sm" disabled={busy}
                onClick={() => void move("approved")}>Approve</button>
              <button className="btn ghost sm" disabled={busy}
                onClick={() => void move("draft")}>Back to draft</button>
            </>
          )}
          {row.status === "approved" && (
            <Link className="btn ghost sm" href="/send">Send to Meta →</Link>
          )}
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>↑↓ rows · esc closes</span>
        </div>
        {note && <p className="hint" style={{ margin: "6px 12px" }}>{note}</p>}
      </aside>
    </div>
  );
}

/* ---------------- table ---------------- */

export default function ClipsTable({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState<{ row: Row; ratio: string } | null>(null);

  const clips = useMemo(() => {
    const m = new Map<string, { rows: Row[]; blocked: boolean }>();
    for (const r of rows) {
      const c = m.get(r.clipId) ?? { rows: [], blocked: false };
      c.rows.push(r);
      if (r.status === "sent" || r.status === "sending") c.blocked = true;
      m.set(r.clipId, c);
    }
    return m;
  }, [rows]);

  const selectable = [...clips.entries()].filter(([, c]) => !c.blocked).map(([id]) => id);
  const allSel = selectable.length > 0 && selectable.every((id) => sel.has(id));
  const nVariants = [...sel].reduce((a, id) => a + (clips.get(id)?.rows.length ?? 0), 0);

  function toggle(clipId: string) {
    if (clips.get(clipId)?.blocked) return;
    setSel((s) => {
      const n = new Set(s);
      if (n.has(clipId)) n.delete(clipId); else n.add(clipId);
      return n;
    });
  }

  const nav = useCallback((dir: 1 | -1) => {
    setOpenIdx((i) => {
      if (i === null) return i;
      return Math.max(0, Math.min(rows.length - 1, i + dir));
    });
  }, [rows.length]);

  function approvedFiles(clipId: string) {
    const members = clips.get(clipId)?.rows ?? [];
    const files: { url: string }[] = [];
    for (const v of members) {
      if (v.status !== "approved" && v.status !== "sent") continue;
      for (const ratio of v.ratios)
        for (const ext of ["mp4", "srt"] as const)
          files.push({ url: exportUrl(v.variantId, ratio, ext, exportFilename(v, ratio, ext)) });
    }
    return files;
  }

  async function renameClip(r: Row) {
    const name = window.prompt("Clip name", displayName(r));
    if (name === null) return;
    await fetch(`/api/clips/${r.clipId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() || null }),
    });
    router.refresh();
  }

  async function bulkDelete() {
    const ids = [...sel];
    if (!ids.length) return;
    const ok = window.confirm(
      `Delete ${ids.length} clip${ids.length > 1 ? "s" : ""} (${nVariants} variant${nVariants > 1 ? "s" : ""})?\n\n` +
      "This permanently removes the clips, their variants, scenes, crops " +
      "and rendered files in R2. The source videos and transcripts are kept.",
    );
    if (!ok) return;
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/clips/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clip_ids: ids }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNote(body.error ?? res.statusText); return; }
    setSel(new Set());
    setNote(
      `Deleted ${body.deleted_clips} clip${body.deleted_clips === 1 ? "" : "s"}` +
      (body.cleanup_queued ? " — R2 cleanup queued on the worker." : "."),
    );
    router.refresh();
  }

  if (!rows.length) {
    return (
      <div className="card qempty">
        No clips yet — open a video and select a passage.
      </div>
    );
  }

  let lastClip = "";

  return (
    <>
      <div className={`bulk${sel.size > 0 ? " on" : ""}`}>
        <span className="cnt">
          {sel.size} clip{sel.size === 1 ? "" : "s"} selected
          <em style={{ fontStyle: "normal", fontWeight: 400, opacity: 0.7 }}>
            {" "}· {nVariants} variant{nVariants === 1 ? "" : "s"}
          </em>
        </span>
        <span className="sp" />
        <button disabled={busy} onClick={() => setSel(new Set())}>Clear</button>
        <button className="go" disabled={busy} onClick={() => void bulkDelete()}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>

      <div className="card" style={{ overflow: "hidden", marginTop: sel.size ? 0 : 12 }}>
        <table className="q">
          <thead>
            <tr>
              <th className="cb">
                <input type="checkbox" checked={allSel} aria-label="Select all clips"
                  onChange={(e) => {
                    setSel(e.target.checked ? new Set(selectable) : new Set());
                  }} />
              </th>
              <th></th>
              <th>Clip</th><th>Source range</th><th>Variant</th>
              <th>Approval</th><th>Render</th><th>Export</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const blocked = clips.get(r.clipId)?.blocked ?? false;
              const firstOfClip = r.clipId !== lastClip;
              lastClip = r.clipId;
              const batch = firstOfClip ? approvedFiles(r.clipId) : [];
              return (
                <tr key={r.variantId}
                  className={`${sel.has(r.clipId) ? "sel" : ""}${openIdx === i ? " open" : ""}`}
                  onClick={(e) => {
                    if ((e.target as Element).closest("input,a,button")) return;
                    setOpenIdx(i);
                  }}>
                  <td className="cb" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={sel.has(r.clipId)} disabled={blocked}
                      title={blocked ? "A variant was sent to Meta — remove the ad in Ads Manager before deleting" : undefined}
                      aria-label={`Select ${displayName(r)}`}
                      onChange={() => toggle(r.clipId)} />
                  </td>
                  <td className="thumb-cell">
                    {r.kfScene ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="row-thumb" src={`/api/keyframes/${r.kfScene}`}
                        alt="" loading="lazy" />
                    ) : (
                      <span className="row-thumb ph" />
                    )}
                  </td>
                  <td>
                    {firstOfClip && (
                      <>
                        <strong title={r.videoTitle ?? undefined}>{displayName(r)}</strong>
                        <button className="rename" aria-label="Rename clip"
                          onClick={() => void renameClip(r)}>✎</button>
                        <div className="sub" title={r.videoTitle ?? undefined}>
                          {shortSource(r.videoTitle)}
                        </div>
                        {batch.length > 0 && (
                          <button className="btn ghost sm" style={{ marginTop: 4 }}
                            title="Every approved variant's rendered files (MP4 + SRT), named by ad convention"
                            onClick={() => downloadAll(batch)}>
                            ↓ approved ({batch.length} files)
                          </button>
                        )}
                      </>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {r.inS.toFixed(1)}s – {r.outS.toFixed(1)}s
                  </td>
                  <td>
                    <Link href={`/variants/${r.variantId}`} style={{ textDecoration: "underline" }}
                      onClick={(e) => e.stopPropagation()}>
                      {r.label} · {r.variantName}
                    </Link>
                    {r.renderStale && <span className="tag flag" style={{ marginLeft: 5 }}>stale</span>}
                  </td>
                  <td><span className="tag">{r.status}</span></td>
                  <td>
                    {r.renderStatus ? (
                      <span className={renderTag(r.renderStatus)} title={r.renderError ?? undefined}>
                        {r.renderStatus}
                      </span>
                    ) : (
                      <span style={{ color: "var(--faint)", fontSize: 10.5 }}>not rendered</span>
                    )}
                  </td>
                  <td>
                    {r.ratios.length ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {[...r.ratios].sort((a, b) => ratioOrder(a) - ratioOrder(b)).map((rt) => (
                          <button key={rt} className="exchip"
                            onClick={() => setPlaying({ row: r, ratio: rt })}
                            title={`Play the ${RATIOS[rt]?.label ?? rt} export (burned ground truth)`}>
                            ▸ {RATIOS[rt]?.label ?? rt}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: "var(--faint)" }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="hint">{note}</p>}
      {openIdx !== null && rows[openIdx] && (
        <Drawer row={rows[openIdx]} onClose={() => setOpenIdx(null)}
          onNav={nav} refresh={() => router.refresh()} />
      )}
      {playing && (
        <PlayerModal row={playing.row} initialRatio={playing.ratio}
          onClose={() => setPlaying(null)} />
      )}
    </>
  );
}
