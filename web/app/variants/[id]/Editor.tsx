"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Scene = {
  id: string; idx: number; layout: string; in: number | null; out: number | null;
  dur: number | null; lifted: boolean; asset: string | null;
  splitRatio: number; audio: string;
};
type Crop = { sceneId: string; ratio: string; x: number; y: number; w: number; h: number };
type Asset = { id: string; name: string; kind: string };

const RATIOS: Record<string, { ar: number; label: string }> = {
  "9x16": { ar: 9 / 16, label: "9:16" },
  "4x5": { ar: 4 / 5, label: "4:5" },
  "1x1": { ar: 1, label: "1:1" },
  "1.91x1": { ar: 1.91, label: "1.91:1" },
};
const LAYOUTS = ["full", "split_product", "split_speakers", "card"];
const SPLITS = [0.5, 0.6, 0.4];

/** cropBox() from the prototype: a window narrower than the source crops
 * WIDTH and drags horizontally; 1.91:1 is wider than a 16:9 source, so it
 * crops HEIGHT and drags vertically. */
function cropBox(srcAr: number, ratio: string) {
  const ar = RATIOS[ratio].ar;
  return ar < srcAr
    ? { w: ar / srcAr, h: 1, axis: "x" as const }
    : { w: 1, h: srcAr / ar, axis: "y" as const };
}

function sceneDur(s: Scene) {
  return s.layout === "card" ? (s.dur ?? 2.5) : (s.out ?? 0) - (s.in ?? 0);
}

export default function Editor({
  variantId, srcAr, scenes, crops, assets,
}: {
  variantId: string; srcAr: number; scenes: Scene[]; crops: Crop[]; assets: Asset[];
}) {
  const router = useRouter();
  const [sel, setSel] = useState(0);
  const [cropRatio, setCropRatio] = useState("9x16");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const scene = scenes[Math.min(sel, scenes.length - 1)];

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setNote(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setNote((await res.json()).error ?? res.statusText);
      return false;
    }
    router.refresh();
    return true;
  }

  const box = cropBox(srcAr, cropRatio);
  const stored = scene
    ? crops.find((c) => c.sceneId === scene.id && c.ratio === cropRatio)
    : undefined;
  // Slider drives the free axis; the window size is fixed by the ratio.
  const pos = stored
    ? box.axis === "x" ? stored.x : stored.y
    : box.axis === "x" ? (1 - box.w) / 2 : (1 - box.h) / 2;
  const posMax = box.axis === "x" ? 1 - box.w : 1 - box.h;

  async function saveCrop(newPos: number) {
    if (!scene) return;
    const crop =
      box.axis === "x"
        ? { x: newPos, y: 0, w: box.w, h: box.h }
        : { x: 0, y: newPos, w: box.w, h: box.h };
    await call(`/api/scenes/${scene.id}/crop`, "PUT", { ratio: cropRatio, ...crop });
  }

  const total = scenes.reduce((a, s) => a + sceneDur(s), 0);

  return (
    <div>
      {/* scene strip */}
      <div className="lane-tag">Scene order</div>
      <div className="timeline" style={{ height: 56, marginBottom: 12 }}>
        {scenes.map((s, i) => (
          <div
            key={s.id}
            className={`scene${s.layout === "card" ? " is-card" : ""}`}
            data-on={i === sel ? "1" : undefined}
            onClick={() => setSel(i)}
            style={{ flex: Math.max(sceneDur(s) / (total || 1), 0.04), cursor: "pointer" }}
          >
            {s.layout} · {sceneDur(s).toFixed(1)}s
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        <button className="btn ghost sm" disabled={busy}
          onClick={() => call(`/api/variants/${variantId}/scenes`, "POST",
            { layout: "card", slot_a_asset: assets[0]?.id ?? null })}>
          + End card
        </button>
        <button className="btn ghost sm" disabled={busy}
          onClick={() => call(`/api/variants/${variantId}/scenes`, "POST",
            { layout: "split_product", slot_a_asset: assets[0]?.id ?? null })}>
          + Product split
        </button>
        <span style={{ flex: 1 }} />
        {Object.keys(RATIOS).map((r) => (
          <button key={r} className="btn ghost sm" disabled={busy}
            onClick={async () => {
              if (await call(`/api/variants/${variantId}/render`, "POST", { ratio: r }))
                setNote(`render queued: ${RATIOS[r].label}`);
            }}>
            Render {RATIOS[r].label}
          </button>
        ))}
      </div>

      {scene && (
        <div className="card pad">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <strong>
              Scene {scene.idx}
              {scene.layout !== "card" && (
                <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                  {" "}· {scene.in?.toFixed(1)}s – {scene.out?.toFixed(1)}s
                </span>
              )}
              {scene.lifted && scene.layout !== "card" && (
                <span className="tag" style={{ marginLeft: 7 }}>lifted</span>
              )}
            </strong>
            <span style={{ display: "flex", gap: 5 }}>
              <button className="chip" disabled={busy || sel === 0}
                onClick={async () => {
                  if (await call(`/api/scenes/${scene.id}/move`, "POST", { dir: "up" }))
                    setSel(sel - 1);
                }}>← earlier</button>
              <button className="chip" disabled={busy || sel === scenes.length - 1}
                onClick={async () => {
                  if (await call(`/api/scenes/${scene.id}/move`, "POST", { dir: "down" }))
                    setSel(sel + 1);
                }}>later →</button>
              <button className="chip" disabled={busy || scenes.length < 2}
                onClick={async () => {
                  if (await call(`/api/scenes/${scene.id}`, "DELETE"))
                    setSel(Math.max(0, sel - 1));
                }}>delete</button>
            </span>
          </div>

          <div style={{ display: "flex", gap: 28, marginTop: 16, flexWrap: "wrap" }}>
            <div className="ctrl-grp">
              <span className="eyebrow">Layout</span>
              <div className="chips">
                {LAYOUTS.map((l) => (
                  <button key={l} className="chip"
                    data-on={scene.layout === l ? "1" : undefined}
                    disabled={busy || (l === "card" && scene.layout !== "card")}
                    onClick={() => call(`/api/scenes/${scene.id}`, "PATCH", { layout: l })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {(scene.layout === "split_product" || scene.layout === "split_speakers") && (
              <div className="ctrl-grp">
                <span className="eyebrow">Split · upper share (presets only)</span>
                <div className="chips">
                  {SPLITS.map((r) => (
                    <button key={r} className="chip" disabled={busy}
                      data-on={scene.splitRatio === r ? "1" : undefined}
                      onClick={() => call(`/api/scenes/${scene.id}`, "PATCH", { split_ratio: r })}>
                      {Math.round(r * 100)}/{Math.round((1 - r) * 100)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(scene.layout === "split_product" || scene.layout === "card") && (
              <div className="ctrl-grp">
                <span className="eyebrow">Asset slot</span>
                <select
                  value={scene.asset ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    call(`/api/scenes/${scene.id}`, "PATCH", { slot_a_asset: e.target.value })}>
                  <option value="">— none —</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>
                  ))}
                </select>
              </div>
            )}

            {scene.layout !== "card" && (
              <div className="ctrl-grp">
                <span className="eyebrow">Audio</span>
                <div className="chips">
                  {["source", "mute"].map((a) => (
                    <button key={a} className="chip" disabled={busy}
                      data-on={scene.audio === a ? "1" : undefined}
                      onClick={() => call(`/api/scenes/${scene.id}`, "PATCH", { audio: a })}>
                      {a}
                    </button>
                  ))}
                </div>
                <p className="hint" style={{ marginTop: 2 }}>
                  Speaker audio wins in splits; assets are muted.
                </p>
              </div>
            )}
          </div>

          {scene.layout !== "card" && (
            <div style={{ marginTop: 20 }}>
              <span className="eyebrow">Reframe — saved per scene per ratio</span>
              <div className="chips" style={{ display: "flex", gap: 5, margin: "7px 0" }}>
                {Object.keys(RATIOS).map((r) => (
                  <button key={r} className="chip" disabled={busy}
                    data-on={cropRatio === r ? "1" : undefined}
                    onClick={() => setCropRatio(r)}>
                    {RATIOS[r].label}
                    {crops.some((c) => c.sceneId === scene.id && c.ratio === r) ? " ●" : ""}
                  </button>
                ))}
              </div>
              <input
                type="range" min={0} max={Math.max(posMax, 0.0001)} step={0.005}
                value={Math.min(pos, posMax)} disabled={busy || posMax <= 0}
                style={{ width: 340 }}
                onChange={(e) => saveCrop(Number(e.target.value))}
              />
              <p className="hint">
                {box.axis === "y"
                  ? `1.91:1 is wider than the source — it crops HEIGHT (${(box.h * 100).toFixed(1)}% kept) and drags vertically.`
                  : `Window is ${(box.w * 100).toFixed(1)}% of source width — drags horizontally.`}
              </p>
            </div>
          )}
        </div>
      )}

      {note && <p className="hint">{note}</p>}
      <p className="hint">
        Highlights are lifted from their original position by default, not duplicated.
      </p>
    </div>
  );
}
