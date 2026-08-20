"use client";

/** Clip builder — the prototype's 04 BUILD screen wired to real data.
 * Direct-manipulation crop over the actual footage, filmstrip trim,
 * transport, live caption preview from real word timings, drag-reorder
 * scene rail, collapsible sidebar, variant rail with naming popover.
 *
 * Yellow is reserved for machine claims; every control here is a human
 * action, so the only yellow on this screen is the trim handles' hardware
 * (prototype chrome) and nothing interactive gains a yellow fill. */

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useRouter } from "next/navigation";

type VariantInfo = {
  id: string; label: string; name: string; status: string;
  clipId: string; clipName: string | null; clipIn: number; clipOut: number;
  presetId: string | null; overrides: Record<string, unknown>;
  videoId: string; videoDuration: number; srcW: number; srcH: number;
};
type Sibling = { id: string; label: string; name: string; status: string; nScenes: number };
type Scene = {
  id: string; idx: number; layout: string; in: number | null; out: number | null;
  dur: number | null; lifted: boolean; asset: string | null;
  splitRatio: number; audio: string;
};
type Crop = { sceneId: string; ratio: string; x: number; y: number; w: number; h: number };
type Asset = { id: string; name: string; kind: string };
type Preset = { id: string; name: string; is_default: boolean; config: Record<string, unknown> };
type Word = { w: string; s: number; e: number };
type Ov = {
  id: string; text: string; start: number; end: number;
  position: string; style: string;
};
type OvStyle = { key: string; name: string; config: Record<string, unknown> };

/** Mirror of worker/overlays.position_y — preview and burn must agree. */
function ovY(position: string, ratio: string): number {
  const safe = SAFE[ratio] ?? { t: 8, b: 8, r: 0 };
  if (position === "top") return Math.min(safe.t / 100 + 0.06, 0.30);
  if (position === "center") return 0.5;
  return Math.max(0.70, 1 - safe.b / 100 - 0.08);
}
/** Mirror of worker/overlays.subtitle_shift_for (collision push-down). */
function subVpWithOverlays(
  t0: number, t1: number, ovs: Ov[], ratio: string, subVp: number,
): number {
  const safe = SAFE[ratio] ?? { t: 8, b: 8, r: 0 };
  const cap = 1 - safe.b / 100 + 0.04;
  let lowest: number | null = null;
  for (const o of ovs) {
    if (o.end <= t0 || o.start >= t1) continue;
    const y = ovY(o.position, ratio);
    const band: [number, number] = [y - 0.05, y + 0.05];
    if (band[0] < subVp + 0.05 && band[1] > subVp - 0.05)
      if (lowest === null || band[1] > lowest) lowest = band[1];
  }
  return lowest === null ? subVp : Math.min(lowest + 0.07, cap);
}

const RATIOS: Record<string, { ar: number; label: string; px: string; use: string }> = {
  "9x16": { ar: 9 / 16, label: "9:16", px: "1080×1920", use: "Reels, Stories" },
  "4x5": { ar: 4 / 5, label: "4:5", px: "1080×1350", use: "Feed" },
  "1x1": { ar: 1, label: "1:1", px: "1080×1080", use: "Feed, Explore" },
  "1.91x1": { ar: 1.91, label: "1.91:1", px: "1200×628", use: "PMax, landscape" },
};
const SAFE: Record<string, { t: number; b: number; r: number }> = {
  "9x16": { t: 14, b: 16, r: 12 },
  "4x5": { t: 5, b: 9, r: 0 },
  "1x1": { t: 9, b: 11, r: 0 },
  "1.91x1": { t: 8, b: 8, r: 8 },
};
const LY_NAME: Record<string, string> = {
  full: "Full", split_product: "Product", split_speakers: "Speakers", card: "End card",
};
const NAME_SUGS = ["Emotional hook", "Contrarian open", "Question open", "Product first", "Short cut", "No end card"];
const MIN_CLIP = 3;

type Style = {
  fs: number; ol: number; vp: number; wpl: number; hl: string;
  caps: boolean; box: boolean;
};

function cropBox(srcAr: number, ratio: string) {
  const ar = RATIOS[ratio].ar;
  return ar < srcAr
    ? { w: ar / srcAr, h: 1, axis: "x" as const }
    : { w: 1, h: srcAr / ar, axis: "y" as const };
}
const sceneDur = (s: Scene) =>
  s.layout === "card" ? (s.dur ?? 2.5) : (s.out ?? 0) - (s.in ?? 0);

const fmt = (t: number) => {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  const ms = String(Math.round((t % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
};
const mmss = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const clock = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}`;

export default function Builder({
  variant, siblings, scenes, crops, assets, presets, words, workerUp,
  overlays, overlayStyles, renderStale,
}: {
  variant: VariantInfo; siblings: Sibling[]; scenes: Scene[]; crops: Crop[];
  assets: Asset[]; presets: Preset[]; words: Word[]; workerUp: boolean;
  overlays: Ov[]; overlayStyles: OvStyle[]; renderStale: boolean;
}) {
  const router = useRouter();
  const srcAr = variant.srcW / Math.max(variant.srcH, 1);
  const draft = variant.status === "draft";

  const [sel, setSel] = useState(0);
  const scene = scenes[Math.min(sel, Math.max(scenes.length - 1, 0))] as Scene | undefined;

  const [bRatio, setBRatio] = useState("9x16");
  const [zones, setZones] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ----- trim state (persisted on handle release) -----
  const [IN, setIN] = useState(variant.clipIn);
  const [OUT, setOUT] = useState(variant.clipOut);
  const ctx = useMemo<[number, number]>(() => {
    const end = variant.videoDuration || variant.clipOut + 8;
    return [Math.max(0, variant.clipIn - 8), Math.min(end, variant.clipOut + 8)];
  // context window stays fixed for the session, like the prototype
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.videoId]);

  // ----- subtitle style -----
  const activePreset =
    presets.find((p) => p.id === variant.presetId) ??
    presets.find((p) => p.is_default) ?? presets[0];
  const seedStyle = useCallback((): Style => {
    const c = { ...(activePreset?.config ?? {}), ...variant.overrides } as Record<string, unknown>;
    return {
      fs: Number(c.fs ?? 30), ol: Number(c.ol ?? 3), vp: Number(c.vp ?? 72),
      wpl: Number(c.wpl ?? 4), hl: String(c.hl ?? "#FFC629"),
      caps: !!c.caps, box: !!c.box,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [S, setS] = useState<Style>(seedStyle);
  const [presetId, setPresetId] = useState<string | null>(activePreset?.id ?? null);
  const [styleOv, setStyleOv] = useState<Record<string, unknown>>(() => {
    const o = { ...variant.overrides };
    delete o.fixes;
    return o;
  });
  const [fixes, setFixes] = useState<Record<string, string>>(
    () => ({ ...((variant.overrides.fixes as Record<string, string>) ?? {}) }),
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----- text overlays (a layer above subtitles) -----
  const [ovs, setOvs] = useState<Ov[]>(overlays);
  const [stale, setStale] = useState(renderStale);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ text: string; angle: string }[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const ovSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const styleCfg = useCallback(
    (key: string) => overlayStyles.find((s) => s.key === key)?.config ?? {},
    [overlayStyles]);

  async function addOverlay() {
    const res = await fetch(`/api/variants/${variant.id}/overlays`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "New overlay", start_s: 0, end_s: Math.min(3, clipDur) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(body.error ?? res.statusText); return; }
    setOvs((o) => [...o, {
      id: body.overlay.id, text: body.overlay.text,
      start: parseFloat(body.overlay.start_s), end: parseFloat(body.overlay.end_s),
      position: body.overlay.position, style: body.overlay.style,
    }]);
    setStale(true);
  }
  function patchOverlayLocal(id: string, patch: Partial<Ov>) {
    setOvs((o) => o.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  async function patchOverlay(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/overlays/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) setStale(true);
    else setNote((await res.json().catch(() => ({}))).error ?? "overlay save failed");
  }
  function patchOverlayDebounced(id: string, patch: Record<string, unknown>) {
    clearTimeout(ovSaveTimers.current[id]);
    ovSaveTimers.current[id] = setTimeout(() => void patchOverlay(id, patch), 500);
  }
  async function delOverlay(id: string) {
    setOvs((o) => o.filter((x) => x.id !== id));
    setStale(true);
    await fetch(`/api/overlays/${id}`, { method: "DELETE" });
  }
  async function suggestHook(ov: Ov) {
    setSuggestFor(ov.id);
    setSuggestions(null);
    setSuggesting(true);
    try {
      const res = await fetch(`/api/variants/${variant.id}/suggest-hook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_s: ov.start, end_s: ov.end }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setSuggestions(body.options ?? []);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setSuggestFor(null);
    } finally {
      setSuggesting(false);
    }
  }

  // ----- playback -----
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0); // clip-relative
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [videoErr, setVideoErr] = useState(false);
  const rafRef = useRef<number | null>(null);
  const clipDur = OUT - IN;

  const stopRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };
  const tickRaf = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const rel = v.currentTime - IN;
    if (rel >= OUT - IN) {
      v.pause();
      v.currentTime = OUT;
      setT(OUT - IN);
      setPlaying(false);
      stopRaf();
      return;
    }
    setT(Math.max(0, rel));
    rafRef.current = requestAnimationFrame(tickRaf);
  }, [IN, OUT]);

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.currentTime < IN || v.currentTime >= OUT - 0.05) v.currentTime = IN;
    v.playbackRate = rate;
    v.play().then(() => {
      setPlaying(true);
      stopRaf();
      rafRef.current = requestAnimationFrame(tickRaf);
    }).catch(() => setVideoErr(true));
  }, [IN, OUT, rate, tickRaf]);
  const pause = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
    stopRaf();
  }, []);
  const seek = useCallback((rel: number) => {
    const v = videoRef.current;
    const clamped = Math.max(0, Math.min(OUT - IN, rel));
    if (v) v.currentTime = IN + clamped;
    setT(clamped);
  }, [IN, OUT]);
  useEffect(() => () => stopRaf(), []);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  // space toggles playback
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag)) return;
      e.preventDefault();
      if (playing) pause(); else play();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [playing, play, pause]);

  // ----- captions: real word timings, ASS-style line hold -----
  const clipWords = useMemo(
    () => words.filter((w) => w.e > IN && w.s < OUT),
    [words, IN, OUT],
  );
  const lines = useMemo(() => {
    const out: Word[][] = [];
    for (let i = 0; i < clipWords.length; i += S.wpl)
      out.push(clipWords.slice(i, i + S.wpl));
    return out;
  }, [clipWords, S.wpl]);
  const tSrc = IN + t;
  const lineIdx = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--)
      if (tSrc >= lines[i][0].s) return i;
    return -1;
  }, [lines, tSrc]);
  const line = lineIdx >= 0 ? lines[lineIdx] : null;

  // ----- crop -----
  const box = cropBox(srcAr, bRatio);
  const [localCrops, setLocalCrops] = useState<Record<string, { x: number; y: number }>>({});
  const cropKey = scene ? `${scene.id}:${bRatio}` : "";
  const storedCrop = scene
    ? crops.find((c) => c.sceneId === scene.id && c.ratio === bRatio)
    : undefined;
  const cropPos = localCrops[cropKey] ??
    (storedCrop
      ? { x: storedCrop.x, y: storedCrop.y }
      : { x: box.axis === "x" ? (1 - box.w) / 2 : 0, y: box.axis === "y" ? (1 - box.h) / 2 : 0 });
  const hasCropSet = (sceneId: string, ratio: string) =>
    !!localCrops[`${sceneId}:${ratio}`] || crops.some((c) => c.sceneId === sceneId && c.ratio === ratio);

  const srcRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  async function saveCrop(pos: { x: number; y: number }) {
    if (!scene) return;
    const crop = box.axis === "x"
      ? { x: pos.x, y: 0, w: box.w, h: box.h }
      : { x: 0, y: pos.y, w: box.w, h: box.h };
    await fetch(`/api/scenes/${scene.id}/crop`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratio: bRatio, ...crop }),
    });
    router.refresh();
  }

  /** Drag state lives in a ref, not React state, so the pointermove path
   * has no render round-trip to race against. Move/up listeners attach to
   * WINDOW for the duration of the drag — the drag keeps working even if
   * setPointerCapture throws (some input devices) or the pointer leaves
   * the element. The prototype's cropDrag, hardened. */
  const dragRef = useRef<{
    id: number; px: number; py: number; x: number; y: number;
    last: { x: number; y: number };
  } | null>(null);

  function onCropDown(e: React.PointerEvent) {
    if (!scene || scene.layout === "card") return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    dragRef.current = {
      id: e.pointerId, px: e.clientX, py: e.clientY,
      x: cropPos.x, y: cropPos.y, last: { x: cropPos.x, y: cropPos.y },
    };
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.id || !srcRef.current) return;
      const r = srcRef.current.getBoundingClientRect();
      const next = box.axis === "x"
        ? { x: Math.max(0, Math.min(1 - box.w, d.x + (ev.clientX - d.px) / r.width)), y: 0 }
        : { x: 0, y: Math.max(0, Math.min(1 - box.h, d.y + (ev.clientY - d.py) / r.height)) };
      d.last = next;
      setLocalCrops((m) => ({ ...m, [cropKey]: next }));
    };
    const onUp = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.id) return;
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      void saveCrop(d.last);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  function onCropKey(e: React.KeyboardEvent) {
    if (!scene || scene.layout === "card") return;
    const step = (e.shiftKey ? 5 : 1) / 100;
    let next: { x: number; y: number } | null = null;
    if (box.axis === "x") {
      if (e.key === "ArrowLeft") next = { x: Math.max(0, cropPos.x - step), y: 0 };
      if (e.key === "ArrowRight") next = { x: Math.min(1 - box.w, cropPos.x + step), y: 0 };
    } else {
      if (e.key === "ArrowUp") next = { x: 0, y: Math.max(0, cropPos.y - step) };
      if (e.key === "ArrowDown") next = { x: 0, y: Math.min(1 - box.h, cropPos.y + step) };
    }
    if (next) {
      e.preventDefault();
      setLocalCrops((m) => ({ ...m, [cropKey]: next! }));
      void saveCrop(next);
    }
  }

  // ----- filmstrip -----
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!workerUp) return;
    let dead = false;
    const [a, b] = ctx;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.src = `/api/media/${variant.videoId}`;
    const canvas = document.createElement("canvas");
    canvas.width = 96; canvas.height = 54;
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
        for (let i = 0; i < 16 && !dead; i++) {
          await seekTo(a + ((b - a) * (i + 0.5)) / 16);
          g?.drawImage(v, 0, 0, 96, 54);
          grabbed.push(canvas.toDataURL("image/jpeg", 0.6));
        }
        if (!dead) setFrames(grabbed);
      } catch {
        /* CORS or load failure — keep the neutral gradient tiles */
      }
    })();
    return () => { dead = true; v.src = ""; };
  }, [variant.videoId, ctx, workerUp]);

  const stripRef = useRef<HTMLDivElement>(null);
  const [handleMode, setHandleMode] = useState<"l" | "r" | null>(null);
  const [resumeAfterTrim, setResumeAfterTrim] = useState(false);
  const timeAt = (clientX: number) => {
    const [a, b] = ctx;
    const r = stripRef.current!.getBoundingClientRect();
    return a + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (b - a);
  };

  /** iPhone-trimmer handles: while a handle drags, the player scrubs LIVE
   * to the frame under it (rAF-throttled), so you watch your first/last
   * frame as you choose it. Playback pauses for the drag and resumes on
   * release if it was running. Same hardened pattern as the crop drag:
   * state in locals, listeners on window, capture best-effort. */
  /** Overlay bar drag on the filmstrip: body moves the range, the edge
   * grips resize it. Live-scrubs the moving boundary like the trim
   * handles; persists once on release. */
  function onOvBarDown(e: React.PointerEvent, o: Ov) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as Element;
    const mode = target.classList.contains("l") ? "l"
      : target.classList.contains("r") ? "r" : "move";
    const pid = e.pointerId;
    try { e.currentTarget.setPointerCapture(pid); } catch {}
    const grab = timeAt(e.clientX) - IN;
    const orig = { start: o.start, end: o.end };
    let last = orig;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const dt = (timeAt(ev.clientX) - IN) - grab;
      let start = orig.start, end = orig.end;
      if (mode === "move") {
        const len = orig.end - orig.start;
        start = Math.max(0, Math.min(Math.max(clipDur - len, 0), orig.start + dt));
        end = start + len;
      } else if (mode === "l") {
        start = Math.max(0, Math.min(orig.start + dt, orig.end - 0.3));
      } else {
        end = Math.min(clipDur, Math.max(orig.end + dt, orig.start + 0.3));
      }
      last = { start, end };
      patchOverlayLocal(o.id, last);
      seek(mode === "r" ? end : start);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (last.start !== orig.start || last.end !== orig.end)
        void patchOverlay(o.id, { start_s: last.start, end_s: last.end });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onHandleDown(mode: "l" | "r") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
      const id = e.pointerId;
      const wasPlaying = playing;
      if (wasPlaying) pause();
      setHandleMode(mode);
      let lastIn = IN;
      let lastOut = OUT;

      // live scrub, at most one seek per frame
      let raf: number | null = null;
      let want: number | null = null;
      const scrubTo = (src: number) => {
        want = src;
        if (raf !== null) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          const v = videoRef.current;
          if (v && want !== null && Number.isFinite(v.duration)) v.currentTime = want;
        });
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const time = timeAt(ev.clientX);
        if (mode === "l") {
          lastIn = Math.min(time, lastOut - MIN_CLIP);
          setIN(lastIn);
          setT(0);              // playhead rides the in-point
          scrubTo(lastIn);      // preview shows the first frame being chosen
        } else {
          lastOut = Math.max(time, lastIn + MIN_CLIP);
          setOUT(lastOut);
          setT(lastOut - lastIn); // playhead rides the out-point
          scrubTo(lastOut);       // preview shows the last frame being chosen
        }
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (raf !== null) cancelAnimationFrame(raf);
        setHandleMode(null);
        // land exactly on the chosen frame
        const v = videoRef.current;
        if (v && Number.isFinite(v.duration))
          v.currentTime = mode === "l" ? lastIn : lastOut;
        void fetch(`/api/clips/${variant.clipId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_in_s: lastIn, source_out_s: lastOut }),
        }).then(() => router.refresh());
        if (wasPlaying) setResumeAfterTrim(true);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
  }

  // resume with fresh IN/OUT bounds after a trim drag that interrupted play
  useEffect(() => {
    if (resumeAfterTrim && !handleMode) {
      setResumeAfterTrim(false);
      play();
    }
  }, [resumeAfterTrim, handleMode, play]);

  // ----- api helper -----
  const call = useCallback(async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setNote(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setNote(err.error ?? res.statusText);
      return null;
    }
    router.refresh();
    return res.json().catch(() => ({}));
  }, [router]);

  // ----- subtitle persistence (debounced) -----
  const persistStyle = useCallback((nextOv: Record<string, unknown>, nextFixes: Record<string, string>, nextPreset: string | null) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void fetch(`/api/clips/${variant.clipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitle_preset_id: nextPreset,
          subtitle_overrides: { ...nextOv, ...(Object.keys(nextFixes).length ? { fixes: nextFixes } : {}) },
        }),
      });
    }, 500);
  }, [variant.clipId]);

  function setStyle(patch: Partial<Style>) {
    const next = { ...S, ...patch };
    setS(next);
    const ov = { ...styleOv };
    for (const [k, v] of Object.entries(patch)) ov[k] = v;
    setStyleOv(ov);
    persistStyle(ov, fixes, presetId);
  }
  function applyPreset(p: Preset) {
    const c = p.config as Record<string, unknown>;
    setPresetId(p.id);
    setStyleOv({});
    setS({
      fs: Number(c.fs ?? 30), ol: Number(c.ol ?? 3), vp: Number(c.vp ?? 72),
      wpl: Number(c.wpl ?? 4), hl: String(c.hl ?? "#FFC629"),
      caps: !!c.caps, box: !!c.box,
    });
    persistStyle({}, fixes, p.id);
  }
  function addFix(from: string, to: string) {
    const next = { ...fixes, [from.toLowerCase()]: to };
    setFixes(next);
    persistStyle(styleOv, next, presetId);
  }
  function dropFix(from: string) {
    const next = { ...fixes };
    delete next[from];
    setFixes(next);
    persistStyle(styleOv, next, presetId);
  }
  const fixWord = (w: string) => {
    const bare = w.replace(/[.,!?;:"']+$/, "");
    const rep = fixes[bare.toLowerCase()];
    return rep ? rep + w.slice(bare.length) : w;
  };

  // ----- scene rail drag ----
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ i: number; left: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = e.target as Element;
      if (!el.closest(".addmenu") && !el.closest(".scn-add")) setMenuOpen(false);
      if (!el.closest(".namer") && !el.closest(".var-add") && !el.closest("[data-var]")) setNamer(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  // ----- namer popover -----
  const [namer, setNamer] = useState<{ mode: "add" | "rename"; target?: string; anchor: { left: number; top: number } } | null>(null);
  const [namerVal, setNamerVal] = useState("");
  const varRailRef = useRef<HTMLDivElement>(null);

  function openNamer(mode: "add" | "rename", anchorEl: HTMLElement, target?: string) {
    const w = varRailRef.current!.getBoundingClientRect();
    const r = anchorEl.getBoundingClientRect();
    setNamerVal(mode === "rename" ? siblings.find((s) => s.id === target)?.name ?? "" : "");
    setNamer({
      mode, target,
      anchor: {
        left: Math.max(0, Math.min(r.left - w.left, w.width - 254)),
        top: r.bottom - w.top + 6,
      },
    });
  }
  async function commitNamer() {
    if (!namer) return;
    if (namer.mode === "add") {
      const res = await call(`/api/clips/${variant.clipId}/variants`, "POST", {
        name: namerVal.trim() || undefined,
        copy_from: variant.id,
      });
      setNamer(null);
      if (res?.variant_id) router.push(`/variants/${res.variant_id}`);
    } else {
      if (namerVal.trim())
        await call(`/api/variants/${namer.target}`, "PATCH", { name: namerVal.trim() });
      setNamer(null);
    }
  }

  // ----- derived -----
  const shape = useMemo(() => {
    const sig = scenes.map((s) => s.layout);
    const shapes: Record<string, string[]> = {
      plain: ["full"],
      product: ["full", "split_product"],
      hookfirst: ["full", "split_product", "card"],
    };
    for (const k in shapes)
      if (shapes[k].length === sig.length && shapes[k].every((l, i) => l === sig[i])) return k;
    return "custom";
  }, [scenes]);

  const assetById = (id: string | null) => assets.find((a) => a.id === id);
  const assetBg = (id: string | null) =>
    id && workerUp ? { backgroundImage: `url(/api/assets/${id}/file)` } : undefined;

  const sz = SAFE[bRatio];
  const capFont = S.fs * 0.52;
  const activePresetName = styleOv && Object.keys(styleOv).length
    ? "Custom"
    : presets.find((p) => p.id === presetId)?.name ?? "Custom";

  const [a0, a1] = ctx;
  const span = a1 - a0;
  const winL = ((IN - a0) / span) * 100;
  const winR = ((OUT - a0) / span) * 100;

  // ================= render =================
  return (
    <div className="build">
      <div>
        <div className="prev-tools" style={{ margin: "0 0 10px" }}>
          <div className="seg">
            {Object.keys(RATIOS).map((r) => (
              <button key={r} data-on={bRatio === r ? "1" : undefined}
                onClick={() => setBRatio(r)}>
                {RATIOS[r].label}
                {scene && scene.layout !== "card" && hasCropSet(scene.id, r) ? " ●" : ""}
              </button>
            ))}
          </div>
          <label className="zone-tog">
            <input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} />
            {" "}Safe zones
          </label>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
            {RATIOS[bRatio].use} · {RATIOS[bRatio].px}
          </span>
        </div>

        <div className="stage">
          {/* The .src box IS the displayed frame: sized to fit the stage on
              both axes at the source's aspect, so crop percentages measure
              the displayed frame exactly. 420px height cap keeps the
              filmstrip and transport on a laptop screen. */}
          <div className="src" ref={srcRef} style={{
            aspectRatio: `${srcAr}`,
            width: `min(100%, 520px, ${Math.round(420 * srcAr)}px)`,
          }}>
            {workerUp && !videoErr ? (
              <video
                ref={videoRef}
                src={`/api/media/${variant.videoId}`}
                preload="metadata"
                playsInline
                onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = IN + t; }}
                onError={() => setVideoErr(true)}
              />
            ) : (
              <div style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center",
                justifyContent: "center", color: "#7C7E85", fontSize: 11.5,
                textAlign: "center", padding: 20,
              }}>
                {workerUp
                  ? "Source video unavailable — has this video been archived to R2?"
                  : "Worker not connected — set WORKER_URL and INGEST_TOKEN to play real footage."}
              </div>
            )}

            {/* live captions — pushed down when an overlay occupies their band */}
            {line && scene?.layout !== "card" && (
              <div className="cap" style={{
                fontFamily: "var(--font-inter),sans-serif", fontWeight: 700,
                lineHeight: 1.22, fontSize: capFont, color: "#fff",
                letterSpacing: "-.01em",
                top: `${subVpWithOverlays(t, t + 0.4, ovs, bRatio, S.vp / 100) * 100}%`,
                transform: "translateY(-50%)",
                textShadow: S.ol
                  ? `0 0 ${S.ol}px #000,0 0 ${S.ol}px #000,0 ${S.ol / 2}px ${S.ol}px rgba(0,0,0,.6)`
                  : "none",
                ...(S.box
                  ? { background: "rgba(0,0,0,.62)", padding: "5px 9px", borderRadius: 3 }
                  : {}),
              }}>
                <div>
                  {line.map((w, i) => (
                    <b key={i} style={{ color: tSrc >= w.s && tSrc < w.e ? S.hl : "#fff" }}>
                      {S.caps ? fixWord(w.w).toUpperCase() : fixWord(w.w)}{" "}
                    </b>
                  ))}
                </div>
              </div>
            )}

            {/* text overlays — live preview, layered above captions.
                fs is design px at 1080 output width; the stage is ~520px,
                same calibration the caption preview uses. */}
            {ovs.filter((o) => t >= o.start && t < o.end).map((o) => {
              const cfg = styleCfg(o.style) as {
                fs?: number; weight?: number; color?: string; box?: boolean;
                box_color?: string; box_alpha?: number; uppercase?: boolean;
              };
              return (
                <div key={o.id} style={{
                  position: "absolute", left: "50%",
                  top: `${ovY(o.position, bRatio) * 100}%`,
                  transform: "translate(-50%,-50%)", zIndex: 6,
                  maxWidth: "86%", textAlign: "center",
                  fontFamily: "'Plus Jakarta Sans','Inter',sans-serif",
                  fontWeight: cfg.weight ?? 700,
                  fontSize: (cfg.fs ?? 40) * 0.48,
                  lineHeight: 1.15, whiteSpace: "pre-wrap",
                  color: cfg.color ?? "#fff",
                  ...(cfg.box ? {
                    background: `${cfg.box_color ?? "#0A0B0D"}${Math.round((cfg.box_alpha ?? 0.75) * 255).toString(16).padStart(2, "0")}`,
                    padding: "4px 10px", borderRadius: 6,
                  } : {}),
                }}>
                  {cfg.uppercase ? o.text.toUpperCase() : o.text}
                </div>
              );
            })}

            {/* layout overlays for the selected scene */}
            {scene && (scene.layout === "split_product" || scene.layout === "split_speakers") && (
              <div
                className={`lay-lower${scene.layout === "split_product" && scene.asset && workerUp ? " has-img" : ""}`}
                style={{
                  display: "flex",
                  height: `${(1 - scene.splitRatio) * 100}%`,
                  ...(scene.layout === "split_product" ? assetBg(scene.asset) : {}),
                  ...(scene.layout === "split_speakers"
                    ? { background: "linear-gradient(135deg,#3A4252,#6E7A8F)" } : {}),
                }}
              />
            )}
            {scene?.layout === "card" && (
              <div
                className={`lay-card${scene.asset && workerUp ? " has-img" : ""}`}
                style={{ display: "flex", ...assetBg(scene.asset) }}
              />
            )}

            {/* crop overlay — direct manipulation */}
            {scene && scene.layout !== "card" && (
              <div
                className={`crop${dragging ? " drag" : ""}${zones ? " zones" : ""}`}
                tabIndex={0}
                role="slider"
                aria-label="Reframe crop"
                style={{
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  left: `${(box.axis === "x" ? cropPos.x : 0) * 100}%`,
                  top: `${(box.axis === "y" ? cropPos.y : 0) * 100}%`,
                }}
                onPointerDown={onCropDown}
                onKeyDown={onCropKey}
              >
                <div className="thirds">
                  <i className="v" style={{ left: "33.33%" }} /><i className="v" style={{ left: "66.66%" }} />
                  <i className="h" style={{ top: "33.33%" }} /><i className="h" style={{ top: "66.66%" }} />
                </div>
                <b className="br tl" /><b className="br tr" /><b className="br bl" /><b className="br br2" />
                <div className="zone t" style={{ height: `${sz.t}%` }}><span>TOP</span></div>
                <div className="zone b" style={{ height: `${sz.b}%` }}><span>BOTTOM</span></div>
                <div className="crop-hint">
                  drag to reframe · {RATIOS[bRatio].label}
                  {box.axis === "y" ? " · vertical axis" : ""}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* filmstrip trim */}
        <div className="strip" ref={stripRef}
          onPointerDown={(e) => {
            if ((e.target as Element).closest(".hnd")) return;
            seek(timeAt(e.clientX) - IN);
          }}>
          <div className="frames">
            {Array.from({ length: 16 }, (_, i) => {
              const l = 26 + Math.sin(i * 1.7) * 7;
              return (
                <i key={i} style={frames
                  ? { backgroundImage: `url(${frames[i]})` }
                  : { background: `linear-gradient(150deg,hsl(218 18% ${l}%),hsl(212 16% ${l + 16}%))` }}
                />
              );
            })}
          </div>
          <div className="mask" style={{ left: 0, width: `${winL}%` }} />
          <div className="mask" style={{ right: 0, width: `${100 - winR}%` }} />
          <div className="win" style={{ left: `${winL}%`, width: `${winR - winL}%` }}>
            <div className="hnd l" role="slider" aria-label="Clip start"
              onPointerDown={onHandleDown("l")} />
            <div className="hnd r" role="slider" aria-label="Clip end"
              onPointerDown={onHandleDown("r")} />
          </div>
          {/* overlay time ranges: drag body to move, edges to resize */}
          {ovs.map((o) => {
            const l = ((IN + o.start - a0) / span) * 100;
            const r = ((IN + Math.min(o.end, clipDur) - a0) / span) * 100;
            return (
              <div key={o.id} className="ovbar"
                title={`${o.text.split("\n")[0]} · ${o.start.toFixed(1)}–${o.end.toFixed(1)}s`}
                style={{ left: `${l}%`, width: `${Math.max(r - l, 1)}%` }}
                onPointerDown={(e) => onOvBarDown(e, o)}>
                <i className="e l" /><span>{o.text.split("\n")[0]}</span><i className="e r" />
              </div>
            );
          })}
          <div className="strip-ph" style={{ left: `${((IN + Math.min(t, clipDur) - a0) / span) * 100}%` }} />
        </div>
        <div className="strip-scale">
          <span>{mmss(a0)}</span><span>{mmss(a1)}</span>
        </div>

        {/* variants */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 16 }}>
          <div className="eyebrow">Variants</div>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--faint)" }}>
            Same body, different hooks
          </span>
        </div>
        <div className="rail-wrap" ref={varRailRef}>
          <div className="vars">
            {siblings.map((v) => (
              <button key={v.id} className="var" data-var={v.id}
                data-on={v.id === variant.id ? "1" : undefined}
                title="Click to open · double-click to rename"
                onClick={(e) => {
                  if ((e.target as Element).closest("[data-delvar]")) return;
                  if (v.id !== variant.id) router.push(`/variants/${v.id}`);
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  openNamer("rename", e.currentTarget, v.id);
                }}>
                <span className="mk">{v.label}</span>
                <span className="nm">{v.name}</span>
                <span className="ct">{v.nScenes}</span>
                {siblings.length > 1 && v.status !== "sent" && (
                  <span className="x" data-delvar
                    onClick={async (e) => {
                      e.stopPropagation();
                      const res = await call(`/api/variants/${v.id}`, "DELETE");
                      if (res && v.id === variant.id) {
                        const next = siblings.find((s) => s.id !== v.id);
                        if (next) router.push(`/variants/${next.id}`);
                      }
                    }}>×</span>
                )}
              </button>
            ))}
            <button className="var-add"
              onClick={(e) => { e.stopPropagation(); openNamer("add", e.currentTarget); }}>
              + Add variant
            </button>
          </div>
          {namer && (
            <div className="namer on" style={{ left: namer.anchor.left, top: namer.anchor.top }}>
              <div className="lb">{namer.mode === "add" ? "Name this variant" : "Rename variant"}</div>
              <input type="text" autoFocus value={namerVal}
                placeholder={namer.mode === "add"
                  ? `Variant ${String.fromCharCode(65 + siblings.length)}` : "Variant name"}
                onChange={(e) => setNamerVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void commitNamer(); }
                  if (e.key === "Escape") setNamer(null);
                }}
              />
              <div className="sugs">
                {NAME_SUGS.filter((s) => !siblings.some((v) => v.name === s)).slice(0, 4).map((s) => (
                  <button key={s} className="sug" onClick={() => setNamerVal(s)}>{s}</button>
                ))}
              </div>
              <div className="acts">
                <button className="btn ghost sm" onClick={() => setNamer(null)}>Cancel</button>
                <button className="btn sm" onClick={() => void commitNamer()}>
                  {namer.mode === "add" ? "Add" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* scenes */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 16 }}>
          <div className="eyebrow">Scenes — drag to reorder</div>
          <button className="btn ghost sm" disabled={busy || !scene || scene.layout === "card"}
            onClick={() => {
              if (!scene) return;
              void call(`/api/scenes/${scene.id}/split`, "POST", { at_s: IN + t });
            }}>
            Split at playhead
          </button>
        </div>
        <div className="rail-wrap">
          <div className="rail-scenes" ref={railRef}>
            {scenes.map((s, i) => (
              <div key={s.id}
                className={`scn${dragFrom === i ? " dragging" : ""}${
                  dragOver?.i === i ? (dragOver.left ? " over-l" : " over-r") : ""}`}
                draggable
                data-on={i === sel ? "1" : "0"}
                onClick={(e) => {
                  if ((e.target as Element).closest(".op")) return;
                  setSel(i);
                }}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                }}
                onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                onDragOver={(e) => {
                  if (dragFrom === null || dragFrom === i) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDragOver({ i, left: e.clientX < r.left + r.width / 2 });
                }}
                onDragLeave={() => setDragOver((d) => (d?.i === i ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom === null || dragFrom === i) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  let to = e.clientX < r.left + r.width / 2 ? i : i + 1;
                  if (dragFrom < to) to--;
                  setDragOver(null);
                  void call(`/api/scenes/${scenes[dragFrom].id}/move`, "POST", { to })
                    .then(() => setSel(to));
                }}>
                <span className="pv">
                  {s.layout === "card" ? (
                    <span className={`pv-card${s.asset && workerUp ? " has-img" : ""}`}
                      style={assetBg(s.asset)} />
                  ) : s.layout === "full" ? (
                    <span className="pv-half pv-vid" style={{ top: 0, bottom: 0 }} />
                  ) : (
                    <>
                      <span className="pv-half pv-vid" style={{ top: 0, height: `${s.splitRatio * 100}%` }} />
                      <span
                        className={`pv-half ${s.layout === "split_product" ? "pv-ast" : "pv-vid"}${
                          s.layout === "split_product" && s.asset && workerUp ? " has-img" : ""}`}
                        style={{ top: `${s.splitRatio * 100}%`, bottom: 0,
                          ...(s.layout === "split_product" ? assetBg(s.asset) : {}) }}
                      />
                    </>
                  )}
                  <span className="hnd-grip">⋮⋮</span>
                </span>
                <span className="ops">
                  {i > 0 && (
                    <button className="op" title="Move left"
                      onClick={() => void call(`/api/scenes/${s.id}/move`, "POST", { dir: "up" }).then(() => setSel(i - 1))}>
                      ‹
                    </button>
                  )}
                  {i < scenes.length - 1 && (
                    <button className="op" title="Move right"
                      onClick={() => void call(`/api/scenes/${s.id}/move`, "POST", { dir: "down" }).then(() => setSel(i + 1))}>
                      ›
                    </button>
                  )}
                  {scenes.length > 1 && (
                    <button className="op" title="Delete scene"
                      onClick={() => void call(`/api/scenes/${s.id}`, "DELETE").then(() => setSel(Math.max(0, sel - 1)))}>
                      ×
                    </button>
                  )}
                </span>
                <span className="lb">
                  {LY_NAME[s.layout]}<b>{sceneDur(s).toFixed(1)}s</b>
                </span>
              </div>
            ))}
            <button className="scn-add" ref={addBtnRef} title="Add scene or apply template"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                const w = railRef.current!.getBoundingClientRect();
                setMenuPos({
                  left: Math.max(0, Math.min(r.left - w.left, w.width - 190)),
                  top: r.bottom - w.top + 6,
                });
                setMenuOpen((o) => !o);
              }}>
              +
            </button>
          </div>
          <div className={`addmenu${menuOpen ? " on" : ""}`} style={menuPos}>
            <div className="grp">Add scene</div>
            <button onClick={() => { setMenuOpen(false); void call(`/api/variants/${variant.id}/scenes`, "POST", { layout: "full" }); }}>
              <span className="mi"><i /></span>Full frame
            </button>
            <button onClick={() => {
              setMenuOpen(false);
              void call(`/api/variants/${variant.id}/scenes`, "POST", {
                layout: "split_product",
                slot_a_asset: assets.find((a) => a.kind !== "end_card")?.id ?? null,
              });
            }}>
              <span className="mi"><i /><i className="ast" /></span>Product split
            </button>
            <button onClick={() => { setMenuOpen(false); void call(`/api/variants/${variant.id}/scenes`, "POST", { layout: "split_speakers" }); }}>
              <span className="mi"><i /><i /></span>Speakers split
            </button>
            <button onClick={() => {
              setMenuOpen(false);
              void call(`/api/variants/${variant.id}/scenes`, "POST", {
                layout: "card",
                slot_a_asset: assets.find((a) => a.kind === "end_card")?.id ?? null,
              });
            }}>
              <span className="mi"><i className="crd" /></span>End card
            </button>
            <div className="sep" />
            <div className="grp">Apply template</div>
            <button onClick={() => { setMenuOpen(false); void call(`/api/variants/${variant.id}/template`, "POST", { key: "plain" }).then(() => setSel(0)); }}>
              Plain<span className="sub">1 scene</span>
            </button>
            <button onClick={() => { setMenuOpen(false); void call(`/api/variants/${variant.id}/template`, "POST", { key: "product" }).then(() => setSel(0)); }}>
              Product split<span className="sub">2 scenes</span>
            </button>
            <button onClick={() => { setMenuOpen(false); void call(`/api/variants/${variant.id}/template`, "POST", { key: "hookfirst" }).then(() => setSel(0)); }}>
              Hook first + card<span className="sub">3 scenes</span>
            </button>
          </div>
        </div>

        {/* transport */}
        <div className="transport">
          <button className="tbtn pri" aria-label={playing ? "Pause" : "Play"} title="Play (space)"
            onClick={() => (playing ? pause() : play())}>
            <svg viewBox="0 0 12 12">
              {playing
                ? <><rect x="2" y="1.5" width="3" height="9" /><rect x="7" y="1.5" width="3" height="9" /></>
                : <path d="M2 1l9 5-9 5z" />}
            </svg>
          </button>
          <button className="tbtn" aria-label="Stop" title="Stop"
            onClick={() => { pause(); seek(0); }}>
            <svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" /></svg>
          </button>
          <span className="tc mono">
            <b>{clock(Math.min(t, clipDur))}</b> / <span>{clipDur.toFixed(1)}</span>
          </span>
          <input type="range" min={0} max={1000} step={1} aria-label="Scrub"
            value={clipDur > 0 ? Math.round((Math.min(t, clipDur) / clipDur) * 1000) : 0}
            onChange={(e) => seek((+e.target.value / 1000) * clipDur)}
          />
          <div className="speeds">
            {[0.25, 0.5, 1, 1.5, 2].map((r) => (
              <button key={r} className="spd" data-on={rate === r ? "1" : undefined}
                onClick={() => setRate(r)}>
                {r}×
              </button>
            ))}
          </div>
        </div>

        <div className="trim">
          <div className="fld">In <input type="text" className="mono" readOnly value={fmt(IN)} /></div>
          <div className="fld">Out <input type="text" className="mono" readOnly value={fmt(OUT)} /></div>
          <div className="fld mono" style={{ color: "var(--ink)" }}>{clipDur.toFixed(1)}s</div>
          <div className="fld" style={{ marginLeft: "auto" }}>
            {box.axis === "y"
              ? cropPos.y < 0.04 ? "Framed high" : cropPos.y > 0.12 ? "Framed low" : "Centred"
              : `Window at ${Math.round(cropPos.x * 100)}%`}
          </div>
        </div>
        <div className="note" style={{ marginTop: 10 }}>
          {srcAr > 1
            ? "Landscape source, vertical output — narrower ratios crop width. "
            : srcAr < 0.99
              ? "Vertical source — wider ratios crop height and reframe vertically; 9:16 uses the whole frame. "
              : "Square source — vertical ratios crop width, wide ratios crop height. "}
          Drag the frame to reframe and the yellow handles to trim — both save
          with the clip, so re-exports keep them.
        </div>
        {note && <p className="hint">{note}</p>}
      </div>

      {/* ---------- sidebar ---------- */}
      <div className="card pad">
        <Acc title="Template" sum={shape === "custom" ? "Custom" : { plain: "Plain", product: "Product split", hookfirst: "Hook first + card" }[shape]} defaultOpen>
          <div className="presets" style={{ marginBottom: 2 }}>
            {([["plain", "Plain"], ["product", "Product split"], ["hookfirst", "Hook first + card"]] as const).map(([k, lbl]) => (
              <button key={k} className="chip" data-on={shape === k ? "1" : undefined}
                disabled={busy}
                onClick={() => void call(`/api/variants/${variant.id}/template`, "POST", { key: k }).then(() => setSel(0))}>
                {lbl}
              </button>
            ))}
            {shape === "custom" && <span className="chip" data-on="1" style={{ cursor: "default" }}>Custom</span>}
          </div>
        </Acc>

        <Acc title="Assets" sum={`${assets.length} in library`} defaultOpen>
          {assets.length ? (
            <div className="imp">
              {assets.map((a) => (
                <button key={a.id} className="it" title={a.name}
                  onClick={() => {
                    if (!scene) return;
                    const patch: Record<string, unknown> = { slot_a_asset: a.id };
                    if (scene.layout === "full") {
                      patch.layout = a.kind === "end_card" ? "card" : "split_product";
                      if (patch.layout === "card") patch.duration_s = 2.5;
                      if (patch.layout === "split_product") patch.split_ratio = 0.6;
                    }
                    void call(`/api/scenes/${scene.id}`, "PATCH", patch);
                  }}>
                  <span className="sq" style={assetBg(a.id)} />
                  <span className="nm">{a.name.split(" — ")[0]}</span>
                </button>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 11, color: "var(--muted)" }}>
              No brand assets yet. Upload stills to R2 via the Cloudflare
              dashboard and add rows to <span className="mono">assets</span> —
              they appear here and in splits.
            </p>
          )}
          {assets.length > 0 && (
            <p style={{ fontSize: 10.5, color: "var(--muted)", margin: "4px 0 0" }}>
              Click to drop into the selected scene.
            </p>
          )}
        </Acc>

        <Acc title="Scene layout"
          sum={scene ? [LY_NAME[scene.layout],
            scene.layout.startsWith("split")
              ? `${Math.round(scene.splitRatio * 100)}/${Math.round((1 - scene.splitRatio) * 100)}`
              : null].filter(Boolean).join(" · ") : ""}
          defaultOpen>
          <div className="layouts">
            {(["full", "split_product", "split_speakers", "card"] as const).map((l) => {
              const cardToSource = scene?.layout === "card" && l !== "card" && scene?.in === null;
              return (
                <button key={l} className="ly" data-on={scene?.layout === l ? "1" : undefined}
                  disabled={busy || !scene || cardToSource}
                  title={cardToSource ? "This card has no source footage" : undefined}
                  onClick={() => {
                    if (!scene) return;
                    const patch: Record<string, unknown> = { layout: l };
                    if (l === "card" && !scene.dur) patch.duration_s = 2.5;
                    void call(`/api/scenes/${scene.id}`, "PATCH", patch);
                  }}>
                  <span className="gl">
                    {l === "full" && <i />}
                    {l === "split_product" && <><i /><i className="ast" /></>}
                    {l === "split_speakers" && <><i /><i /></>}
                    {l === "card" && <i className="crd" />}
                  </span>
                  {l === "full" ? "full" : l === "split_product" ? "product"
                    : l === "split_speakers" ? "speakers" : "card"}
                </button>
              );
            })}
          </div>

          {scene && (scene.layout === "split_product" || scene.layout === "card") && (
            <div className="ctrl">
              <label htmlFor="slot">{scene.layout === "card" ? "Card asset" : "Lower slot"}</label>
              <select id="slot" value={scene.asset ?? ""} disabled={busy}
                onChange={(e) => void call(`/api/scenes/${scene.id}`, "PATCH", { slot_a_asset: e.target.value || null })}>
                <option value="">— none —</option>
                {assets.filter((a) => a.kind !== "logo").map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {scene && scene.layout.startsWith("split") && (
            <div className="ctrl">
              <label>Split ratio</label>
              <div className="presets" style={{ margin: 0 }}>
                {[0.5, 0.6].map((r) => (
                  <button key={r} className="chip" data-on={scene.splitRatio === r ? "1" : undefined}
                    disabled={busy}
                    onClick={() => void call(`/api/scenes/${scene.id}`, "PATCH", { split_ratio: r })}>
                    {Math.round(r * 100)} / {Math.round((1 - r) * 100)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {scene && scenes.length > 1 && scene.layout !== "card" && (
            <label className="toggle">
              <input type="checkbox" checked={scene.lifted} disabled={busy}
                onChange={(e) => void call(`/api/scenes/${scene.id}`, "PATCH", { lifted: e.target.checked })} />
              Lift from original position
            </label>
          )}

          {scene && scene.layout !== "card" && (
            <div className="ctrl" style={{ marginTop: 8 }}>
              <label>Audio</label>
              <div className="presets" style={{ margin: 0 }}>
                {(["source", "mute"] as const).map((a) => (
                  <button key={a} className="chip" data-on={scene.audio === a ? "1" : undefined}
                    disabled={busy}
                    onClick={() => void call(`/api/scenes/${scene.id}`, "PATCH", { audio: a })}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Acc>

        <Acc title="Overlays" sum={ovs.length ? `${ovs.length} on clip` : "none"} defaultOpen={ovs.length > 0}>
          {stale && (
            <div className="ov-stale">
              Overlays changed since the last render — the export is stale.
              <button className="btn sm" disabled={busy}
                onClick={() => void call(`/api/variants/${variant.id}/render`, "POST", { ratio: bRatio })
                  .then(() => { setStale(false); setNote(`re-render queued (${RATIOS[bRatio].label})`); })}>
                Re-render
              </button>
            </div>
          )}
          {ovs.map((o) => (
            <div key={o.id} className="ovrow">
              <textarea rows={2} value={o.text}
                onChange={(e) => {
                  patchOverlayLocal(o.id, { text: e.target.value });
                  patchOverlayDebounced(o.id, { text: e.target.value });
                }} />
              <div className="ovmeta">
                <select value={o.style} title="Style preset"
                  onChange={(e) => {
                    patchOverlayLocal(o.id, { style: e.target.value });
                    const cfg = styleCfg(e.target.value) as { default_position?: string };
                    if (cfg.default_position) patchOverlayLocal(o.id, { position: cfg.default_position });
                    void patchOverlay(o.id, {
                      style: e.target.value,
                      ...(cfg.default_position ? { position: cfg.default_position } : {}),
                    });
                  }}>
                  {overlayStyles.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                </select>
                <select value={o.position} title="Position"
                  onChange={(e) => {
                    patchOverlayLocal(o.id, { position: e.target.value });
                    void patchOverlay(o.id, { position: e.target.value });
                  }}>
                  <option value="top">Top</option>
                  <option value="center">Centre</option>
                  <option value="lower_third">Lower third</option>
                </select>
                <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
                  {o.start.toFixed(1)}–{o.end.toFixed(1)}s
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn ghost sm" disabled={suggesting}
                  title="Three hook options from Claude, using this range's transcript and the video's creative tags"
                  onClick={() => void suggestHook(o)}>
                  {suggesting && suggestFor === o.id ? "…" : "Suggest hook"}
                </button>
                <button className="btn ghost sm" aria-label="Delete overlay"
                  onClick={() => void delOverlay(o.id)}>✕</button>
              </div>
              {suggestFor === o.id && suggestions && (
                <div className="ovsug">
                  {suggestions.map((sg, i) => (
                    <button key={i} className="ovsug-opt"
                      onClick={() => {
                        patchOverlayLocal(o.id, { text: sg.text });
                        void patchOverlay(o.id, { text: sg.text });
                        setSuggestFor(null);
                      }}>
                      <b>{sg.text}</b><span>{sg.angle}</span>
                    </button>
                  ))}
                  <button className="btn ghost sm" onClick={() => setSuggestFor(null)}>dismiss</button>
                </div>
              )}
            </div>
          ))}
          <button className="btn sm" onClick={() => void addOverlay()}>
            + Overlay (first 3s)
          </button>
          <p style={{ fontSize: 10.5, color: "var(--muted)", margin: "6px 0 0" }}>
            Drag the bar on the filmstrip to move it; drag its edges to
            change the range. Overlays burn above subtitles and push them
            out of the way when they collide.
          </p>
        </Acc>

        <Acc title="Subtitles" sum={`${activePresetName} · ${S.fs}px`}>
          <div className="presets">
            {presets.map((p) => (
              <button key={p.id} className="chip"
                data-on={presetId === p.id && !Object.keys(styleOv).length ? "1" : undefined}
                onClick={() => applyPreset(p)}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="ctrl">
            <label htmlFor="fs">Size <b>{S.fs}px</b></label>
            <input id="fs" type="range" min={16} max={46} value={S.fs}
              onChange={(e) => setStyle({ fs: +e.target.value })} />
          </div>
          <div className="ctrl">
            <label htmlFor="ol">Outline <b>{S.ol}px</b></label>
            <input id="ol" type="range" min={0} max={8} value={S.ol}
              onChange={(e) => setStyle({ ol: +e.target.value })} />
          </div>
          <div className="ctrl">
            <label htmlFor="vp">Vertical position <b>{S.vp}%</b></label>
            <input id="vp" type="range" min={35} max={88} value={S.vp}
              onChange={(e) => setStyle({ vp: +e.target.value })} />
          </div>
          <div className="ctrl">
            <label htmlFor="wpl">Words per line <b>{S.wpl}</b></label>
            <input id="wpl" type="range" min={2} max={8} value={S.wpl}
              onChange={(e) => setStyle({ wpl: +e.target.value })} />
          </div>
          <div className="ctrl">
            <label>Active word</label>
            <div className="swatches">
              {["#FFC629", "#4ED6A1", "#FF6B8A", "#FFFFFF"].map((c) => (
                <button key={c} className="sw" style={{ background: c }}
                  data-on={S.hl === c ? "1" : undefined}
                  aria-label={`Highlight ${c}`}
                  onClick={() => setStyle({ hl: c })} />
              ))}
            </div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={S.caps} onChange={(e) => setStyle({ caps: e.target.checked })} />
            All caps
          </label>
          <label className="toggle">
            <input type="checkbox" checked={S.box} onChange={(e) => setStyle({ box: e.target.checked })} />
            Background box
          </label>
        </Acc>

        <Acc title="Transcript fix">
          <FixEditor fixes={fixes} onAdd={addFix} onDrop={dropFix} />
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 5 }}>
            Corrections apply to this clip only. The source transcript is untouched.
          </p>
        </Acc>

        <Acc title="Export">
          <div className="presets" style={{ margin: 0 }}>
            {Object.keys(RATIOS).map((r) => (
              <button key={r} className="chip" disabled={busy}
                onClick={() => void call(`/api/variants/${variant.id}/render`, "POST", { ratio: r })
                  .then((res) => res && setNote(`render queued: ${RATIOS[r].label}`))}>
                Render {RATIOS[r].label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 6 }}>
            Renders run on the worker and land in R2. The Preview screen plays
            the finished export.
          </p>
        </Acc>

        <button className="btn" style={{ width: "100%", marginTop: 14 }}
          onClick={() => router.push(`/variants/${variant.id}/preview`)}>
          Preview {siblings.length > 1 ? "all variants" : "this variant"}
        </button>
        {!draft && (
          <p style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8 }}>
            This variant is {variant.status.replace("_", " ")} — edits here
            change what ships if it re-renders.
          </p>
        )}
      </div>
    </div>
  );
}

function Acc({ title, sum, defaultOpen, children }: {
  title: string; sum?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="acc" data-open={open ? "1" : "0"}>
      <button className="acc-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title} {sum && <span className="sum">{sum}</span>}<span className="cv" />
      </button>
      <div className="acc-b">{children}</div>
    </div>
  );
}

function FixEditor({ fixes, onAdd, onDrop }: {
  fixes: Record<string, string>;
  onAdd: (from: string, to: string) => void;
  onDrop: (from: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <div>
      {Object.entries(fixes).map(([f, t]) => (
        <div key={f} className="row" style={{ alignItems: "center", gap: 6, marginBottom: 5, fontSize: 11.5 }}>
          <span className="mono" style={{ color: "var(--muted)" }}>{f}</span>
          <span style={{ color: "var(--faint)" }}>→</span>
          <span className="mono" style={{ flex: 1 }}>{t}</span>
          <button className="chip" onClick={() => onDrop(f)} title="Remove">×</button>
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <input type="text" placeholder="heard as" value={from} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setFrom(e.target.value)} />
        <input type="text" placeholder="should be" value={to} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setTo(e.target.value)} />
        <button className="btn ghost sm" disabled={!from.trim() || !to.trim()}
          onClick={() => { onAdd(from.trim(), to.trim()); setFrom(""); setTo(""); }}>
          Add
        </button>
      </div>
    </div>
  );
}
