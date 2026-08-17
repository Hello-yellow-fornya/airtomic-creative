"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Config = {
  fs: number; ol: number; vp: number; wpl: number; hl: string;
  caps: boolean; box: boolean; font: string;
};
type Preset = { id: string; name: string; isDefault: boolean; config: Config };

const SAMPLE = ["Your", "barrier", "isn't", "broken"];

export default function StyleList({ presets }: { presets: Preset[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);

  function open(p: Preset) {
    setEditing(p.id);
    setDraft({ ...p.config });
  }
  async function save(id: string) {
    if (!draft) return;
    setBusy(true);
    await fetch(`/api/presets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: draft }),
    });
    setBusy(false);
    setEditing(null);
    router.refresh();
  }

  const summary = (c: Config) =>
    [`${c.font} 700`, `${c.fs}px`, c.caps ? "caps" : null,
     `outline ${c.ol}`, c.box ? "box" : null,
     c.hl === "#FFFFFF" ? "no highlight" : `highlight ${c.hl}`]
      .filter(Boolean).join(" · ");

  return (
    <div className="card pad">
      <div className="eyebrow" style={{ marginBottom: 12 }}>Saved styles</div>
      <div className="stack">
        {presets.map((p) => (
          <div key={p.id} style={{
            paddingBottom: 12,
            borderBottom: "1px solid var(--line-2)",
          }}>
            <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                  {summary(editing === p.id && draft ? draft : p.config)}
                </div>
              </div>
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                {p.isDefault && <span className="tag">default</span>}
                {editing === p.id ? (
                  <>
                    <button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button>
                    <button className="btn sm" disabled={busy} onClick={() => void save(p.id)}>
                      {busy ? "Saving…" : "Save"}
                    </button>
                  </>
                ) : (
                  <button className="btn ghost sm" onClick={() => open(p)}>Edit</button>
                )}
              </div>
            </div>

            {editing === p.id && draft && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 18, marginTop: 12 }}>
                <div>
                  <div className="ctrl">
                    <label>Size <b>{draft.fs}px</b></label>
                    <input type="range" min={16} max={46} value={draft.fs}
                      onChange={(e) => setDraft({ ...draft, fs: +e.target.value })} />
                  </div>
                  <div className="ctrl">
                    <label>Outline <b>{draft.ol}px</b></label>
                    <input type="range" min={0} max={8} value={draft.ol}
                      onChange={(e) => setDraft({ ...draft, ol: +e.target.value })} />
                  </div>
                  <div className="ctrl">
                    <label>Vertical position <b>{draft.vp}%</b></label>
                    <input type="range" min={35} max={88} value={draft.vp}
                      onChange={(e) => setDraft({ ...draft, vp: +e.target.value })} />
                  </div>
                  <div className="ctrl">
                    <label>Words per line <b>{draft.wpl}</b></label>
                    <input type="range" min={2} max={8} value={draft.wpl}
                      onChange={(e) => setDraft({ ...draft, wpl: +e.target.value })} />
                  </div>
                  <div className="ctrl">
                    <label>Active word</label>
                    <div className="swatches">
                      {["#FFC629", "#4ED6A1", "#FF6B8A", "#FFFFFF"].map((c) => (
                        <button key={c} className="sw" style={{ background: c }}
                          data-on={draft.hl === c ? "1" : undefined}
                          aria-label={`Highlight ${c}`}
                          onClick={() => setDraft({ ...draft, hl: c })} />
                      ))}
                    </div>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={draft.caps}
                      onChange={(e) => setDraft({ ...draft, caps: e.target.checked })} />
                    All caps
                  </label>
                  <label className="toggle">
                    <input type="checkbox" checked={draft.box}
                      onChange={(e) => setDraft({ ...draft, box: e.target.checked })} />
                    Background box
                  </label>
                </div>
                {/* live preview against dark footage-like ground */}
                <div style={{
                  background: "linear-gradient(135deg,#2B3140,#5A6478)",
                  borderRadius: 3, display: "flex", alignItems: "center",
                  justifyContent: "center", minHeight: 120, position: "relative",
                  overflow: "hidden",
                }}>
                  <div style={{
                    position: "absolute", left: "6%", right: "6%",
                    top: `${draft.vp}%`, transform: "translateY(-50%)",
                    textAlign: "center",
                    fontFamily: "var(--font-inter),sans-serif", fontWeight: 700,
                    fontSize: draft.fs * 0.45, lineHeight: 1.22, color: "#fff",
                    textShadow: draft.ol ? `0 0 ${draft.ol}px #000,0 0 ${draft.ol}px #000` : "none",
                    ...(draft.box ? { background: "rgba(0,0,0,.62)", padding: "3px 7px", borderRadius: 3 } : {}),
                  }}>
                    {SAMPLE.slice(0, draft.wpl).map((w, i) => (
                      <b key={i} style={{ color: i === 1 ? draft.hl : "#fff", fontWeight: "inherit" }}>
                        {draft.caps ? w.toUpperCase() : w}{" "}
                      </b>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
