"use client";

/** Clips list with bulk delete — selection and bulk-bar pattern matches
 * the review queue. Selection is per CLIP: any row of a clip toggles all
 * its variant rows, and the count shown is clips. Clips with a variant
 * already sent to Meta can't be selected — deleting them locally would
 * orphan the ad (the API refuses them too). */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Row = {
  clipId: string; clipName: string | null; videoTitle: string | null;
  inS: number; outS: number;
  variantId: string; label: string; variantName: string; status: string;
  exportUri: string | null; renderStatus: string | null; renderError: string | null;
};

function renderTag(status: string) {
  if (status === "done") return "tag ok";
  if (status === "failed") return "tag flag";
  return "tag";
}

export default function ClipsTable({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
              return (
                <tr key={r.variantId} className={sel.has(r.clipId) ? "sel" : ""}
                  title={blocked ? "A variant of this clip was sent to Meta — remove the ad in Ads Manager before deleting" : undefined}
                  onClick={(e) => {
                    if ((e.target as Element).closest("input,a")) return;
                    toggle(r.clipId);
                  }}>
                  <td className="cb">
                    <input type="checkbox" checked={sel.has(r.clipId)} disabled={blocked}
                      aria-label={`Select ${r.clipName ?? "untitled clip"}`}
                      onChange={() => toggle(r.clipId)} />
                  </td>
                  <td>
                    <strong>{r.clipName ?? "untitled clip"}</strong>
                    <div className="sub">{r.videoTitle}</div>
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
                  <td className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>
                    {r.exportUri ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && <p className="hint">{note}</p>}
    </>
  );
}
