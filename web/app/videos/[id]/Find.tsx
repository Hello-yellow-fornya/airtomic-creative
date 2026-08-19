"use client";

/** 02 Find — docs/find-screen-redesign.html (v11) on real data.
 *
 * One clock: scrubbing, cut blocks, strip handles, transcript drags and
 * playback all route through seek().
 *
 * Text selection works like highlighting text: press on a word, drag
 * across lines, release. The four hard-won mechanisms from the prototype
 * are ported as implemented there:
 *  a) hit detection is GEOMETRIC — nearest word by offsets with vertical
 *     distance dominating — never elementFromPoint, so gutters, gaps and
 *     line-ends don't drop the gesture;
 *  b) the transcript DOM is never rebuilt mid-gesture — during a drag we
 *     only toggle word classes and move the two handle pills, throttled
 *     to one update per rAF, with word geometry cached at drag start
 *     (React state commits once, on release);
 *  c) the detail strip's view range is frozen for the duration of any
 *     drag so the pixel-to-time mapping can't slide under the cursor;
 *  d) listeners live on the container and window, so leaving the box
 *     mid-drag doesn't cancel, and dragging near the edges auto-scrolls.
 *
 * Adaptation, noted for review: the selection pills are absolutely
 * positioned overlays placed at the edge words' exact coordinates rather
 * than inline <b> nodes spliced between words — identical look and hit
 * behaviour, but React reconciliation never fights the mid-drag moves. */

import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useRouter } from "next/navigation";

type WordT = { w: string; s: number; e: number };
type LineT = { id: string; speaker: string | null; start: number; end: number; words: WordT[] };
type CutT = {
  id: string; rank: number; start: number; end: number;
  score: number | null; why: string | null; n: number | null;
  stat: string | null; evidence: string | null; flag: boolean;
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

const Line = memo(function Line({
  line, now, selIn, selOut, spkColour, onLineClick,
}: {
  line: LineT; now: boolean; selIn: number | null; selOut: number | null;
  spkColour: string;
  onLineClick: (t: number) => void;
}) {
  return (
    <div className={`tx-l${now ? " now" : ""}`}
      onClick={(e) => {
        if ((e.target as Element).closest(".w,.thandle")) return;
        onLineClick(line.start);
      }}>
      <div className="tx-t mono">{hms(line.start)}</div>
      <div className="tx-s" style={{ color: spkColour }}>{line.speaker ?? ""}</div>
      <div className="tx-x">
        {line.words.map((w, i) => (
          <span key={i}
            data-wt={w.s} data-we={w.e}
            className={`w${selIn !== null && selOut !== null && w.s < selOut && w.e > selIn ? " insel" : ""}`}>
            {w.w}{" "}
          </span>
        ))}
        {!line.words.length && <span style={{ color: "var(--faint)" }}>—</span>}
      </div>
    </div>
  );
});

type Geo = { el: HTMLElement; s: number; e: number; top: number; bottom: number; left: number; right: number; on: boolean };

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoErr, setVideoErr] = useState(false);
  const [recState, setRecState] = useState<"idle" | "queued" | "error">("idle");
  const [recErr, setRecErr] = useState<string | null>(null);

  // Queue content-based scoring for a video that predates the recommend
  // stage; poll the server component a few times so results appear
  // without a manual refresh.
  const queueRecommend = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${video.id}/recommend`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setRecState("queued");
      let polls = 0;
      const t = setInterval(() => {
        router.refresh();
        if (++polls >= 12) clearInterval(t);
      }, 10_000);
    } catch (e) {
      setRecErr(e instanceof Error ? e.message : String(e));
      setRecState("error");
    }
  }, [video.id, router]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef(0);
  const seekRaf = useRef<number | null>(null);
  const seekWant = useRef<number | null>(null);
  const textDrag = useRef<null | "new" | "l" | "r">(null);

  /* ---------- the one clock ---------- */
  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(DUR, t));
    setT(clamped);
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
      // don't force transcript repaints while a text drag holds the DOM
      if (textDrag.current) {
        lastTs.current = ts;
        rafRef.current = requestAnimationFrame(tick);
        return prev;
      }
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

  /* ---------- derived ---------- */
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
    // follow the playhead; if it sits in a gap, the nearest line — and
    // never while a drag holds the view
    if (!follow || nearestIdx < 0 || textDrag.current) return;
    const box = txRef.current;
    const line = box?.querySelector<HTMLElement>(`[data-li="${nearestIdx}"]`);
    if (!box || !line) return;
    const bt = box.getBoundingClientRect().top;
    const lt = line.getBoundingClientRect().top;
    const target = box.scrollTop + (lt - bt) - box.clientHeight / 2 + line.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: playing ? "smooth" : "auto" });
  }, [nearestIdx, follow, playing]);

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
    seek(c.start);
  }, [seek]);

  /* ---------- detail strip: window around the playhead ---------- */
  const frozenRange = useRef<[number, number] | null>(null);
  const computeRange = useCallback((t: number, a: number, b: number): [number, number] => {
    const selNear = b > t - 90 && a < t + 90;
    const span = selNear ? Math.max(50, (b - a) + 24) : 50;
    let lo, hi;
    if (selNear) {
      const mid = (Math.min(a, t) + Math.max(b, t)) / 2;
      lo = mid - span / 2; hi = mid + span / 2;
    } else {
      lo = t - span / 2; hi = t + span / 2;
    }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > DUR) { lo -= hi - DUR; hi = DUR; }
    return [Math.max(0, lo), Math.min(DUR, hi)];
  }, [DUR]);
  const selRange = useCallback((): [number, number] =>
    frozenRange.current ?? computeRange(T, IN, OUT), [computeRange, T, IN, OUT]);

  /* ---------- text selection: press, drag across lines, release ---------- */
  const wordGeo = useRef<Geo[] | null>(null);
  const inR = useRef(IN);
  const outR = useRef(OUT);
  useEffect(() => { inR.current = IN; }, [IN]);
  useEffect(() => { outR.current = OUT; }, [OUT]);
  const anchorRef = useRef<{ s: number; e: number } | null>(null);
  const dragXY = useRef({ x: 0, y: 0 });
  const autoScroll = useRef(0);
  const dragRaf = useRef<number | null>(null);
  const followWas = useRef(true);
  const hLRef = useRef<HTMLDivElement>(null);
  const hRRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);
  const winRef = useRef<HTMLDivElement>(null);
  const maskLRef = useRef<HTMLDivElement>(null);
  const maskRRef = useRef<HTMLDivElement>(null);

  const buildGeo = useCallback((): Geo[] => {
    const box = txRef.current!;
    const br = box.getBoundingClientRect();
    const st = box.scrollTop;
    const geo: Geo[] = [];
    box.querySelectorAll<HTMLElement>("[data-wt]").forEach((el) => {
      const r = el.getBoundingClientRect();
      geo.push({
        el,
        s: parseFloat(el.dataset.wt!),
        e: parseFloat(el.dataset.we!),
        top: r.top - br.top + st,
        bottom: r.bottom - br.top + st,
        left: r.left - br.left,
        right: r.right - br.left,
        on: el.classList.contains("insel"),
      });
    });
    wordGeo.current = geo;
    return geo;
  }, []);

  /** Geometric nearest-word hit test — vertical distance dominates so the
   * gesture locks to the correct line before choosing the word. */
  const wordAt = useCallback((clientX: number, clientY: number): Geo | null => {
    const geo = wordGeo.current ?? buildGeo();
    if (!geo.length) return null;
    const box = txRef.current!;
    const br = box.getBoundingClientRect();
    const x = clientX - br.left;
    const y = clientY - br.top + box.scrollTop;
    let best: Geo | null = null, bd = Infinity;
    for (const g of geo) {
      const dy = y < g.top ? g.top - y : y > g.bottom ? y - g.bottom : 0;
      const dx = x < g.left ? g.left - x : x > g.right ? x - g.right : 0;
      const d = dy * 1000 + dx;
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }, [buildGeo]);

  /** Position the two overlay pills at the selected run's edges. */
  const placeHandles = useCallback(() => {
    const geo = wordGeo.current;
    const hL = hLRef.current, hR = hRRef.current;
    if (!hL || !hR) return;
    let firstG: Geo | null = null, lastG: Geo | null = null;
    if (geo) {
      for (const g of geo) {
        if (g.on) { if (!firstG) firstG = g; lastG = g; }
      }
    }
    if (!firstG || !lastG) {
      hL.dataset.hide = "1"; hR.dataset.hide = "1";
      return;
    }
    delete hL.dataset.hide; delete hR.dataset.hide;
    hL.style.top = `${firstG.top + (firstG.bottom - firstG.top) / 2 - 9.5}px`;
    hL.style.left = `${firstG.left - 11}px`;
    hR.style.top = `${lastG.top + (lastG.bottom - lastG.top) / 2 - 9.5}px`;
    hR.style.left = `${lastG.right + 2}px`;
  }, []);

  /** In-place repaint during a drag: word classes, pills, meta, strip
   * window — no React state, no DOM rebuild. */
  const fastPaint = useCallback(() => {
    const geo = wordGeo.current;
    if (!geo) return;
    const a = inR.current, b = outR.current;
    let n = 0;
    for (const g of geo) {
      const ins = g.s < b && g.e > a;
      if (ins) n++;
      if (ins !== g.on) { g.el.classList.toggle("insel", ins); g.on = ins; }
    }
    placeHandles();
    if (metaRef.current) {
      metaRef.current.innerHTML =
        `${hms(a)} → ${hms(b)} <em>· ${(b - a).toFixed(1)}s · ${n} word${n === 1 ? "" : "s"}</em>`;
    }
    const range = frozenRange.current;
    if (range && winRef.current && maskLRef.current && maskRRef.current) {
      const [ra, rb] = range;
      const sp = rb - ra;
      const l = Math.max(((a - ra) / sp) * 100, 0);
      const r = Math.min(((b - ra) / sp) * 100, 100);
      winRef.current.style.left = `${l}%`;
      winRef.current.style.width = `${Math.max(r - l, 0)}%`;
      maskLRef.current.style.width = `${l}%`;
      maskRRef.current.style.width = `${100 - r}%`;
    }
  }, [placeHandles]);

  const applyDrag = useCallback(() => {
    dragRaf.current = null;
    const mode = textDrag.current;
    if (!mode) return;
    const g = wordAt(dragXY.current.x, dragXY.current.y);
    if (g) {
      const anchor = anchorRef.current;
      if (mode === "new" && anchor) {
        inR.current = Math.min(anchor.s, g.s);
        outR.current = Math.max(anchor.e, g.e);
      } else if (mode === "l") {
        inR.current = Math.min(g.s, outR.current - 0.4);
      } else {
        outR.current = Math.max(g.e, inR.current + 0.4);
      }
      fastPaint();
    }
    if (autoScroll.current && txRef.current)
      txRef.current.scrollTop += autoScroll.current;
    if (textDrag.current) dragRaf.current = requestAnimationFrame(applyDrag);
  }, [wordAt, fastPaint]);

  const endTextDrag = useCallback(() => {
    if (!textDrag.current) return;
    const wasHandle = textDrag.current !== "new";
    textDrag.current = null;
    anchorRef.current = null;
    autoScroll.current = 0;
    frozenRange.current = null;
    if (dragRaf.current) { cancelAnimationFrame(dragRaf.current); dragRaf.current = null; }
    document.body.style.userSelect = "";
    hLRef.current?.classList.remove("dragging");
    hRRef.current?.classList.remove("dragging");
    setFollow(followWas.current);
    // commit once — the full repaint happens here, on release
    setIN(inR.current);
    setOUT(outR.current);
    seek(inR.current);
    void wasHandle;
  }, [seek]);

  const startTextDrag = useCallback((mode: "new" | "l" | "r", e: { clientX: number; clientY: number }) => {
    textDrag.current = mode;
    frozenRange.current = computeRange(T, inR.current, outR.current);
    followWas.current = follow;
    setFollow(false);
    buildGeo();
    dragXY.current = { x: e.clientX, y: e.clientY };
    document.body.style.userSelect = "none";
    if (!dragRaf.current) dragRaf.current = requestAnimationFrame(applyDrag);
  }, [computeRange, T, follow, buildGeo, applyDrag]);

  // container-level pointerdown; move/up on window so leaving the box
  // never cancels the gesture
  useEffect(() => {
    const box = txRef.current;
    if (!box) return;
    const onDown = (e: PointerEvent) => {
      const h = (e.target as Element).closest<HTMLElement>(".thandle");
      if (h) {
        h.classList.add("dragging");
        startTextDrag(h.dataset.h as "l" | "r", e);
        e.preventDefault();
        return;
      }
      const w = (e.target as Element).closest<HTMLElement>("[data-wt]");
      if (w) {
        const s = parseFloat(w.dataset.wt!);
        const en = parseFloat(w.dataset.we!);
        anchorRef.current = { s, e: en };
        inR.current = s;
        outR.current = en;
        startTextDrag("new", e);
        fastPaint();
        e.preventDefault();
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!textDrag.current) return;
      dragXY.current = { x: e.clientX, y: e.clientY };
      const r = box.getBoundingClientRect(), edge = 34;
      autoScroll.current =
        e.clientY < r.top + edge ? -14 : e.clientY > r.bottom - edge ? 14 : 0;
    };
    const onUp = () => endTextDrag();
    box.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      box.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [startTextDrag, endTextDrag, fastPaint]);

  // reposition the pills whenever the committed selection re-renders
  useEffect(() => {
    if (textDrag.current) return;
    const id = requestAnimationFrame(() => {
      buildGeo();
      placeHandles();
    });
    return () => cancelAnimationFrame(id);
  }, [IN, OUT, lines, buildGeo, placeHandles, nowIdx]);

  /* ---------- scrubber frames ---------- */
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
      } catch { /* gradient fallback */ }
    })();
    return () => { dead = true; v.src = ""; };
  }, [video.id, DUR, workerUp]);

  /* ---------- scrubber + strip gestures ---------- */
  const scrubRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<HTMLDivElement>(null);

  function dragScrub(e: React.PointerEvent) {
    const cutEl = (e.target as Element).closest("[data-cut]");
    if (cutEl) {
      const c = cuts.find((x) => x.id === cutEl.getAttribute("data-cut"));
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

  function dragStripHandle(mode: "l" | "r") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const pid = e.pointerId;
      try { e.currentTarget.setPointerCapture(pid); } catch {}
      const range = selRange();
      frozenRange.current = range;   // freeze the mapping for the gesture
      const [a, b] = range;
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
          lastIn = Math.max(a, Math.min(t, lastOut - 1));
          setIN(lastIn);
          seek(lastIn);              // dragging scrubs the player
        } else {
          lastOut = Math.min(b, Math.max(t, lastIn + 1));
          setOUT(lastOut);
          seek(lastOut);
        }
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        frozenRange.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
  }

  function stripSurface(e: React.PointerEvent) {
    if ((e.target as Element).closest(".hnd")) return;
    const range = selRange();
    frozenRange.current = range;
    const [a, b] = range;
    const el = selRef.current!;
    const at = (x: number) => {
      const r = el.getBoundingClientRect();
      return a + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (b - a);
    };
    const pid = e.pointerId;
    try { e.currentTarget.setPointerCapture(pid); } catch {}
    const anchor = at(e.clientX);
    seek(anchor);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const t = at(ev.clientX);
      if (Math.abs(t - anchor) > 0.6) {   // drag across the strip selects
        setIN(Math.min(anchor, t));
        setOUT(Math.max(anchor, t));
        seek(t);
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      frozenRange.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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

  const [ra, rb] = selRange();
  const rspan = rb - ra;
  const rawL = ((IN - ra) / rspan) * 100;
  const rawR = ((OUT - ra) / rspan) * 100;
  const selVisible = OUT > ra && IN < rb;
  const winL = Math.max(rawL, 0);
  const winR = Math.min(rawR, 100);

  const onLineClick = useCallback((t: number) => seek(t), [seek]);
  const renderLine = (line: LineT, idx: number) => (
    <div key={line.id} data-li={idx}>
      <Line
        line={line}
        now={idx === nowIdx}
        selIn={line.end > IN && line.start < OUT ? IN : null}
        selOut={line.end > IN && line.start < OUT ? OUT : null}
        spkColour={spkColour(line.speaker)}
        onLineClick={onLineClick}
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
            <span style={{ color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 8 }}>
              {recState === "queued"
                ? "Scoring queued — suggestions appear here when it finishes (about a minute)."
                : recState === "error"
                  ? `Couldn't queue scoring: ${recErr}`
                  : "No suggested cuts yet."}
              {recState === "idle" && (
                <button className="btn ghost sm" onClick={() => void queueRecommend()}>
                  Generate suggested cuts
                </button>
              )}
            </span>
          )}
        </div>
      </div>

      {/* detail strip: window around the playhead */}
      <div className="selwrap">
        <div className="eyebrow" style={{ marginBottom: 4 }}>
          Selection — drag across the strip or the transcript; handles adjust
        </div>
        <div className={`selstrip${selVisible ? " hassel" : ""}`} ref={selRef}
          onPointerDown={stripSurface}>
          <div className="frames">
            {Array.from({ length: 20 }, (_, i) => {
              const t = ra + rspan * (i / 20);
              const ins = t >= IN && t <= OUT;
              return <i key={i} style={{ background: shade(i, ins ? 34 : 22, ins ? 60 : 40) }} />;
            })}
          </div>
          <div className="mask" ref={maskLRef}
            style={{ left: 0, width: selVisible ? `${winL}%` : 0 }} />
          <div className="mask" ref={maskRRef}
            style={{ right: 0, width: selVisible ? `${100 - winR}%` : 0 }} />
          <div className="win" ref={winRef}
            style={{ left: `${winL}%`, width: `${Math.max(winR - winL, 0)}%`,
              display: selVisible ? "" : "none" }}>
            <div className="hnd l" role="slider" aria-label="Selection start"
              style={{ display: rawL < 0 ? "none" : "" }}
              onPointerDown={dragStripHandle("l")} />
            <div className="hnd r" role="slider" aria-label="Selection end"
              style={{ display: rawR > 100 ? "none" : "" }}
              onPointerDown={dragStripHandle("r")} />
          </div>
          <div className="ph" style={{ left: `${((Math.min(Math.max(T, ra), rb) - ra) / rspan) * 100}%` }} />
          <span className="selhint">drag across to select</span>
        </div>
        <div className="scale"><span>{mmss(ra)}</span><span>{mmss(rb)}</span></div>
        <div className="selmeta-bar">
          {/* keyed so React remounts after a text drag's innerHTML writes —
              otherwise its text-node refs are detached and updates vanish */}
          <span className="m" ref={metaRef} key={`m-${IN.toFixed(3)}-${OUT.toFixed(3)}`}>
            {hms(IN)} → {hms(OUT)}{" "}
            <em>· {(OUT - IN).toFixed(1)}s · {nSelWords} word{nSelWords === 1 ? "" : "s"}
              {pickedCut ? ` · cut ${pickedCut.rank}` : ""}</em>
          </span>
          <span style={{ flex: 1 }} />
          {error && <span style={{ color: "#FFB4A9", fontSize: 11 }}>{error}</span>}
          <button className="ghostbtn" disabled={busy}
            onClick={() => { setIN(T); setOUT(Math.min(T + 8, DUR)); }}>
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
          Drag across the text to select, like highlighting. Drag the black
          handles to adjust.
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
                      : b.cut.evidence ?? "n=? · evidence not recorded"}
                  </span>
                  <button onClick={() => loadCut(b.cut)}>Load</button>
                </div>
                {b.cut.why && <div className="why">{b.cut.why}</div>}
                {b.items.map(({ line, idx }) => renderLine(line, idx))}
              </div>
            ),
          )}
          {/* selection pills — overlays at the edge words' coordinates */}
          <div className="thandle" data-h="l" ref={hLRef} data-hide="1" />
          <div className="thandle" data-h="r" ref={hRRef} data-hide="1" />
        </div>
      )}
    </div>
  );
}
