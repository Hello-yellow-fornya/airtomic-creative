"use client";

/** Library browsing: search + filter chips + tile/list toggle + pagination
 * + bulk actions, all URL-persisted so any filtered view is shareable.
 * The server component runs the query; this component only edits the URL
 * and renders what it was given. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { LibraryRow } from "@/lib/library";

const STATUS_CHIPS = [
  ["ready", "Ready"], ["processing", "Processing"],
  ["failed", "Failed"], ["visual_only", "Visual only"],
] as const;
const RENDITIONS = ["9x16", "1x1", "4x5", "16x9"];
const STAGES = ["UF", "LF", "Retargeting", "MOF", "BOF"];

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  transcribing: "Transcribing",
  detecting: "Detecting scenes",
  tagging: "Tagging",
  failed: "Failed",
  ready: "Ready",
};

function statusLabel(r: LibraryRow): string {
  if (r.status === "ready" && r.has_audio === false) return "Visual only";
  return STAGE_LABEL[r.status] ?? r.status;
}

const fmtDur = (s: string | null) => {
  if (!s) return "—";
  const secs = Math.round(parseFloat(s));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
};
const fmtSpend = (s: string | null) =>
  s ? `£${Math.round(parseFloat(s)).toLocaleString()}` : "—";

export default function LibraryBrowser({
  rows, total, page, per, workerUp,
}: {
  rows: LibraryRow[]; total: number; page: number; per: number;
  workerUp: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const view = sp.get("view") === "list" ? "list" : "tiles";

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [qLocal, setQLocal] = useState(sp.get("q") ?? "");
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setParams = useCallback((patch: Record<string, string | null>, resetPage = true) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k); else p.set(k, v);
    }
    if (resetPage) p.delete("page");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }, [sp, router, pathname]);

  // view preference remembered per user; URL wins when present
  useEffect(() => {
    if (!sp.get("view")) {
      const saved = localStorage.getItem("libView");
      if (saved === "list") setParams({ view: "list" }, false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setView = (v: "tiles" | "list") => {
    localStorage.setItem("libView", v);
    setParams({ view: v === "list" ? "list" : null }, false);
  };

  const onSearch = (v: string) => {
    setQLocal(v);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => setParams({ q: v || null }), 300);
  };

  const chip = (key: string, value: string, label: string) => (
    <button key={`${key}${value}`} className="chip"
      data-on={sp.get(key) === value ? "1" : undefined}
      onClick={() => setParams({ [key]: sp.get(key) === value ? null : value })}>
      {label}
    </button>
  );

  const toggleSel = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const selRows = rows.filter((r) => sel.has(r.id));
  const mergeGroupOk = selRows.length >= 2 && (
    (selRows.every((r) => r.content_hash) &&
      new Set(selRows.map((r) => r.content_hash)).size === 1) ||
    new Set(selRows.map((r) => r.name_key)).size === 1
  );

  async function bulkDelete() {
    if (!sel.size) return;
    if (!window.confirm(
      `Delete ${sel.size} source${sel.size > 1 ? "s" : ""}?\n\nRemoves the videos, their ` +
      "transcripts, scenes and tags, and their files in R2. Sources still " +
      "referenced by clips are skipped with an error.")) return;
    setBusy(true);
    const errs: string[] = [];
    for (const id of sel) {
      const res = await fetch(`/api/videos/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        errs.push(`${id.slice(0, 8)}: ${b.error ?? res.statusText}`);
      }
    }
    setBusy(false);
    setSel(new Set());
    setNote(errs.length ? `Some deletions failed — ${errs.join(" · ")}` : "Deleted.");
    router.refresh();
  }

  async function bulkRetry() {
    setBusy(true);
    let n = 0;
    for (const r of selRows.filter((x) => x.status === "failed")) {
      const res = await fetch(`/api/videos/${r.id}/retry`, { method: "POST" });
      if (res.ok) n++;
    }
    setBusy(false);
    setSel(new Set());
    setNote(`${n} retr${n === 1 ? "y" : "ies"} queued.`);
    router.refresh();
  }

  async function bulkMerge() {
    if (!mergeGroupOk) return;
    const sorted = [...selRows].sort((a, b) => a.ingested_at.localeCompare(b.ingested_at));
    const keep = sorted[0];
    const merged = sorted.slice(1);
    if (!window.confirm(
      `Merge ${selRows.length} copies?\n\nKeeps the oldest (“${keep.title ?? keep.id.slice(0, 8)}”), ` +
      "repoints clip and performance links to it, and deletes the rest " +
      "(including their R2 files).")) return;
    setBusy(true);
    const res = await fetch("/api/videos/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep_id: keep.id, ids: merged.map((m) => m.id) }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setSel(new Set());
    setNote(res.ok
      ? `Merged ${b.merged} into the oldest — ${b.clips_repointed} clip(s) and ${b.meta_links_repointed} performance link(s) repointed.`
      : (b.error ?? "merge failed"));
    router.refresh();
  }

  async function retryOne(id: string) {
    await fetch(`/api/videos/${id}/retry`, { method: "POST" });
    router.refresh();
  }

  const from = total === 0 ? 0 : (page - 1) * per + 1;
  const to = Math.min(page * per, total);
  const pages = Math.max(1, Math.ceil(total / per));

  const pager = (
    <div className="lib-pager">
      <span className="mono">Showing {from}–{to} of {total}</span>
      <span style={{ flex: 1 }} />
      <button className="btn ghost sm" disabled={page <= 1}
        onClick={() => setParams({ page: String(page - 1) }, false)}>← Prev</button>
      <span className="mono" style={{ fontSize: 10.5 }}>{page} / {pages}</span>
      <button className="btn ghost sm" disabled={page >= pages}
        onClick={() => setParams({ page: String(page + 1) }, false)}>Next →</button>
    </div>
  );

  const copiesBadge = (r: LibraryRow) => {
    const h = parseInt(r.hash_copies, 10);
    const n = parseInt(r.name_copies, 10);
    if (h > 1) return <span className="tag flag">{h} copies</span>;
    if (n > 1) return <span className="tag">{n} same name</span>;
    return null;
  };

  const checkbox = (r: LibraryRow) => (
    <input type="checkbox" className="lib-check" checked={sel.has(r.id)}
      aria-label={`Select ${r.title ?? r.id}`}
      onClick={(e) => e.stopPropagation()}
      onChange={() => toggleSel(r.id)} />
  );

  const sortHead = (key: string, label: string) => {
    const cur = sp.get("sort") ?? "ingested";
    const dir = sp.get("dir") ?? "desc";
    return (
      <th className="sortable" onClick={() =>
        setParams({ sort: key, dir: cur === key && dir === "desc" ? "asc" : "desc" }, false)}>
        {label}{cur === key ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </th>
    );
  };

  return (
    <div>
      <div className="lib-toolbar">
        <input className="lib-search" type="search" value={qLocal}
          placeholder="Search name, tags, transcript…"
          onChange={(e) => onSearch(e.target.value)} />
        <span style={{ flex: 1 }} />
        <div className="seg">
          <button data-on={view === "tiles" ? "1" : undefined}
            onClick={() => setView("tiles")}>Tiles</button>
          <button data-on={view === "list" ? "1" : undefined}
            onClick={() => setView("list")}>List</button>
        </div>
      </div>

      <div className="lib-chips">
        {STATUS_CHIPS.map(([v, l]) => chip("status", v, l))}
        <i className="chipsep" />
        {chip("source", "longform", "Long-form")}
        {chip("source", "ad_creative", "Ad creative")}
        <i className="chipsep" />
        {chip("perf", "1", "Has performance")}
        {chip("dupes", "1", "Duplicates")}
        <i className="chipsep" />
        <select value={sp.get("rendition") ?? ""} className="chip-sel"
          onChange={(e) => setParams({ rendition: e.target.value || null })}>
          <option value="">Rendition</option>
          {RENDITIONS.map((r) => <option key={r} value={r}>{r.replace("x", ":")}</option>)}
        </select>
        <select value={sp.get("stage") ?? ""} className="chip-sel"
          onChange={(e) => setParams({ stage: e.target.value || null })}>
          <option value="">Funnel stage</option>
          {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="chip-sel" type="number" min={0} placeholder="Min spend £"
          defaultValue={sp.get("spend") ?? ""} style={{ width: 90 }}
          onChange={(e) => {
            if (qTimer.current) clearTimeout(qTimer.current);
            const v = e.target.value;
            qTimer.current = setTimeout(() => setParams({ spend: v || null }), 400);
          }} />
        <input className="chip-sel" type="date" title="First ad use from"
          defaultValue={sp.get("from") ?? ""}
          onChange={(e) => setParams({ from: e.target.value || null })} />
        <input className="chip-sel" type="date" title="First ad use to"
          defaultValue={sp.get("to") ?? ""}
          onChange={(e) => setParams({ to: e.target.value || null })} />
      </div>

      <div className={`bulk${sel.size ? " on" : ""}`}>
        <span className="cnt">{sel.size} selected</span>
        <span className="sp" />
        <button disabled={busy} onClick={() => setSel(new Set())}>Clear</button>
        <button disabled={busy || !selRows.some((r) => r.status === "failed")}
          onClick={() => void bulkRetry()}>Retry</button>
        <button disabled={busy || !mergeGroupOk}
          title={mergeGroupOk ? "Keep the oldest, repoint links, delete the rest"
            : "Select 2+ copies of the same content (or same name) to merge"}
          onClick={() => void bulkMerge()}>Merge</button>
        <button className="go" disabled={busy} onClick={() => void bulkDelete()}>
          {busy ? "Working…" : "Delete"}
        </button>
      </div>

      {pager}

      {rows.length === 0 ? (
        <div className="card qempty">
          Nothing matches{sp.get("q") ? ` “${sp.get("q")}”` : " these filters"}.
        </div>
      ) : view === "tiles" ? (
        <div className="grid-assets">
          {rows.map((r) => (
            <Link key={r.id} href={`/videos/${r.id}`} className="card asset lib-tile">
              {checkbox(r)}
              <div className="thumb" style={
                workerUp && r.kf_scene
                  ? { backgroundImage: `url(/api/keyframes/${r.kf_scene})`,
                      backgroundSize: "cover", backgroundPosition: "center" }
                  : undefined
              }>
                {!(workerUp && r.kf_scene) && (<><div className="head" /><div className="head b" /></>)}
                {parseInt(r.n_cuts, 10) > 0 && (
                  <span className="badge">{r.n_cuts} cuts found</span>
                )}
                <span className="dur mono">{fmtDur(r.duration_s)}</span>
              </div>
              <div className="asset-meta">
                <h3 className="clamp2" title={r.title ?? undefined}>{r.title ?? "untitled"}</h3>
                <div className="m">
                  {statusLabel(r)}
                  {r.status === "ready" && r.has_audio !== false && ` · ${r.n_words} words`}
                  {r.status === "ready" && ` · ${r.n_scenes} scenes`}
                  {r.spend && ` · ${fmtSpend(r.spend)}`}
                </div>
                <div className="lib-tags">
                  {copiesBadge(r)}
                  {r.match_reason && <span className="tag ok">matched: {r.match_reason}</span>}
                  {r.status === "failed" && (
                    <>
                      <span className="tag flag" title={r.error_detail ?? undefined}>error ⓘ</span>
                      <button className="btn ghost sm"
                        onClick={(e) => { e.preventDefault(); void retryOne(r.id); }}>
                        Retry
                      </button>
                    </>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="q lib-list">
            <thead>
              <tr>
                <th className="cb"></th><th></th>
                {sortHead("name", "Name")}
                <th>Rendition</th>
                {sortHead("duration", "Duration")}
                {sortHead("words", "Words")}
                {sortHead("scenes", "Scenes")}
                {sortHead("spend", "Spend")}
                {sortHead("status", "Status")}
                {sortHead("first_use", "First use")}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={(e) => {
                  if ((e.target as Element).closest("input,a,button")) return;
                  router.push(`/videos/${r.id}`);
                }}>
                  <td className="cb">{checkbox(r)}</td>
                  <td className="thumb-cell">
                    {workerUp && r.kf_scene ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="row-thumb" src={`/api/keyframes/${r.kf_scene}`} alt="" loading="lazy" />
                    ) : <span className="row-thumb ph" />}
                  </td>
                  <td title={r.title ?? undefined} style={{ maxWidth: 260 }}>
                    <span className="clamp1">{r.title ?? "untitled"}</span>
                    <span style={{ display: "inline-flex", gap: 4, marginLeft: 5 }}>
                      {copiesBadge(r)}
                      {r.match_reason && <span className="tag ok">matched: {r.match_reason}</span>}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 10.5 }}>
                    {(r.renditions ?? []).map((x) => x.replace("x", ":")).join(" ") || "—"}
                  </td>
                  <td className="mono">{fmtDur(r.duration_s)}</td>
                  <td className="mono">{r.has_audio === false ? "visual" : r.n_words}</td>
                  <td className="mono">{r.n_scenes}</td>
                  <td className="mono">{fmtSpend(r.spend)}</td>
                  <td>
                    <span className="tag" title={r.error_detail ?? r.status_detail ?? undefined}>
                      {statusLabel(r)}
                    </span>
                    {r.status === "failed" && (
                      <button className="btn ghost sm" style={{ marginLeft: 4 }}
                        onClick={() => void retryOne(r.id)}>Retry</button>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 10.5 }}>{r.first_use ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pager}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
