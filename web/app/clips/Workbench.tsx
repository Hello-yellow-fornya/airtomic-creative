"use client";

/** Clip builder workbench, variant-rows edition. The scenes strip IS the
 * variant list: one row per variant of the current clip, each showing its
 * own scene cards. The old clips/variants table is gone — clip-level
 * navigation lives in the left nav (queue/cuts).
 *
 * Row anatomy: yellow 3px edge on the loaded row · checkbox (bulk only —
 * ticking never changes what's loaded) · name with pencil/double-click/
 * Enter rename · that variant's scene cards (drag within the row only) ·
 * "+" to add a scene · "+ Variant" to duplicate the row directly beneath.
 * Status, approval, render state, stale and Compare all live in the 40px
 * player bar. Orphaned variants (source deleted) load read-only. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { exportFilename } from "@/lib/adname";
import Builder, { type ComparePayload } from "../variants/[id]/Builder";

type GroupScene = {
  id: string; idx: number; layout: string; in: number | null;
  out: number | null; dur: number | null; asset: string | null;
  splitRatio: number;
};
type GroupVariant = {
  id: string; label: string; name: string; status: string;
  renderStale: boolean; ratios: string[]; scenes: GroupScene[];
};

type EditorPayload = {
  variant: {
    id: string; label: string; name: string; status: string;
    clipId: string; clipIn: number; clipOut: number;
    presetId: string | null; overrides: Record<string, unknown>;
    videoId: string | null; videoTitle: string | null; videoSource: string;
    videoDuration: number; srcW: number; srcH: number;
    orphan: boolean;
    renderStatus: string | null; renderError: string | null; ratios: string[];
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
  group: GroupVariant[];
  orphan: boolean;
};

const LY_NAME: Record<string, string> = {
  full: "Full", split_product: "Product", split_speakers: "Speakers", card: "End card",
};
const sceneDur = (s: GroupScene) =>
  s.layout === "card" ? (s.dur ?? 2.5) : (s.out ?? 0) - (s.in ?? 0);

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

export default function Workbench({ initialVariantId, workerUp }: {
  initialVariantId: string | null; workerUp: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  const [selId, setSelId] = useState<string | null>(null);
  const [selScene, setSelScene] = useState(0);
  const [payload, setPayload] = useState<EditorPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  // visual order: insertion order for new variants, label order on reload
  const [rowOrder, setRowOrder] = useState<string[]>([]);
  const clipRef = useRef<string | null>(null);

  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const registerFlush = useCallback((fn: () => Promise<void>) => {
    flushRef.current = fn;
  }, []);
  const apiRef = useRef<{ getPlayheadS: () => number } | null>(null);
  const registerApi = useCallback((api: { getPlayheadS: () => number }) => {
    apiRef.current = api;
  }, []);

  const loadPayload = useCallback(async (id: string) => {
    setLoading(true);
    const res = await fetch(`/api/variants/${id}/editor`);
    if (res.ok) {
      const p: EditorPayload = await res.json();
      setPayload(p);
      // checked state is client-side only and clears on clip navigation
      if (clipRef.current !== p.variant.clipId) {
        clipRef.current = p.variant.clipId;
        setChecked(new Set());
        setRowOrder(p.group.map((g) => g.id));
      } else {
        setRowOrder((o) => {
          const known = o.filter((x) => p.group.some((g) => g.id === x));
          const fresh = p.group.map((g) => g.id).filter((x) => !known.includes(x));
          return [...known, ...fresh];
        });
      }
    } else if (res.status === 404) {
      setPayload(null);
    }
    setLoading(false);
  }, []);

  const select = useCallback(async (id: string, sceneIdx = 0) => {
    if (id === selId) { setSelScene(sceneIdx); return; }
    // finish any in-flight autosave on the outgoing variant first
    if (flushRef.current) { await flushRef.current(); flushRef.current = null; }
    setSelId(id);
    setSelScene(sceneIdx);
    setCompareOn(false);
    const p = new URLSearchParams(sp.toString());
    p.set("v", id);
    window.history.replaceState(null, "", `?${p.toString()}`);
  }, [selId, sp]);

  // initial selection: URL ?v= wins, else the server-picked default
  useEffect(() => {
    if (selId) return;
    const fromUrl = sp.get("v");
    const initial = fromUrl ?? initialVariantId;
    if (initial) setSelId(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selId) void loadPayload(selId);
  }, [selId, loadPayload]);

  const refreshPayload = useCallback(() => {
    router.refresh();
    if (selId) void loadPayload(selId);
  }, [router, selId, loadPayload]);

  const group = useMemo(() => payload?.group ?? [], [payload]);
  const byId = useMemo(() => new Map(group.map((g) => [g.id, g])), [group]);
  const orderedRows = useMemo(
    () => rowOrder.map((id) => byId.get(id)).filter(Boolean) as GroupVariant[],
    [rowOrder, byId]);
  const orphan = payload?.orphan ?? false;
  const loaded = selId ? byId.get(selId) : undefined;

  // ----- keyboard: ↑/↓ move the loaded row (bounded), Enter renames -----
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (e.key === "Escape" && editing) { setEditing(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!selId || !orderedRows.length) return;
        const i = orderedRows.findIndex((r) => r.id === selId);
        if (i < 0) return;
        const j = Math.max(0, Math.min(orderedRows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        if (j !== i) {
          e.preventDefault();
          void select(orderedRows[j].id);
          document.querySelector(`[data-vrow="${orderedRows[j].id}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter" && selId && !editing && !orphan) {
        e.preventDefault();
        startRename(selId);
      }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedRows, selId, editing, select, orphan]);

  // ----- rename (pencil, double-click, Enter — one input) -----
  function startRename(id: string, prefill?: string) {
    const r = byId.get(id);
    if (!r || orphan) return;
    setEditing({ id, value: prefill ?? r.name, error: null });
    setTimeout(() => editRef.current?.select(), 0);
  }
  async function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    const r = byId.get(id);
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

  // ----- + Variant: duplicate directly beneath, load, open rename -----
  async function addVariant(fromId: string) {
    const src = byId.get(fromId);
    if (!src || !payload || orphan) return;
    setBusy(true);
    let res: Response | null = null;
    let body: { variant_id?: string; error?: string } = {};
    let chosen = `${src.name} copy`;
    for (const name of [`${src.name} copy`, `${src.name} copy 2`, undefined]) {
      res = await fetch(`/api/clips/${payload.variant.clipId}/variants`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copy_from: fromId, ...(name ? { name } : {}) }),
      });
      body = await res.json().catch(() => ({}));
      if (res.ok) { if (name) chosen = name; break; }
      if (res.status !== 409) break;
    }
    setBusy(false);
    if (!res?.ok || !body.variant_id) { setNote(body.error ?? "could not add variant"); return; }
    const newId = body.variant_id;
    // insert directly beneath the source row; label order returns on reload
    setRowOrder((o) => {
      const i = o.indexOf(fromId);
      return [...o.slice(0, i + 1), newId, ...o.slice(i + 1)];
    });
    await select(newId);
    await loadPayload(newId); // the row must exist before rename can open
    setEditing({ id: newId, value: chosen, error: null });
    setTimeout(() => editRef.current?.select(), 0);
    router.refresh();
  }

  // ----- scene ops within a row -----
  const [drag, setDrag] = useState<{ rowId: string; from: number } | null>(null);
  const [dragOver, setDragOver] = useState<{ rowId: string; i: number; left: boolean } | null>(null);
  // fixed-position so the menu escapes the strip's scroll clipping
  const [menuFor, setMenuFor] = useState<{ id: string; left: number; top: number; up: boolean } | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = e.target as Element;
      if (!el.closest(".addmenu") && !el.closest(".scn-add")) setMenuFor(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const call = useCallback(async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setNote(null);
    const res = await fetch(url, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setNote(err.error ?? res.statusText);
      return null;
    }
    refreshPayload();
    return res.json().catch(() => ({}));
  }, [refreshPayload]);

  async function splitAtPlayhead() {
    if (!payload || orphan) return;
    const scene = payload.scenes[Math.min(selScene, payload.scenes.length - 1)];
    if (!scene || scene.layout === "card") return;
    const at = apiRef.current?.getPlayheadS();
    if (at === undefined) return;
    await call(`/api/scenes/${scene.id}/split`, "POST", { at_s: at });
  }

  // ----- bulk actions -----
  const nChecked = checked.size;
  function toggleCheck(id: string) {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  const allChecked = orderedRows.length > 0 && orderedRows.every((r) => checked.has(r.id));

  async function bulkApprove() {
    const ids = [...checked];
    setBusy(true);
    const res = await fetch("/api/variants/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, to: "approved" }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    setNote(res.ok
      ? `${b.moved} approved${b.skipped ? ` · ${b.skipped} skipped (not in review)` : ""}`
      : (b.error ?? "approve failed"));
    setChecked(new Set());
    refreshPayload();
  }
  async function bulkRender() {
    setBusy(true);
    let n = 0;
    for (const id of checked) {
      const res = await fetch(`/api/variants/${id}/render`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratio: "9x16" }),
      });
      if (res.ok) n++;
    }
    setBusy(false);
    setNote(`${n} render${n === 1 ? "" : "s"} queued (9:16)`);
    setChecked(new Set());
    refreshPayload();
  }
  function bulkExport() {
    if (!payload) return;
    const files: { url: string }[] = [];
    for (const id of checked) {
      const g = byId.get(id);
      if (!g) continue;
      const v = { videoSource: payload.variant.videoSource, name: g.name, label: g.label };
      for (const ratio of g.ratios)
        for (const ext of ["mp4", "srt"] as const)
          files.push({ url: exportUrl(id, ratio, ext, exportFilename(v, ratio, ext)) });
    }
    if (!files.length) { setNote("nothing rendered among the checked variants"); return; }
    downloadAll(files);
    setNote(`${files.length} file${files.length === 1 ? "" : "s"} downloading`);
    setChecked(new Set());
  }
  async function bulkDelete() {
    if (!payload) return;
    const ids = [...checked];
    if (!ids.length) return;
    if (!window.confirm(
      `Delete ${ids.length} variant${ids.length > 1 ? "s" : ""}?\n\nThis permanently removes ` +
      "them with their scenes, crops, overlays and rendered files in R2. " +
      "Sent variants are refused. The source video and transcript are kept.",
    )) return;
    setBusy(true);
    const errs: string[] = [];
    if (ids.length === orderedRows.length) {
      // whole clip checked — delete the clip itself (variant DELETE refuses
      // removing the last one)
      const res = await fetch("/api/clips/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clip_ids: [payload.variant.clipId] }),
      });
      if (!res.ok) errs.push((await res.json().catch(() => ({}))).error ?? "clip delete failed");
    } else {
      for (const id of ids) {
        const res = await fetch(`/api/variants/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          errs.push(`${byId.get(id)?.label ?? id.slice(0, 6)}: ${b.error ?? res.statusText}`);
        }
      }
    }
    setBusy(false);
    setChecked(new Set());
    setNote(errs.length ? `Some deletions failed — ${errs.join(" · ")}` : "Deleted.");
    if (ids.length === orderedRows.length) {
      router.push("/queue");
      return;
    }
    if (selId && ids.includes(selId)) {
      const next = orderedRows.find((r) => !ids.includes(r.id));
      if (next) void select(next.id);
    }
    refreshPayload();
  }

  // ----- rows strip (rendered into the Builder's scenes slot) -----
  const rowsStrip = (
    <div className="vstrip">
      <div className="vstrip-hdr">
        <input type="checkbox" className="lib-check" checked={allChecked}
          aria-label="Select all variants"
          onChange={() => setChecked(allChecked ? new Set() : new Set(orderedRows.map((r) => r.id)))} />
        <span className="eyebrow">Variants — click a row to load it · drag cards to reorder</span>
        {nChecked > 0 && (
          <span className="vbulk">
            <button className="btn ghost sm" disabled={busy || orphan}
              onClick={() => void bulkApprove()}>Approve ({nChecked})</button>
            <button className="btn ghost sm" disabled={busy || orphan}
              onClick={() => void bulkRender()}>Render ({nChecked})</button>
            <button className="btn ghost sm" disabled={busy}
              onClick={() => bulkExport()}>Export ({nChecked})</button>
            <button className="btn ghost sm vdel" disabled={busy}
              onClick={() => void bulkDelete()}>Delete ({nChecked})</button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={busy || orphan}
          onClick={() => void splitAtPlayhead()}>
          Split at playhead
        </button>
      </div>

      <div className="vrows">
        {orderedRows.map((r) => {
          const isLoaded = r.id === selId;
          const isEditing = editing?.id === r.id;
          return (
            <div key={r.id} data-vrow={r.id}
              className={`vrow${isLoaded ? " sel" : ""}${orphan ? " orphan" : ""}`}
              onClick={(e) => {
                if ((e.target as Element).closest("input,button,.hnd-grip,.ops,.addmenu")) return;
                void select(r.id);
              }}>
              <div className="vrow-name">
                <input type="checkbox" className="lib-check" checked={checked.has(r.id)}
                  aria-label={`Select ${r.name}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleCheck(r.id)} />
                {isEditing ? (
                  <span onClick={(e) => e.stopPropagation()} style={{ minWidth: 0, flex: 1 }}>
                    <input ref={editRef} autoFocus className="wb-rename" value={editing.value}
                      onChange={(e) => setEditing((x) => x && { ...x, value: e.target.value, error: null })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      onBlur={() => void commitRename()} />
                    {editing.error && <span className="wb-nameerr">{editing.error}</span>}
                  </span>
                ) : (
                  <span className="vrow-nm" title={r.name}
                    onDoubleClick={() => { void select(r.id); startRename(r.id); }}>
                    {r.name}
                  </span>
                )}
                {orphan && <span className="tag flag vorph">source removed</span>}
                {!orphan && !isEditing && (
                  <button className="pencil" title="Rename" aria-label={`Rename ${r.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void select(r.id);
                      startRename(r.id);
                    }}>
                    ✎
                  </button>
                )}
              </div>

              <div className="rail-scenes vrow-cards">
                {r.scenes.map((s, i) => (
                  <div key={s.id}
                    className={`scn${drag?.rowId === r.id && drag.from === i ? " dragging" : ""}${
                      dragOver?.rowId === r.id && dragOver.i === i
                        ? (dragOver.left ? " over-l" : " over-r") : ""}`}
                    draggable={!orphan}
                    data-on={isLoaded && i === selScene ? "1" : "0"}
                    onClick={(e) => {
                      if ((e.target as Element).closest(".op")) return;
                      void select(r.id, i);
                    }}
                    onDragStart={(e) => {
                      if (orphan) return;
                      setDrag({ rowId: r.id, from: i });
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => { setDrag(null); setDragOver(null); }}
                    onDragOver={(e) => {
                      // cards move within their own row only
                      if (!drag || drag.rowId !== r.id || drag.from === i) return;
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setDragOver({ rowId: r.id, i, left: e.clientX < rect.left + rect.width / 2 });
                    }}
                    onDragLeave={() => setDragOver((d) => (d?.rowId === r.id && d.i === i ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!drag || drag.rowId !== r.id || drag.from === i) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      let to = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
                      if (drag.from < to) to--;
                      setDragOver(null);
                      void call(`/api/scenes/${r.scenes[drag.from].id}/move`, "POST", { to })
                        .then(() => { if (isLoaded) setSelScene(to); });
                    }}>
                    <span className="pv">
                      {s.layout === "card" ? (
                        <span className={`pv-card${s.asset && workerUp ? " has-img" : ""}`}
                          style={s.asset && workerUp
                            ? { backgroundImage: `url(/api/assets/${s.asset}/file)` } : undefined} />
                      ) : s.layout === "full" ? (
                        <span className="pv-half pv-vid" style={{ top: 0, bottom: 0 }} />
                      ) : (
                        <>
                          <span className="pv-half pv-vid" style={{ top: 0, height: `${s.splitRatio * 100}%` }} />
                          <span
                            className={`pv-half ${s.layout === "split_product" ? "pv-ast" : "pv-vid"}${
                              s.layout === "split_product" && s.asset && workerUp ? " has-img" : ""}`}
                            style={{ top: `${s.splitRatio * 100}%`, bottom: 0,
                              ...(s.layout === "split_product" && s.asset && workerUp
                                ? { backgroundImage: `url(/api/assets/${s.asset}/file)` } : {}) }}
                          />
                        </>
                      )}
                      {!orphan && <span className="hnd-grip">⋮⋮</span>}
                    </span>
                    {!orphan && (
                      <span className="ops">
                        {r.scenes.length > 1 && (
                          <button className="op" title="Delete scene"
                            onClick={() => void call(`/api/scenes/${s.id}`, "DELETE")
                              .then(() => { if (isLoaded) setSelScene(Math.max(0, selScene - 1)); })}>
                            ×
                          </button>
                        )}
                      </span>
                    )}
                    <span className="lb">
                      {LY_NAME[s.layout]}<b>{sceneDur(s).toFixed(1)}s</b>
                    </span>
                  </div>
                ))}
                {!orphan && (
                  <button className="scn-add" title="Add scene or apply template"
                    onClick={(e) => {
                      e.stopPropagation();
                      void select(r.id);
                      const rect = e.currentTarget.getBoundingClientRect();
                      const up = rect.bottom > window.innerHeight - 330;
                      setMenuFor((m) => (m?.id === r.id ? null : {
                        id: r.id,
                        left: Math.min(rect.left, window.innerWidth - 210),
                        top: up ? rect.top - 6 : rect.bottom + 6,
                        up,
                      }));
                    }}>
                    +
                  </button>
                )}
                {menuFor?.id === r.id && (
                  <div className="addmenu on vrow-menu" style={{
                    position: "fixed", left: menuFor.left,
                    ...(menuFor.up
                      ? { bottom: window.innerHeight - menuFor.top, top: "auto" }
                      : { top: menuFor.top }),
                  }}>
                    <div className="grp">Add scene</div>
                    <button onClick={() => { setMenuFor(null); void call(`/api/variants/${r.id}/scenes`, "POST", { layout: "full" }); }}>
                      <span className="mi"><i /></span>Full frame
                    </button>
                    <button onClick={() => {
                      setMenuFor(null);
                      void call(`/api/variants/${r.id}/scenes`, "POST", {
                        layout: "split_product",
                        slot_a_asset: payload?.assets.find((a) => a.kind !== "end_card")?.id ?? null,
                      });
                    }}>
                      <span className="mi"><i /><i className="ast" /></span>Product split
                    </button>
                    <button onClick={() => { setMenuFor(null); void call(`/api/variants/${r.id}/scenes`, "POST", { layout: "split_speakers" }); }}>
                      <span className="mi"><i /><i /></span>Speakers split
                    </button>
                    <button onClick={() => {
                      setMenuFor(null);
                      void call(`/api/variants/${r.id}/scenes`, "POST", {
                        layout: "card",
                        slot_a_asset: payload?.assets.find((a) => a.kind === "end_card")?.id ?? null,
                      });
                    }}>
                      <span className="mi"><i className="crd" /></span>End card
                    </button>
                    <div className="sep" />
                    <div className="grp">Apply template</div>
                    <button onClick={() => { setMenuFor(null); void call(`/api/variants/${r.id}/template`, "POST", { key: "plain" }).then(() => setSelScene(0)); }}>
                      Plain<span className="sub">1 scene</span>
                    </button>
                    <button onClick={() => { setMenuFor(null); void call(`/api/variants/${r.id}/template`, "POST", { key: "product" }).then(() => setSelScene(0)); }}>
                      Product split<span className="sub">2 scenes</span>
                    </button>
                    <button onClick={() => { setMenuFor(null); void call(`/api/variants/${r.id}/template`, "POST", { key: "hookfirst" }).then(() => setSelScene(0)); }}>
                      Hook first + card<span className="sub">3 scenes</span>
                    </button>
                  </div>
                )}
              </div>

              {!orphan && (
                <button className="addvar" disabled={busy}
                  title="Duplicate this variant (scenes, crops, overlays, subtitles) directly beneath"
                  onClick={(e) => { e.stopPropagation(); void addVariant(r.id); }}>
                  + Variant
                </button>
              )}
            </div>
          );
        })}
      </div>
      {note && <p className="hint">{note}</p>}
    </div>
  );

  if (!payload && !loading) {
    return (
      <div className="card qempty">
        {selId
          ? "This variant no longer exists — pick one from the review queue."
          : "No clips yet — open a video and select a passage, or start from a suggested cut."}
      </div>
    );
  }

  return payload ? (
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
        compare={loaded && group[0] && loaded.id !== group[0].id ? payload.compare : null}
        compareOn={compareOn}
        onCompareToggle={() => setCompareOn((c) => !c)}
        onJumpToRename={() => selId && startRename(selId)}
        registerFlush={registerFlush}
        registerApi={registerApi}
        onDataChanged={refreshPayload}
        selScene={selScene}
        onSelectScene={setSelScene}
        scenesSlot={rowsStrip}
        readOnly={orphan}
      />
    </div>
  ) : (
    <div className="card qempty">Loading…</div>
  );
}
