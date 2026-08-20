"use client";

/** Clips list with bulk delete, export playback and downloads.
 *
 * Selection/bulk-bar matches the review queue; selection is per CLIP and
 * clips with a sent variant can't be selected (deleting them locally would
 * orphan the ad).
 *
 * Finished renders open in a player modal at their real aspect ratio, with
 * a ratio switcher when a variant is rendered at several. Downloads go
 * through the presigned proxy with ad-convention filenames
 * (KLR_POD_topic_B_slug_9x16.mp4), and every render made since the SRT
 * sidecar shipped has a matching .srt from the same remapped words as the
 * burn-in. */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { exportFilename } from "@/lib/adname";

type Row = {
  clipId: string; clipName: string | null; videoTitle: string | null;
  videoSource: string;
  inS: number; outS: number;
  variantId: string; label: string; variantName: string; slug: string;
  status: string;
  renderStatus: string | null; renderError: string | null;
  ratios: string[];
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

const exportUrl = (variantId: string, ratio: string, ext: "mp4" | "srt", dl?: string) =>
  `/api/exports/${variantId}/${ratio}.${ext}${dl ? `?dl=${encodeURIComponent(dl)}` : ""}`;

/** Sequential anchor clicks — the browser may ask once to allow multiple
 * downloads from this site. */
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
            title="Subtitle sidecar from the same remapped words as the burn-in — drop it into Premiere/AE and style it there">
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

export default function ClipsTable({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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

  /** Batch: every approved (or sent) variant of the clip, every rendered
   * ratio, MP4 + SRT, under ad-convention names. */
  function approvedFiles(clipId: string) {
    const members = clips.get(clipId)?.rows ?? [];
    const files: { url: string }[] = [];
    for (const v of members) {
      if (v.status !== "approved" && v.status !== "sent") continue;
      for (const ratio of v.ratios) {
        for (const ext of ["mp4", "srt"] as const) {
          files.push({
            url: exportUrl(v.variantId, ratio, ext, exportFilename(v, ratio, ext)),
          });
        }
      }
    }
    return files;
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
    if (!res.ok) {
      setNote(body.error ?? res.statusText);
      return;
    }
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
              <th>Clip</th><th>Source range</th><th>Variant</th>
              <th>Approval</th><th>Render</th><th>Export</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const blocked = clips.get(r.clipId)?.blocked ?? false;
              const firstOfClip = r.clipId !== lastClip;
              lastClip = r.clipId;
              const batch = firstOfClip ? approvedFiles(r.clipId) : [];
              return (
                <tr key={r.variantId} className={sel.has(r.clipId) ? "sel" : ""}
                  title={blocked ? "A variant of this clip was sent to Meta — remove the ad in Ads Manager before deleting" : undefined}
                  onClick={(e) => {
                    if ((e.target as Element).closest("input,a,button")) return;
                    toggle(r.clipId);
                  }}>
                  <td className="cb">
                    <input type="checkbox" checked={sel.has(r.clipId)} disabled={blocked}
                      aria-label={`Select ${r.clipName ?? "untitled clip"}`}
                      onChange={() => toggle(r.clipId)} />
                  </td>
                  <td>
                    {firstOfClip && (
                      <>
                        <strong>{r.clipName ?? "untitled clip"}</strong>
                        <div className="sub">{r.videoTitle}</div>
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
                    <Link href={`/variants/${r.variantId}`} style={{ textDecoration: "underline" }}>
                      {r.label} · {r.variantName}
                    </Link>
                  </td>
                  <td><span className="tag">{r.status}</span></td>
                  <td>
                    {r.renderStatus ? (
                      <span className={renderTag(r.renderStatus)} title={r.renderError ?? undefined}>
                        {r.renderStatus}
                      </span>
                    ) : (
                      <span style={{ color: "var(--faint)" }}>—</span>
                    )}
                  </td>
                  <td>
                    {r.ratios.length ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {[...r.ratios].sort((a, b) => ratioOrder(a) - ratioOrder(b)).map((rt) => (
                          <button key={rt} className="exchip"
                            title={`Play the ${RATIOS[rt]?.label ?? rt} export`}
                            onClick={() => setPlaying({ row: r, ratio: rt })}>
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
      {playing && (
        <PlayerModal row={playing.row} initialRatio={playing.ratio}
          onClose={() => setPlaying(null)} />
      )}
    </>
  );
}
