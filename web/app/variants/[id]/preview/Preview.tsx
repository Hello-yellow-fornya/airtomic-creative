"use client";

/** 05 Preview — assembled playback of the variant, scene by scene, over
 * the real source video. Captions are remapped to the OUTPUT timeline
 * first (the same outputWords remap the renderer does — CLAUDE.md §1),
 * so what you read here is caption timing as it will ship. When a
 * finished render exists for the chosen ratio, the export itself is
 * playable — that file is the ground truth with burned subtitles. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SceneP = {
  id: string; layout: string; in: number | null; out: number | null;
  dur: number | null; asset: string | null; splitRatio: number;
};
type Word = { w: string; s: number; e: number };
type Style = {
  fs: number; ol: number; vp: number; wpl: number; hl: string;
  caps: boolean; box: boolean;
};

const RATIOS: Record<string, { label: string; px: string; use: string; cls: string }> = {
  "9x16": { label: "9:16", px: "1080×1920", use: "Reels, Stories", cls: "" },
  "4x5": { label: "4:5", px: "1080×1350", use: "Feed", cls: "r45" },
  "1x1": { label: "1:1", px: "1080×1080", use: "Feed, Explore", cls: "r11" },
  "1.91x1": { label: "1.91:1", px: "1200×628", use: "PMax, landscape", cls: "r1911" },
};
const SAFE: Record<string, { t: number; b: number; r: number; note: string; noteB: string }> = {
  "9x16": { t: 14, b: 16, r: 12, note: "TOP 14% — PROFILE, USERNAME, AD LABEL", noteB: "BOTTOM 16% — CAPTION, CTA BUTTON" },
  "4x5": { t: 5, b: 9, r: 0, note: "TOP 5%", noteB: "BOTTOM 9% — CAPTION, CTA" },
  "1x1": { t: 9, b: 11, r: 0, note: "TOP 9% — PROFILE, AD LABEL", noteB: "BOTTOM 11% — CAPTION, CTA" },
  "1.91x1": { t: 8, b: 8, r: 8, note: "TOP 8% — PMAX AUTO-CROP MARGIN", noteB: "BOTTOM 8% — PMAX AUTO-CROP MARGIN" },
};
const LY_NAME: Record<string, string> = {
  full: "Full", split_product: "Product", split_speakers: "Speakers", card: "End card",
};

const sceneDur = (s: SceneP) =>
  s.layout === "card" ? (s.dur ?? 2.5) : (s.out ?? 0) - (s.in ?? 0);
const clock = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** The remap: words live on the SOURCE timeline; once scenes are
 * reordered or lifted they no longer describe the output. Same algorithm
 * as worker/subtitles.output_words and the prototype's outputWords(). */
function outputWords(scenes: SceneP[], words: Word[]): Word[] {
  const out: Word[] = [];
  let acc = 0;
  for (const s of scenes) {
    const d = sceneDur(s);
    if (s.layout !== "card" && s.in !== null && s.out !== null) {
      for (const w of words) {
        if (w.e > s.in && w.s < s.out) {
          out.push({
            w: w.w,
            s: acc + Math.max(0, w.s - s.in),
            e: acc + Math.min(d, w.e - s.in),
          });
        }
      }
    }
    acc += d;
  }
  return out.sort((a, b) => a.s - b.s || a.e - b.e);
}

export default function Preview({
  variant, siblings, scenes, cropsByScene, words, style: S, fixes,
  compliance, renders, workerUp, endCardAssets,
}: {
  variant: {
    id: string; label: string; name: string; status: string;
    videoId: string; clipIn: number; clipOut: number; srcAr: number;
  };
  siblings: { id: string; label: string; name: string; nScenes: number }[];
  scenes: SceneP[];
  cropsByScene: Record<string, string[]>;
  words: Word[];
  style: Style;
  fixes: Record<string, string>;
  compliance: { flag: boolean; notes: string | null };
  renders: Record<string, string>;
  workerUp: boolean;
  endCardAssets: string[];
}) {
  const router = useRouter();
  const [ratio, setRatio] = useState("9x16");
  const [zonesOn, setZonesOn] = useState(true);
  const [mode, setMode] = useState<"assembled" | "export">("assembled");
  const [pT, setPT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef(0);

  const fixWord = useCallback((w: string) => {
    const bare = w.replace(/[.,!?;:"']+$/, "");
    const rep = fixes[bare.toLowerCase()];
    return rep ? rep + w.slice(bare.length) : w;
  }, [fixes]);

  const total = useMemo(() => scenes.reduce((a, s) => a + sceneDur(s), 0), [scenes]);
  const OW = useMemo(() => outputWords(scenes, words), [scenes, words]);

  const sceneAt = useCallback((t: number) => {
    let acc = 0;
    for (let i = 0; i < scenes.length; i++) {
      const d = sceneDur(scenes[i]);
      if (t < acc + d || i === scenes.length - 1) return { i, local: t - acc, start: acc, d };
      acc += d;
    }
    return { i: 0, local: 0, start: 0, d: 0 };
  }, [scenes]);

  const cur = sceneAt(Math.min(pT, Math.max(total - 0.001, 0)));
  const scene = scenes[cur.i];

  // keep the source video aligned with the assembled clock
  const syncVideo = useCallback((t: number, wantPlay: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const c = sceneAt(t);
    const s = scenes[c.i];
    if (s.layout === "card" || s.in === null) {
      if (!v.paused) v.pause();
      return;
    }
    const want = s.in + Math.min(c.local, sceneDur(s));
    if (Math.abs(v.currentTime - want) > 0.2) v.currentTime = want;
    if (wantPlay && v.paused) void v.play().catch(() => {});
    if (!wantPlay && !v.paused) v.pause();
  }, [sceneAt, scenes]);

  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };
  const tick = useCallback((ts: number) => {
    setPT((prev) => {
      const next = prev + (ts - lastTs.current) / 1000;
      lastTs.current = ts;
      if (next >= total) {
        setPlaying(false);
        stopRaf();
        syncVideo(total, false);
        return total;
      }
      syncVideo(next, true);
      rafRef.current = requestAnimationFrame(tick);
      return next;
    });
  }, [total, syncVideo]);

  const setPlay = useCallback((on: boolean) => {
    setPlaying(on);
    if (on) {
      lastTs.current = performance.now();
      stopRaf();
      rafRef.current = requestAnimationFrame(tick);
    } else {
      stopRaf();
      syncVideo(pT, false);
    }
  }, [tick, syncVideo, pT]);
  useEffect(() => () => stopRaf(), []);

  // live caption line from the remapped output timeline
  const lines = useMemo(() => {
    const out: Word[][] = [];
    for (let i = 0; i < OW.length; i += S.wpl) out.push(OW.slice(i, i + S.wpl));
    return out;
  }, [OW, S.wpl]);
  const lineIdx = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--)
      if (pT >= lines[i][0].s) return i;
    return -1;
  }, [lines, pT]);
  const line = lineIdx >= 0 ? lines[lineIdx] : null;

  const sz = SAFE[ratio];
  const R = RATIOS[ratio];
  const exportDone = renders[ratio] === "done";

  // ----- pre-flight checks (all computed from real state) -----
  const hasCard = scenes.some((s) => s.layout === "card");
  const hasSplit = scenes.some((s) => s.layout.startsWith("split"));
  const capTop = S.vp - 6, capBot = S.vp + 6;
  const clash = capTop < sz.t || capBot > 100 - sz.b;
  const sourceScenes = scenes.filter((s) => s.layout !== "card");
  const missingCrops = sourceScenes.filter((s) => !(cropsByScene[s.id] ?? []).includes(ratio));
  const cardsWithoutAsset = scenes.filter((s) => s.layout === "card" && !s.asset);
  const checks: { s: string; t: string; p: string }[] = [
    {
      s: total >= 8 && total <= 60 ? "ok" : "warn",
      t: `Duration ${total.toFixed(1)}s`,
      p: total > 60 ? "Over 60s — trim for Reels placements"
        : total < 8 ? "Very short for a testing ad"
        : "Within range for Reels and Stories",
    },
    {
      s: clash ? "warn" : "ok",
      t: "Captions clear of UI",
      p: clash
        ? `Caption sits at ${S.vp}% — overlaps the ${capBot > 100 - sz.b ? "bottom" : "top"} safe zone at ${R.label}. Move it, or it will be covered.`
        : `Caption at ${S.vp}% sits inside the safe band`,
    },
    {
      s: "ok",
      t: "Captions remapped",
      p: `${OW.length} words repositioned to the output timeline`,
    },
    {
      s: missingCrops.length ? "warn" : "ok",
      t: `Crops at ${R.label}`,
      p: missingCrops.length
        ? `${missingCrops.length} scene${missingCrops.length > 1 ? "s" : ""} without a saved ${R.label} crop — the renderer centres them by default`
        : `Every source scene has a saved ${R.label} crop`,
    },
    {
      s: hasSplit ? "ok" : "",
      t: "Product on screen",
      p: hasSplit ? "Split scene present" : "No product visible — consider a split or end card",
    },
    {
      s: cardsWithoutAsset.length ? "warn" : hasCard ? "ok" : "",
      t: "End card",
      p: cardsWithoutAsset.length ? "Card scene has no asset assigned"
        : hasCard ? "Present" : "None added",
    },
    {
      s: compliance.flag ? "warn" : "ok",
      t: "Compliance",
      p: compliance.flag
        ? `Tagger flagged treatment claims${compliance.notes ? `: ${compliance.notes}` : ""} — legal review before it runs`
        : "No claim flags from the tagger on this source",
    },
    {
      s: exportDone ? "ok" : renders[ratio] ? "warn" : "",
      t: `Render at ${R.label}`,
      p: exportDone ? "Export finished — playable above"
        : renders[ratio] ? `Render ${renders[ratio]}`
        : "Not rendered at this ratio yet",
    },
  ];

  async function submit() {
    setBusy(true);
    await fetch("/api/variants/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [variant.id], to: "in_review" }),
    });
    setBusy(false);
    router.refresh();
  }

  const frameW = ratio === "4x5" ? 300 : ratio === "1x1" ? 330 : ratio === "1.91x1" ? 430 : 270;
  const capScale = frameW / 520;

  return (
    <div className="prev">
      <div>
        <div className="prev-stage">
          <div className={`vframe ${R.cls}${zonesOn ? " zones" : ""}`}>
            {mode === "export" && exportDone ? (
              <video src={`/api/exports/${variant.id}/${ratio}`} controls playsInline
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
            ) : (
              <>
                {/* assembled: source video under layout overlays */}
                {scene.layout !== "card" && workerUp && (
                  <div className="vf-top" style={{
                    height: scene.layout.startsWith("split")
                      ? `${scene.splitRatio * 100}%` : "100%",
                  }}>
                    <video ref={videoRef} muted={false} playsInline preload="auto"
                      src={`/api/media/${variant.videoId}`}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                      onLoadedMetadata={() => syncVideo(pT, false)}
                    />
                  </div>
                )}
                {scene.layout !== "card" && !workerUp && (
                  <div style={{ position: "absolute", inset: 0, display: "flex",
                    alignItems: "center", justifyContent: "center",
                    color: "#7C7E85", fontSize: 11, padding: 16, textAlign: "center" }}>
                    Worker not connected — assembled preview needs the source video.
                  </div>
                )}
                {scene.layout.startsWith("split") && (
                  <div className={`vf-bot${scene.layout === "split_product" && scene.asset && workerUp ? " has-img" : ""}`}
                    style={{
                      display: "flex", top: `${scene.splitRatio * 100}%`, bottom: 0,
                      ...(scene.layout === "split_product" && scene.asset && workerUp
                        ? { backgroundImage: `url(/api/assets/${scene.asset}/file)` }
                        : scene.layout === "split_speakers"
                          ? { background: "linear-gradient(135deg,#3A4252,#6E7A8F)" }
                          : {}),
                    }} />
                )}
                {scene.layout === "card" && (
                  <div className={`vf-card${scene.asset && workerUp ? " has-img" : ""}`}
                    style={{ display: "flex",
                      ...(scene.asset && workerUp
                        ? { backgroundImage: `url(/api/assets/${scene.asset}/file)` } : {}) }} />
                )}

                {line && (
                  <div className="cap" style={{
                    fontFamily: "var(--font-inter),sans-serif", fontWeight: 700,
                    lineHeight: 1.22, fontSize: S.fs * capScale, color: "#fff",
                    top: `${S.vp}%`, transform: "translateY(-50%)",
                    textShadow: S.ol ? `0 0 ${S.ol}px #000,0 0 ${S.ol}px #000` : "none",
                    ...(S.box ? { background: "rgba(0,0,0,.62)", padding: "4px 8px", borderRadius: 3 } : {}),
                  }}>
                    <div>
                      {line.map((w, i) => (
                        <b key={i} style={{ color: pT >= w.s && pT < w.e ? S.hl : "#fff" }}>
                          {S.caps ? fixWord(w.w).toUpperCase() : fixWord(w.w)}{" "}
                        </b>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="zone t" style={{ height: `${sz.t}%` }}><span>{sz.note}</span></div>
            <div className="zone b" style={{ height: `${sz.b}%` }}><span>{sz.noteB}</span></div>
            {sz.r > 0 && (
              <div className="zone r" style={{ width: `${sz.r}%` }}>
                <span>RIGHT {sz.r}% — ACTION RAIL</span>
              </div>
            )}
          </div>
        </div>

        <div className="prev-tools">
          <div className="seg">
            {Object.keys(RATIOS).map((r) => (
              <button key={r} data-on={ratio === r ? "1" : undefined}
                onClick={() => { setRatio(r); setMode("assembled"); setPlay(false); }}>
                {RATIOS[r].label}
              </button>
            ))}
          </div>
          <label className="zone-tog">
            <input type="checkbox" checked={zonesOn} onChange={(e) => setZonesOn(e.target.checked)} />
            {" "}Safe zones
          </label>
          {exportDone && (
            <div className="seg">
              <button data-on={mode === "assembled" ? "1" : undefined}
                onClick={() => setMode("assembled")}>Assembled</button>
              <button data-on={mode === "export" ? "1" : undefined}
                onClick={() => { setPlay(false); setMode("export"); }}>Export</button>
            </div>
          )}
          <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
            {R.use} · {R.px}
          </span>
        </div>

        <div className="ticks">
          {scenes.map((s, i) => (
            <span key={s.id} className="tick" style={{ flex: sceneDur(s) / (total || 1) }}
              data-on={i === cur.i ? "1" : "0"}>
              <i style={{ width: i < cur.i ? "100%" : i === cur.i ? `${(cur.local / cur.d) * 100}%` : 0 }} />
            </span>
          ))}
        </div>

        {mode === "assembled" && (
          <div className="transport" style={{ marginTop: 10 }}>
            <button className="tbtn pri" aria-label={playing ? "Pause" : "Play"}
              onClick={() => {
                if (!playing && pT >= total) { setPT(0); syncVideo(0, false); }
                setPlay(!playing);
              }}>
              <svg viewBox="0 0 12 12">
                {playing
                  ? <><rect x="2" y="1.5" width="3" height="9" /><rect x="7" y="1.5" width="3" height="9" /></>
                  : <path d="M2 1l9 5-9 5z" />}
              </svg>
            </button>
            <button className="tbtn" aria-label="Restart"
              onClick={() => { setPlay(false); setPT(0); syncVideo(0, false); }}>
              <svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" /></svg>
            </button>
            <span className="tc mono">
              <b>{clock(Math.min(pT, total))}</b> / <span>{total.toFixed(1)}</span>
            </span>
            <input type="range" min={0} max={1000} aria-label="Scrub"
              value={total > 0 ? Math.round((pT / total) * 1000) : 0}
              onChange={(e) => {
                const t = (+e.target.value / 1000) * total;
                setPT(t);
                syncVideo(t, playing);
              }}
            />
            <span className="tag">Scene {cur.i + 1} · {LY_NAME[scene.layout]}</span>
          </div>
        )}
      </div>

      <div className="stack">
        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 9 }}>Reviewing</div>
          <div className="vars" style={{ marginTop: 0 }}>
            {siblings.map((v) => (
              <button key={v.id} className="var" data-on={v.id === variant.id ? "1" : undefined}
                onClick={() => v.id !== variant.id && router.push(`/variants/${v.id}/preview`)}>
                <span className="mk">{v.label}</span>
                <span className="nm">{v.name}</span>
                <span className="ct">{v.nScenes}</span>
              </button>
            ))}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 10 }}>
            Each variant exports as its own ad. Check every one before pushing —
            a bad hook is the most expensive thing to discover after launch.
          </p>
        </div>

        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Pre-flight</div>
          <div>
            {checks.map((c) => (
              <div key={c.t} className="chk" data-s={c.s}>
                <span className="dotc" />
                <span>
                  <strong style={{ fontWeight: 600 }}>{c.t}</strong>
                  <p>{c.p}</p>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card pad">
          <div className="eyebrow" style={{ marginBottom: 9 }}>Next step</div>
          {variant.status === "draft" ? (
            <div>
              <p style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>
                Check every variant, then send them for review. Nothing reaches
                Meta from here.
              </p>
              <button className="btn" style={{ width: "100%" }} disabled={busy}
                onClick={() => void submit()}>
                {busy ? "Submitting…" : "Submit for review"}
              </button>
            </div>
          ) : (
            <div>
              <div className="chk" data-s="ok" style={{ border: "none", padding: "0 0 10px" }}>
                <span className="dotc" />
                <span>
                  <strong style={{ fontWeight: 600 }}>
                    {variant.status === "in_review" ? "Submitted"
                      : variant.status === "approved" ? "Approved"
                      : variant.status === "sent" ? "Sent to Meta" : variant.status}
                  </strong>
                  <p>
                    {variant.status === "in_review"
                      ? "Waiting in the review queue. Nothing has been sent to Meta."
                      : variant.status === "approved"
                        ? "Approved and waiting to be sent from the queue."
                        : "This variant has already been pushed."}
                  </p>
                </span>
              </div>
              <div className="row" style={{ gap: 7 }}>
                <button className="btn ghost sm" style={{ flex: 1 }}
                  onClick={() => router.push("/cuts")}>
                  Build another clip
                </button>
                <button className="btn sm" style={{ flex: 1 }}
                  onClick={() => router.push("/queue")}>
                  Open queue
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
