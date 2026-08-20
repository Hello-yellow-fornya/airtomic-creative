"use client";

/** Clip builder workbench: every variant is a first-class, named row in
 * the table; selecting a row loads it into the single editor below. The
 * parent clip survives only as a grouping key (left-border accent) and a
 * shared source range shown on the A row.
 *
 * Selection: exactly one row. Click selects; ↑/↓ move selection; Space
 * toggles play on the selected variant (the editor owns that listener);
 * Enter starts renaming. Editor changes autosave debounced — a pending
 * save is flushed before the next variant loads, so switching rows never
 * loses work. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { exportFilename } from "@/lib/adname";
import Builder, { type ComparePayload } from "../variants/[id]/Builder";

type Row = {
  clipId: string;
  videoId: string; videoTitle: string | null; videoSource: string;
  inS: number; outS: number;
  variantId: string; label: string; name: string; slug: string;
  status: string; renderStale: boolean;
  renderStatus: string | null; renderError: string | null;
  ratios: string[]; kfScene: string | null; nOverlays: number;
};

type EditorPayload = {
  variant: {
    id: string; label: string; name: string; status: string;
    clipId: string; clipIn: number; clipOut: number;
    presetId: string | null; overrides: Record<string, unknown>;
    videoId: string; videoTitle: string | null;
    videoDuration: number; srcW: number; srcH: number;
  };
  scenes: {
    id: string; idx: number; layout: string; in: number | null;
    out: number | null; dur: number | null; lifted: boolean;
    asset: string | null; splitRatio: number; audio: string;
  }[];
  crops: { sceneId: string; ratio: string; x: number; y: number; w: number; h: number }[];
  assets: { id: string; name: string; kind: string }[];
  presets: { id: string; name: string; is_default: boolean; config: Record<string, unknown> }[];
  overlays: { id: string; text: string; start: number; end: number; position: string; style: string }[];
  overlayStyles: { key: string; name: string; config: Record<string, unknown> }[];
  renderStale: boolean;
  words: { w: string; s: number; e: number }[];
  compare: ComparePayload | null;
};

const RATIOS: Record<string, { label: string; px: string; ar: number }> = {
  "9x16": { label: "9:16", px: "1080×1920", ar: 9 / 16 },
  "4x5": { label: "4:5", px: "1080×1350", ar: 4 / 5 },
  "1x1": { label: "1:1", px: "1080×1080", ar: 1 },
  "1.91x1": { label: "1.91:1", px: "1200×628", ar: 1.91 },
};
const ratioOrder = (r: string) => Object.keys(RATIOS).indexOf(r);

const renderTag = (status: string) =>
  status === "done" ? "tag ok" : status === "failed" ? "tag flag" : "tag";

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
              {" · "}{row.label} · {row.name}
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

/* ---------------- workbench ---------------- */

export default function Workbench({ rows, workerUp }: {
  rows: Row[]; workerUp: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  const [selId, setSelId] = useState<string | null>(null);
  const [payload, setPayload] = useState<EditorPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [compareOn, setCompareOn] = useState(false);

  const [sel, setSel] = useState<Set<string>>(new Set()); // clip checkboxes
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ row: Row; ratio: string } | null>(null);

  const [editing, setEditing] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((fn: () => Promise<void>) => {
    flushRef.current = fn;
  }, []);

  const rowById = useMemo(
    () => new Map(rows.map((r) => [r.variantId, r])), [rows]);

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

  // ----- selection -----
  const loadPayload = useCallback(async (id: string) => {
    setLoading(true);
    const res = await fetch(`/api/variants/${id}/editor`);
    if (res.ok) setPayload(await res.json());
    else setPayload(null);
    setLoading(false);
  }, []);

  const select = useCallback(async (id: string) => {
    if (id === selId) return;
    // finish any in-flight autosave on the outgoing variant first
    if (flushRef.current) { await flushRef.current(); flushRef.current = null; }
    setSelId(id);
    setCompareOn(false);
    const p = new URLSearchParams(sp.toString());
    p.set("v", id);
    window.history.replaceState(null, "", `?${p.toString()}`);
  }, [selId, sp]);

  // initial selection: URL ?v= wins, else the first row
  useEffect(() => {
    if (selId) return;
    const fromUrl = sp.get("v");
    const initial = fromUrl && rowById.has(fromUrl)
      ? fromUrl : rows[0]?.variantId ?? null;
    if (initial) setSelId(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  useEffect(() => {
    if (selId) void loadPayload(selId);
  }, [selId, loadPayload]);

  const refreshPayload = useCallback(() => {
    router.refresh();
    if (selId) void loadPayload(selId);
  }, [router, selId, loadPayload]);

  // ----- keyboard: ↑/↓ selection (within the visible rows), Enter rename -----
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && active !== document.body) return; // inputs, crop, etc.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!selId) return;
        const i = rows.findIndex((r) => r.variantId === selId);
        if (i < 0) return;
        const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        if (j !== i) {
          e.preventDefault();
          void select(rows[j].variantId);
          document.querySelector(`tr[data-vid="${rows[j].variantId}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter" && selId && !editing) {
        e.preventDefault();
        startRename(selId);
      }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selId, editing, select]);

  // ----- inline rename -----
  function startRename(id: string) {
    const r = rowById.get(id);
    if (!r || r.status === "sent") return;
    setEditing({ id, value: r.name, error: null });
    document.querySelector(`tr[data-vid="${id}"]`)?.scrollIntoView({ block: "nearest" });
    setTimeout(() => editRef.current?.select(), 0);
  }
  async function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    const r = rowById.get(id);
    if (!r || value.trim() === "" || value.trim() === r.name) { setEditing(null); return; }
    const res = await fetch(`/api/variants/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value.trim() }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setEditing((e) => (e && e.id === id ? { ...e, error: b.error ?? "rename failed" } : e));
      return;
    }
    setEditing(null);
    refreshPayload();
  }

  // ----- variant actions -----
  async function addVariant(fromRow: Row) {
    setBusy(true);
    const res = await fetch(`/api/clips/${fromRow.clipId}/variants`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ copy_from: fromRow.variantId }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNote(b.error ?? res.statusText); return; }
    router.refresh();
    if (b.variant_id) void select(b.variant_id);
  }
  async function deleteVariant(r: Row) {
    if (!window.confirm(`Delete variant ${r.label} · ${r.name}?`)) return;
    const res = await fetch(`/api/variants/${r.variantId}`, { method: "DELETE" });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(b.error ?? res.statusText); return; }
    if (selId === r.variantId) {
      const next = rows.find((x) => x.clipId === r.clipId && x.variantId !== r.variantId)
        ?? rows.find((x) => x.variantId !== r.variantId);
      if (next) void select(next.variantId); else { setSelId(null); setPayload(null); }
    }
    router.refresh();
  }
  async function move(r: Row, to: string) {
    setBusy(true);
    const res = await fetch("/api/variants/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [r.variantId], to }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !body.moved) { setNote(body.error ?? "not a legal transition"); return; }
    refreshPayload();
  }

  // ----- clip bulk delete (unchanged semantics) -----
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
  async function bulkDelete() {
    const ids = [...sel];
    if (!ids.length) return;
    if (!window.confirm(
      `Delete ${ids.length} clip${ids.length > 1 ? "s" : ""} (${nVariants} variant${nVariants > 1 ? "s" : ""})?\n\n` +
      "This permanently removes the clips, their variants, scenes, crops " +
      "and rendered files in R2. The source videos and transcripts are kept.",
    )) return;
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/clips/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clip_ids: ids }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setNote(body.error ?? res.statusText); return; }
    setSel(new Set());
    if (selId && ids.includes(rowById.get(selId)?.clipId ?? "")) {
      setSelId(null); setPayload(null);
    }
    setNote(`Deleted ${body.deleted_clips} clip${body.deleted_clips === 1 ? "" : "s"}` +
      (body.cleanup_queued ? " — R2 cleanup queued on the worker." : "."));
    router.refresh();
  }

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

  if (!rows.length) {
    return (
      <div className="card qempty">
        No clips yet — open a video and select a passage.
      </div>
    );
  }

  const selRow = selId ? rowById.get(selId) : undefined;
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

      <div className="card wb-table" style={{ marginTop: sel.size ? 0 : 12 }}>
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
              <th>Name</th><th></th><th>Source range</th>
              <th>Approval</th><th>Render</th><th>Export</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const group = clips.get(r.clipId)!;
              const blocked = group.blocked;
              const firstOfClip = r.clipId !== lastClip;
              lastClip = r.clipId;
              const isSel = selId === r.variantId;
              const batch = firstOfClip ? approvedFiles(r.clipId) : [];
              const groupSelected = selRow?.clipId === r.clipId;
              const isEditing = editing?.id === r.variantId;
              return (
                <tr key={r.variantId} data-vid={r.variantId}
                  className={`wb-row${isSel ? " sel-row" : ""}${firstOfClip ? " grp-first" : ""}`}
                  onClick={(e) => {
                    if ((e.target as Element).closest("input,a,button")) return;
                    void select(r.variantId);
                  }}>
                  <td className="cb" onClick={(e) => e.stopPropagation()}>
                    {firstOfClip && (
                      <input type="checkbox" checked={sel.has(r.clipId)} disabled={blocked}
                        title={blocked ? "A variant was sent to Meta — remove the ad in Ads Manager before deleting" : "Select clip (all variants)"}
                        aria-label={`Select clip ${r.name}`}
                        onChange={() => toggle(r.clipId)} />
                    )}
                  </td>
                  <td className="thumb-cell">
                    {r.kfScene && workerUp ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="row-thumb" src={`/api/keyframes/${r.kfScene}`}
                        alt="" loading="lazy" />
                    ) : (
                      <span className="row-thumb ph" />
                    )}
                  </td>
                  <td className="wb-name">
                    <span className="playglyph">{isSel ? "▸" : ""}</span>
                    {isEditing ? (
                      <span onClick={(e) => e.stopPropagation()}>
                        <input ref={editRef} className="wb-rename" value={editing.value}
                          onChange={(e) => setEditing((x) => x && { ...x, value: e.target.value, error: null })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                            if (e.key === "Escape") setEditing(null);
                          }}
                          onBlur={() => void commitRename()} />
                        {editing.error && <span className="wb-nameerr">{editing.error}</span>}
                      </span>
                    ) : (
                      <button className="wb-namebtn" title={`${r.name} — click to rename`}
                        onClick={(e) => { e.stopPropagation(); void select(r.variantId); startRename(r.variantId); }}>
                        {r.name}
                      </button>
                    )}
                    {r.renderStale && <span className="tag flag" style={{ marginLeft: 5 }}>stale</span>}
                    {firstOfClip && batch.length > 0 && (
                      <button className="btn ghost sm" style={{ marginLeft: 6 }}
                        title="Every approved variant's rendered files (MP4 + SRT), named by ad convention"
                        onClick={(e) => { e.stopPropagation(); downloadAll(batch); }}>
                        ↓ approved ({batch.length})
                      </button>
                    )}
                  </td>
                  <td>
                    <span className="tag mk-pill">{r.label}</span>
                    {firstOfClip && groupSelected && selRow && selRow.label !== group.rows[0].label && (
                      <button className={`chip wb-cmp${compareOn ? "" : ""}`}
                        data-on={compareOn ? "1" : undefined}
                        style={{ marginLeft: 6 }}
                        title={`Side-by-side against ${group.rows[0].label} at the same playhead`}
                        onClick={(e) => { e.stopPropagation(); setCompareOn((c) => !c); }}>
                        Compare
                      </button>
                    )}
                  </td>
                  <td className={`mono${firstOfClip ? "" : " wb-range-dim"}`} style={{ fontSize: 11 }}>
                    {r.inS.toFixed(1)}s – {r.outS.toFixed(1)}s
                  </td>
                  <td>
                    <span className="tag">{r.status}</span>
                    {r.status === "draft" && (
                      <button className="btn ghost sm" style={{ marginLeft: 4 }} disabled={busy}
                        onClick={() => void move(r, "in_review")}>Submit</button>
                    )}
                    {r.status === "in_review" && (
                      <button className="btn ghost sm" style={{ marginLeft: 4 }} disabled={busy}
                        onClick={() => void move(r, "approved")}>Approve</button>
                    )}
                  </td>
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
                  <td className="wb-acts">
                    <button className="btn ghost sm" disabled={busy}
                      title="New variant: duplicates this row's overlays, subtitles, scene order and reframe as the next label"
                      onClick={() => void addVariant(r)}>
                      + variant
                    </button>
                    {group.rows.length > 1 && r.status !== "sent" && (
                      <button className="btn ghost sm" aria-label="Delete variant"
                        onClick={() => void deleteVariant(r)}>✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="hint">{note}</p>}

      {/* ---------- editor: loads whichever row is selected ---------- */}
      <div className="wb-editor">
        {payload ? (
          <div style={{ opacity: loading ? 0.55 : 1, transition: "opacity .12s" }}>
            <Builder
              key={payload.variant.id}
              variant={payload.variant}
              scenes={payload.scenes}
              crops={payload.crops}
              assets={payload.assets}
              presets={payload.presets}
              overlays={payload.overlays}
              overlayStyles={payload.overlayStyles}
              renderStale={payload.renderStale}
              words={payload.words}
              workerUp={workerUp}
              compare={payload.compare}
              compareOn={compareOn}
              onJumpToRename={() => selId && startRename(selId)}
              registerFlush={registerFlush}
              onDataChanged={refreshPayload}
            />
          </div>
        ) : (
          <div className="card qempty" style={{ marginTop: 14 }}>
            {loading ? "Loading variant…" : "Select a row above to edit it here."}
          </div>
        )}
      </div>

      {playing && (
        <PlayerModal row={playing.row} initialRatio={playing.ratio}
          onClose={() => setPlaying(null)} />
      )}
    </>
  );
}
