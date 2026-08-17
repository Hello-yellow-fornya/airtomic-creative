"use client";

/** 02 Find — docs/find-screen-redesign.html on real data.
 *
 * One clock: every control — scrubber, cut blocks, selection handles,
 * transcript clicks, playback — routes through seek(), which moves the
 * player, both strips, the selection meta and the transcript together.
 *
 * The transcript is ONE continuous flow of the whole source; suggested
 * cuts are yellow boxes drawn around their lines carrying rank, score,
 * n= and the evidence line (CLAUDE.md §5 lives here). With no candidates
 * there are simply no boxes, and the screen says so. */

import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useRouter } from "next/navigation";

type WordT = { w: string; s: number; e: number };
type LineT = { id: string; speaker: string | null; start: number; end: number; words: WordT[] };
type CutT = {
  id: string; rank: number; start: number; end: number;
  score: number | null; why: string | null; n: number | null;
  stat: string | null; flag: boolean;
};

const SPK_COLOURS = ["#25627F", "#8FA6B4", "#5F7F62", "#A08BA8"];
const mmss = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const hms = (t: number) =>
  `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const shade = (i: number, lo = 24, hi = 52) => {
  const l = lo + ((Math.sin(i * 1.9) + 1) / 2) * (hi - lo);
  return `linear-gradient(150deg,hsl(216 17% ${l}%),hsl(210 15% ${l + 15}%))`;
};

/* Memoized transcript line: re-renders only when its now/selection state
 * changes — the playhead ticking must not repaint 13k word spans. */
const Line = memo(function Line({
  line, now, selIn, selOut, spkColour, onLineClick, onWordClick,
}: {
  line: LineT; now: boolean; selIn: number | null; selOut: number | null;
  spkColour: string;
  onLineClick: (t: number) => void;
  onWordClick: (w: WordT) => void;
}) {
  return (
    <div className={`tx-l${now ? " now" : ""}`}
      onClick={(e) => {
        if ((e.target as Element).classList.contains("w")) return;
        onLineClick(line.start);
      }}>
      <div className="tx-t mono">{hms(line.start)}</div>
      <div className="tx-s" style={{ color: spkColour }}>{line.speaker ?? ""}</div>
      <div className="tx-x">
        {line.words.map((w, i) => (
          <span key={i}
            className={`w${selIn !== null && selOut !== null && w.s < selOut && w.e > selIn ? " insel" : ""}`}
            onClick={() => onWordClick(w)}>
            {w.w}{" "}
          </span>
        ))}
        {!line.words.length && <span style={{ color: "var(--faint)" }}>—</span>}
      </div>
    </div>
  );
});

export default function Find({
  video, lines, cuts, speakers, workerUp,
}: {
  video: { id: string; duration: number; srcAr: number };
  lines: LineT[]; cuts: CutT[]; speakers: string[]; workerUp: boolean;
}) {
  const router = useRouter();
  const DUR = video.duration;
  const pct = (t: number) => (t / DUR) * 100;

  const first = cuts[0];
  const [T, setT] = useState(first?.start ?? 0);
  const [IN, setIN] = useState(first?.start ?? 0);
  const [OUT, setOUT] = useState(first?.end ?? Math.min(8, DUR));
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  const [firstWord, setFirstWord] = useState<WordT | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoErr, setVideoErr] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef(0);
  const seekRaf = useRef<number | null>(null);
  const seekWant = useRef<number | null>(null);

  /* ---------- the one clock ---------- */
  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(DUR, t));
    setT(clamped);
    // player follows, one video seek per animation frame
    seekWant.current = clamped;
    if (seekRaf.current === null) {
      seekRaf.current = requestAnimationFrame(() => {
        seekRaf.current = null;
        const v = videoRef.current;
        if (v && seekWant.current !== null && Number.isFinite(v.duration))
          v.currentTime = seekWant.current;
      });
    }
  }, [DUR]);

  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };
  const tick = useCallback((ts: number) => {
    const v = videoRef.current;
    setT((prev) => {
      // video is the master clock when it plays; synthetic otherwise
      const next = v && !videoErr && Number.isFinite(v.duration)
        ? v.currentTime
        : prev + ((ts - lastTs.current) / 1000) * rate;
      lastTs.current = ts;
      if (next >= DUR) {
        setPlaying(false);
        stopRaf();
        return DUR;
      }
      rafRef.current = requestAnimationFrame(tick);
      return next;
    });
  }, [DUR, rate, videoErr]);

  const setPlay = useCallback((on: boolean) => {
    setPlaying(on);
    const v = videoRef.current;
    if (on) {
      if (v && !videoErr) {
        v.playbackRate = rate;
        void v.play().catch(() => setVideoErr(true));
      }
      lastTs.current = performance.now();
      stopRaf();
      rafRef.current = requestAnimationFrame(tick);
    } else {
      v?.pause();
      stopRaf();
    }
  }, [rate, tick, videoErr]);
  useEffect(() => () => stopRaf(), []);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  /* ---------- derived time state ---------- */
  const cutAt = useCallback(
    (t: number) => cuts.find((r) => t >= r.start && t < r.end),
    [cuts],
  );
  const activeCut = cutAt(T);
  const speakerAt = useMemo(() => {
    const line = lines.find((l) => T >= l.start && T < l.end);
    return line?.speaker ?? null;
  }, [lines, T]);
  const spkColour = (spk: string | null) =>
    spk ? SPK_COLOURS[speakers.indexOf(spk) % SPK_COLOURS.length] : "#5E6067";

  // nearest line to the playhead — used for now-highlight AND the scroll
  // fallback, so a playhead in a gap between lines still lands somewhere
  const nearestIdx = useMemo(() => {
    if (!lines.length) return -1;
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].start <= T) lo = mid; else hi = mid - 1;
    }
    const next = lo + 1 < lines.length ? lo + 1 : lo;
    return Math.abs(lines[next].start - T) < Math.abs(T - lines[lo].start) ? next : lo;
  }, [lines, T]);
  const nowIdx = nearestIdx >= 0 &&
    T >= lines[nearestIdx].start && T < lines[nearestIdx].end
    ? nearestIdx : -1;

  const txRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!follow || nearestIdx < 0) return;
    const box = txRef.current;
    const line = box?.querySelector<HTMLElement>(`[data-li="${nearestIdx}"]`);
    if (!box || !line) return;
    const bt = box.getBoundingClientRect().top;
    const lt = line.getBoundingClientRect().top;
    const target = box.scrollTop + (lt - bt) - box.clientHeight / 2 + line.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: playing ? "smooth" : "auto" });
  }, [nearestIdx, follow, playing]);

  /* ---------- selection ---------- */
  const allWords = useMemo(() => lines.flatMap((l) => l.words), [lines]);
  const nSelWords = useMemo(
    () => allWords.filter((w) => w.e > IN && w.s < OUT).length,
    [allWords, IN, OUT],
  );
  const pickedCut = cuts.find(
    (c) => Math.abs(IN - c.start) < 1.5 && Math.abs(OUT - c.end) < 1.5,
  );

  const loadCut = useCallback((c: CutT) => {
    setIN(c.start);
    setOUT(c.end);
    setFirstWord(null);
    seek(c.start);
  }, [seek]);

  const onWordClick = useCallback((w: WordT) => {
    setFirstWord((fw) => {
      if (fw === null) {
        setIN(w.s);
        setOUT(w.e);
        seek(w.s);
        return w;
      }
      const a = Math.min(fw.s, w.s);
      const b = Math.max(fw.e, w.e);
      setIN(a);
      setOUT(b);
      seek(a);
      return null;
    });
  }, [seek]);
  const onLineClick = useCallback((t: number) => seek(t), [seek]);

  /* ---------- scrubber frames (canvas grabs; gradient fallback) ---------- */
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!workerUp) return;
    let dead = false;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.src = `/api/media/${video.id}`;
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 36;
    const g = canvas.getContext("2d");
    const grabbed: string[] = [];
    const seekTo = (time: number) =>
      new Promise<void>((res, rej) => {
        v.onseeked = () => res();
        v.onerror = () => rej(new Error("video error"));
        v.currentTime = time;
      });
    (async () => {
      try {
        await new Promise<void>((res, rej) => {
          v.onloadedmetadata = () => res();
          v.onerror = () => rej(new Error("load failed"));
        });
        for (let i = 0; i < 46 && !dead; i++) {
          await seekTo(((i + 0.5) / 46) * DUR);
          g?.drawImage(v, 0, 0, 64, 36);
          grabbed.push(canvas.toDataURL("image/jpeg", 0.55));
        }
        if (!dead) setFrames(grabbed);
      } catch { /* keep gradient tiles */ }
    })();
    return () => { dead = true; v.src = ""; };
  }, [video.id, DUR, workerUp]);

  /* ---------- pointer plumbing (hardened window-listener drags) ---------- */
  const scrubRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<HTMLDivElement>(null);
  const selRange = useCallback((): [number, number] =>
    [Math.max(0, IN - 12), Math.min(DUR, OUT + 12)], [IN, OUT, DUR]);

  function dragScrub(e: React.PointerEvent) {
    if ((e.target as Element).closest("[data-cut]")) {
      const id = (e.target as Element).closest("[data-cut]")!.getAttribute("data-cut");
      const c = cuts.find((x) => x.id === id);
      if (c) loadCut(c);
      return;
    }
    const el = scrubRef.current!;
    const at = (x: number) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / r.width)) * DUR;
    };
    const pid = e.pointerId;
    try { e.currentTarget.setPointerCapture(pid); } catch {}
    seek(at(e.clientX));
    const onMove = (ev: PointerEvent) => { if (ev.pointerId === pid) seek(at(ev.clientX)); };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function dragHandle(mode: "l" | "r") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pid = e.pointerId;
      try { e.currentTarget.setPointerCapture(pid); } catch {}
      const [a, b] = selRange(); // window frozen for the drag
      const el = selRef.current!;
      const at = (x: number) => {
        const r = el.getBoundingClientRect();
        return a + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (b - a);
      };
      let lastIn = IN, lastOut = OUT;
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        const t = at(ev.clientX);
        if (mode === "l") {
          lastIn = Math.min(t, lastOut - 1);
          setIN(lastIn);
          seek(lastIn);      // dragging scrubs the player, iOS-style
        } else {
          lastOut = Math.max(t, lastIn + 1);
          setOUT(lastOut);
          seek(lastOut);
        }
        setFirstWord(null);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
  }

  function tapSel(e: React.PointerEvent) {
    if ((e.target as Element).closest(".hnd")) return;
    const [a, b] = selRange();
    const r = selRef.current!.getBoundingClientRect();
    seek(a + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (b - a));
  }

  async function createClip() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: video.id, start_s: IN, end_s: OUT,
          candidate_id: pickedCut?.id ?? null, name: null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      router.push(`/variants/${body.variant_id}`);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  }

  /* ---------- transcript blocks: cuts drawn around their lines ---------- */
  const blocks = useMemo(() => {
    const out: ({ kind: "line"; line: LineT; idx: number }
      | { kind: "cut"; cut: CutT; items: { line: LineT; idx: number }[] })[] = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i].start;
      const cut = cuts.find((r) => t >= r.start - 1 && t < r.end);
      if (cut) {
        const items: { line: LineT; idx: number }[] = [];
        while (i < lines.length && lines[i].start < cut.end) {
          items.push({ line: lines[i], idx: i });
          i++;
        }
        out.push({ kind: "cut", cut, items });
      } else {
        out.push({ kind: "line", line: lines[i], idx: i });
        i++;
      }
    }
    return out;
  }, [lines, cuts]);

  const [a0, a1] = selRange();
  const span = a1 - a0;
  const winL = ((IN - a0) / span) * 100;
  const winR = ((OUT - a0) / span) * 100;

  const renderLine = (line: LineT, idx: number) => (
    <div key={line.id} data-li={idx}>
      <Line
        line={line}
        now={idx === nowIdx}
        selIn={line.end > IN && line.start < OUT ? IN : null}
        selOut={line.end > IN && line.start < OUT ? OUT : null}
        spkColour={spkColour(line.speaker)}
        onLineClick={onLineClick}
        onWordClick={onWordClick}
      />
    </div>
  );

  return (
    <div>
      {/* player */}
      <div className="find-stage">
        <div className={`vid${activeCut ? " incut" : ""}`}
          style={{ aspectRatio: `${video.srcAr}` }}>
          {workerUp && !videoErr ? (
            <video ref={videoRef} src={`/api/media/${video.id}`}
              preload="metadata" playsInline
              onError={() => setVideoErr(true)}
              onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = T; }}
            />
          ) : (
            <div style={{ position: "absolute", inset: 0, display: "flex",
              alignItems: "center", justifyContent: "center", color: "#7C7E85",
              fontSize: 10.5, textAlign: "center", padding: 12 }}>
              {workerUp ? "source unavailable" : "worker not connected"}
            </div>
          )}
          <span className="live mono">{mmss(T)}</span>
          {speakerAt && (
            <span className="spk-badge" style={{ background: spkColour(speakerAt) }}>
              {speakerAt}
            </span>
          )}
          <div className="cutmark"><span>CUT {activeCut?.rank ?? ""}</span></div>
        </div>
      </div>
      <div className="find-transport">
        <button className="tbtn pri" aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlay(!playing)}>
          <svg viewBox="0 0 12 12">
            {playing
              ? <><rect x="2" y="1.5" width="3" height="9" /><rect x="7" y="1.5" width="3" height="9" /></>
              : <path d="M2 1l9 5-9 5z" />}
          </svg>
        </button>
        <button className="tbtn" aria-label="Stop"
          onClick={() => { setPlay(false); seek(0); }}>
          <svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" /></svg>
        </button>
        <span className="tc"><b className="mono">{mmss(T)}</b> / <span className="mono">{mmss(DUR)}</span></span>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 3 }}>
          {[0.5, 1, 2, 4].map((r) => (
            <button key={r} className="spd" data-on={rate === r ? "1" : undefined}
              onClick={() => setRate(r)}>{r}×</button>
          ))}
        </div>
      </div>

      {/* full-source scrubber */}
      <div className="scrub-wrap">
        <div className="scrub" ref={scrubRef} onPointerDown={dragScrub}>
          <div className="frames">
            {Array.from({ length: 46 }, (_, i) => (
              <i key={i} style={frames
                ? { backgroundImage: `url(${frames[i]})` }
                : { background: shade(i) }} />
            ))}
          </div>
          {cuts.map((c) => (
            <div key={c.id} className="cut" data-cut={c.id}
              data-on={activeCut?.id === c.id ? "1" : "0"}
              style={{ left: `${pct(c.start)}%`, width: `${Math.max(pct(c.end - c.start), 1.2)}%` }}
              title={`Cut ${c.rank} · ${hms(c.start)} → ${hms(c.end)}${c.n !== null ? ` · n=${c.n}` : ""}`}>
              <b>{c.rank}</b>
            </div>
          ))}
          <div className="ph" style={{ left: `${pct(T)}%` }} />
        </div>
        <div className="spkstrip">
          {lines.map((l) => l.speaker && (
            <div key={l.id} className="spk" style={{
              position: "absolute",
              left: `${pct(l.start)}%`,
              width: `${Math.max(pct(l.end - l.start), 0.1)}%`,
              background: spkColour(l.speaker),
            }} />
          ))}
        </div>
        <div className="scale">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f}>{mmss(DUR * f)}</span>
          ))}
        </div>
        <div className="legend">
          {speakers.map((s) => (
            <span key={s}><i style={{ background: spkColour(s) }} />{s}</span>
          ))}
          {cuts.length > 0 ? (
            <span><i style={{ background: "var(--signal)" }} />Machine-suggested cut — click to load</span>
          ) : (
            <span style={{ color: "var(--faint)" }}>
              No suggested cuts yet — the recommendation engine hasn&apos;t run on this video.
            </span>
          )}
        </div>
      </div>

      {/* selection strip */}
      <div className="selwrap">
        <div className="eyebrow" style={{ marginBottom: 4 }}>
          Selection — drag the handles, or pick words in the transcript
        </div>
        <div className="selstrip" ref={selRef} onPointerDown={tapSel}>
          <div className="frames">
            {Array.from({ length: 20 }, (_, i) => {
              const t = a0 + span * (i / 20);
              const ins = t >= IN && t <= OUT;
              return <i key={i} style={{ background: shade(i, ins ? 34 : 22, ins ? 60 : 40) }} />;
            })}
          </div>
          <div className="mask" style={{ left: 0, width: `${winL}%` }} />
          <div className="mask" style={{ right: 0, width: `${100 - winR}%` }} />
          <div className="win" style={{ left: `${winL}%`, width: `${winR - winL}%` }}>
            <div className="hnd l" role="slider" aria-label="Selection start"
              onPointerDown={dragHandle("l")} />
            <div className="hnd r" role="slider" aria-label="Selection end"
              onPointerDown={dragHandle("r")} />
          </div>
          <div className="ph" style={{ left: `${((Math.min(Math.max(T, a0), a1) - a0) / span) * 100}%` }} />
        </div>
        <div className="scale"><span>{mmss(a0)}</span><span>{mmss(a1)}</span></div>
        <div className="selmeta-bar">
          <span className="m">
            {hms(IN)} → {hms(OUT)}{" "}
            <em>· {(OUT - IN).toFixed(1)}s · {nSelWords} word{nSelWords === 1 ? "" : "s"}
              {pickedCut ? ` · cut ${pickedCut.rank}` : ""}
              {firstWord ? " · click the last word" : ""}</em>
          </span>
          <span style={{ flex: 1 }} />
          {error && <span style={{ color: "#FFB4A9", fontSize: 11 }}>{error}</span>}
          <button className="ghostbtn" disabled={busy}
            onClick={() => { setFirstWord(null); setIN(T); setOUT(Math.min(T + 8, DUR)); }}>
            Clear
          </button>
          <button className="gobtn" disabled={busy || OUT - IN < 1}
            onClick={() => void createClip()}>
            {busy ? "Creating…" : "Create clip"}
          </button>
        </div>
      </div>

      {/* transcript */}
      <div className="txhead">
        <h2>Transcript</h2>
        <label className="follow">
          <input type="checkbox" checked={follow}
            onChange={(e) => setFollow(e.target.checked)} />
          Follow playhead
        </label>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--muted)" }}>
          Click a line to scrub. Click a word, then another, to select.
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="card qempty">
          No transcript yet — this video hasn&apos;t finished processing.
        </div>
      ) : (
        <div className="txbox" ref={txRef}>
          {blocks.map((b) =>
            b.kind === "line" ? (
              renderLine(b.line, b.idx)
            ) : (
              <div key={`cut-${b.cut.id}`}
                className={`cutbox${pickedCut?.id === b.cut.id ? " picked" : ""}`}>
                <div className="cl">
                  <b>CUT {b.cut.rank}</b>
                  <span>
                    {b.cut.flag ? "compliance" :
                      b.cut.score !== null ? `score ${b.cut.score.toFixed(2)}` : "unscored"}
                    {" · "}
                    {b.cut.n !== null
                      ? `n=${b.cut.n}${b.cut.stat ? ` · ${b.cut.stat}` : ""}`
                      : "n=? · evidence not recorded"}
                  </span>
                  <button onClick={() => loadCut(b.cut)}>Load</button>
                </div>
                {b.cut.why && <div className="why">{b.cut.why}</div>}
                {b.items.map(({ line, idx }) => renderLine(line, idx))}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
