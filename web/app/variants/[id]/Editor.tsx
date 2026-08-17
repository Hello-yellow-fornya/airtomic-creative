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
      <div className="timeline" style={{ height: 56 }}>
        {scenes.map((s, i) => (
          <div
            key={s.id}
            className="scene"
            onClick={() => setSel(i)}
            style={{
              flex: Math.max(sceneDur(s) / (total || 1), 0.04),
              outline: i === sel ? "2px solid var(--ink)" : "none",
              background: s.layout === "card" ? "#dcd4f5" : undefined,
            }}
          >
            {s.layout} · {sceneDur(s).toFixed(1)}s
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <button className="chipbtn" disabled={busy}
          onClick={() => call(`/api/variants/${variantId}/scenes`, "POST",
            { layout: "card", slot_a_asset: assets[0]?.id ?? null })}>
          + End card
        </button>
        <button className="chipbtn" disabled={busy}
          onClick={() => call(`/api/variants/${variantId}/scenes`, "POST",
            { layout: "split_product", slot_a_asset: assets[0]?.id ?? null })}>
          + Product split
        </button>
        <span style={{ flex: 1 }} />
        {Object.keys(RATIOS).map((r) => (
          <button key={r} className="chipbtn" disabled={busy}
            onClick={async () => {
              if (await call(`/api/variants/${variantId}/render`, "POST", { ratio: r }))
                setNote(`render queued: ${RATIOS[r].label}`);
            }}>
            Render {RATIOS[r].label}
          </button>
        ))}
      </div>

      {scene && (
        <div className="card">
          <div className="row">
            <strong>
              Scene {scene.idx}
              {scene.layout !== "card" &&
                ` · source ${scene.in?.toFixed(1)}s – ${scene.out?.toFixed(1)}s`}
              {scene.lifted && scene.layout !== "card" && " · lifted"}
            </strong>
            <span>
              <button className="chipbtn" disabled={busy || sel === 0}
                onClick={async () => {
                  if (await call(`/api/scenes/${scene.id}/move`, "POST", { dir: "up" }))
                    setSel(sel - 1);
                }}>← earlier</button>{" "}
              <button className="chipbtn" disabled={busy || sel === scenes.length - 1}
                onClick={async () => {
                  if (await call(`/api/scenes/${scene.id}/move`, "POST", { dir: "down" }))
                    setSel(sel + 1);
                }}>later →</button>{" "}
              <button className="chipbtn" disabled={busy || scenes.length < 2}
                onClick={async () => {
                  if (await call(`/api/scenes/${scene.id}`, "DELETE"))
                    setSel(Math.max(0, sel - 1));
                }}>delete</button>
            </span>
          </div>

          <div style={{ display: "flex", gap: 24, marginTop: 14, flexWrap: "wrap" }}>
            <div>
              <div className="spk">Layout</div>
              {LAYOUTS.map((l) => (
                <button key={l} className="chipbtn"
                  disabled={busy || (l === "card" && scene.layout !== "card")}
                  style={{ fontWeight: scene.layout === l ? 700 : 400 }}
                  onClick={() => call(`/api/scenes/${scene.id}`, "PATCH", { layout: l })}>
                  {l}
                </button>
              ))}
            </div>

            {(scene.layout === "split_product" || scene.layout === "split_speakers") && (
              <div>
                <div className="spk">Split (upper share — presets only)</div>
                {SPLITS.map((r) => (
                  <button key={r} className="chipbtn" disabled={busy}
                    style={{ fontWeight: scene.splitRatio === r ? 700 : 400 }}
                    onClick={() => call(`/api/scenes/${scene.id}`, "PATCH", { split_ratio: r })}>
                    {Math.round(r * 100)}/{Math.round((1 - r) * 100)}
                  </button>
                ))}
              </div>
            )}

            {(scene.layout === "split_product" || scene.layout === "card") && (
              <div>
                <div className="spk">Asset slot</div>
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
              <div>
                <div className="spk">Audio</div>
                {["source", "mute"].map((a) => (
                  <button key={a} className="chipbtn" disabled={busy}
                    style={{ fontWeight: scene.audio === a ? 700 : 400 }}
                    onClick={() => call(`/api/scenes/${scene.id}`, "PATCH", { audio: a })}>
                    {a}
                  </button>
                ))}
                <div className="hint">Speaker audio wins in splits; assets are muted.</div>
              </div>
            )}
          </div>

          {scene.layout !== "card" && (
            <div style={{ marginTop: 18 }}>
              <div className="spk">
                Reframe — per ratio (saved per scene per ratio)
              </div>
              <div style={{ display: "flex", gap: 6, margin: "6px 0" }}>
                {Object.keys(RATIOS).map((r) => (
                  <button key={r} className="chipbtn" disabled={busy}
                    style={{ fontWeight: cropRatio === r ? 700 : 400 }}
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
              <div className="hint">
                {box.axis === "y"
                  ? `1.91:1 is wider than the source — it crops HEIGHT (${(box.h * 100).toFixed(1)}% kept) and drags vertically.`
                  : `Window is ${(box.w * 100).toFixed(1)}% of source width — drags horizontally.`}
              </div>
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
