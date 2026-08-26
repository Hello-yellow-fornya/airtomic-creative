"use client";

/** Variant editor — the prototype's 04 BUILD screen wired to real data.
 * Selection-driven: the clips table above chooses which variant this
 * edits; there is no header block, just a 40px bar (name · label ·
 * approval · ratio tabs · safe zones · template · links) so the scrubber
 * and scene strip fit on screen without scrolling at 1080p.
 *
 * Yellow is reserved for machine claims; every control here is a human
 * action, so the only yellow on this screen is the trim handles' hardware
 * (prototype chrome) and nothing interactive gains a yellow fill. */

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useRouter } from "next/navigation";
import ColorPicker from "./ColorPicker";
import { exportFilename } from "@/lib/adname";
import {
  clampTransform, DEFAULT_TRANSFORM, framedHigh, RATIO_SIZES,
  type Reframe,
} from "@/lib/reframe";

type VariantInfo = {
  id: string; label: string; name: string; status: string;
  clipId: string; clipIn: number; clipOut: number;
  presetId: string | null; overrides: Record<string, unknown>;
  videoId: string | null; videoTitle?: string | null;
  videoDuration: number; srcW: number; srcH: number;
  videoSource?: string;
  transforms?: Record<string, Reframe>;
  staleRatios?: string[];
  renderStatus?: string | null; renderError?: string | null;
  ratios?: string[];
  exportRatios?: string[];
};
export type ComparePayload = {
  id: string; label: string; name: string; overlays: Ov[];
  transforms?: Record<string, Reframe>;
};
type Scene = {
  id: string; idx: number; layout: string; in: number | null; out: number | null;
  dur: number | null; lifted: boolean; asset: string | null;
  splitRatio: number; audio: string;
};
type Crop = { sceneId: string; ratio: string; x: number; y: number; w: number; h: number };
type Asset = { id: string; name: string; kind: string };
type Preset = { id: string; name: string; is_default: boolean; config: Record<string, unknown> };
type Word = { w: string; s: number; e: number };
export type OvPlacement = { xp: number; vp: number; w: number };
export type OvSv = {
  fs: number; ol: number; vp: number; wpl: number | null;
  xp?: number; w?: number;
  pr?: Record<string, OvPlacement>;
  color: string; bg: "none" | "pill" | "box"; bg_color: string;
  bg_alpha: number; caps: boolean; weight: number;
  ol_color?: string;
  font?: string;
  radius?: number;
};
const FONTS = [
  "Plus Jakarta Sans", "Inter", "Montserrat", "Poppins",
  "Bebas Neue", "Playfair Display", "Space Grotesk",
];
type Ov = {
  id: string; text: string; start: number; end: number;
  position: string; style: string; sv: OvSv | null;
};
type OvStyle = { key: string; name: string; config: Record<string, unknown> };

/** Mirror of worker/overlays.position_y — legacy rows without stored
 * values position via the enum + ratio safe zones. */
function ovY(position: string, ratio: string): number {
  const safe = SAFE[ratio] ?? { t: 8, b: 8, r: 0 };
  if (position === "top") return Math.min(safe.t / 100 + 0.06, 0.30);
  if (position === "center") return 0.5;
  return Math.max(0.70, 1 - safe.b / 100 - 0.08);
}
/** Placement (x, y, width as fractions) for one ratio — per-ratio like
 * crops, defaulting from the 9:16 base. Mirror of worker placement(). */
function ovPlace(o: Ov, ratio: string): { xp: number; vp: number; w: number } {
  if (!o.sv) return { xp: 0.5, vp: ovY(o.position, ratio), w: 0.8 };
  const over = o.sv.pr?.[ratio];
  return {
    xp: Math.max(0, Math.min(1, (over?.xp ?? o.sv.xp ?? 50) / 100)),
    vp: Math.max(0, Math.min(1, (over?.vp ?? o.sv.vp) / 100)),
    w: Math.max(0.05, Math.min(1, (over?.w ?? o.sv.w ?? 80) / 100)),
  };
}
function ovVp(o: Ov, ratio: string): number {
  return ovPlace(o, ratio).vp;
}
/** Mirror of worker/overlays.subtitle_shift_for. Only overlays WITH a
 * background push subtitles down — text over text is a design choice. */
function subVpWithOverlays(
  t0: number, t1: number, ovs: Ov[], ratio: string, subVp: number,
  hasBg: (o: Ov) => boolean,
): number {
  const safe = SAFE[ratio] ?? { t: 8, b: 8, r: 0 };
  const [playW, playH] = RATIO_SIZES[ratio] ?? [1080, 1920];
  const cap = 1 - safe.b / 100 + 0.04;
  let lowest: number | null = null;
  for (const o of ovs) {
    if (o.end <= t0 || o.start >= t1) continue;
    if (!hasBg(o)) continue;
    const pl = ovPlace(o, ratio);
    // approximate the drawn box: wrapped line count x line height + padding
    const fs = (o.sv?.fs ?? 40) * (playW / 1080);
    const nLines = wrapWpl(o.text, o.sv?.wpl ?? null).split("\n").length;
    const hFrac = Math.max(0.05, (nLines * fs * 1.25 + 28 * (playW / 1080)) / playH);
    const band: [number, number] = [pl.vp - hFrac / 2, pl.vp + hFrac / 2];
    const xspan: [number, number] = [pl.xp - pl.w / 2, pl.xp + pl.w / 2];
    if (band[0] < subVp + 0.05 && band[1] > subVp - 0.05
        && xspan[0] < 0.92 && xspan[1] > 0.08)
      if (lowest === null || band[1] > lowest) lowest = band[1];
  }
  return lowest === null ? subVp : Math.min(lowest + 0.07, cap);
}
/** words-per-line rewrap for overlays; null keeps manual breaks. */
function wrapWpl(text: string, wpl: number | null): string {
  if (!wpl) return text;
  const words = text.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += wpl)
    lines.push(words.slice(i, i + wpl).join(" "));
  return lines.join("\n");
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
const MIN_CLIP = 3;

/** Filmstrip frames are a property of (source, context window) — cached
 * for the session so variant/clip switches never regenerate them. */
const FRAME_CACHE = new Map<string, string[]>();

type Style = {
  fs: number; ol: number; vp: number; wpl: number; hl: string;
  caps: boolean; box: boolean;
  color: string; bg: "none" | "pill" | "box"; bgColor: string;
  bgAlpha: number; olColor: string; font: string; weight: number;
};
const WEIGHT_OPTS: [number, string][] = [
  [300, "Light"], [400, "Regular"], [500, "Medium"], [700, "Bold"],
];

// Brand palette for the Text style panel swatches.
const TEXT_COLORS = ["#FFFFFF", "#0A0B0D", "#FFC629", "#4ED6A1", "#FF6B8A"];
const BG_COLORS = ["#0A0B0D", "#FFFFFF", "#FFC629", "#14403C"];

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
/** Parse "hh:mm:ss.mmm", "mm:ss.s" or bare seconds. NaN when unusable. */
const parseTs = (raw: string): number => {
  const parts = raw.trim().split(":").map((x) => x.trim());
  if (parts.some((x) => x === "" || Number.isNaN(Number(x)))) return NaN;
  return parts.reduce((acc, x) => acc * 60 + Number(x), 0);
};
const mmss = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const clock = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}`;

export default function Builder({
  variant, scenes, crops, assets, presets, words, workerUp,
  overlays, overlayStyles, renderStale,
  compare = null, compareOn = false, onCompareToggle,
  onJumpToRename, registerFlush, registerApi, onDataChanged,
  selScene, onSelectScene, scenesSlot, readOnly = false, dataVersion = 0,
}: {
  variant: VariantInfo; scenes: Scene[]; crops: Crop[];
  assets: Asset[]; presets: Preset[]; words: Word[]; workerUp: boolean;
  overlays: Ov[]; overlayStyles: OvStyle[]; renderStale: boolean;
  compare?: ComparePayload | null; compareOn?: boolean;
  onCompareToggle?: () => void;
  onJumpToRename?: () => void;
  registerFlush?: (fn: () => Promise<void>) => void;
  registerApi?: (api: { getPlayheadS: () => number }) => void;
  onDataChanged?: () => void;
  selScene: number;
  onSelectScene: (i: number) => void;
  dataVersion?: number;
  scenesSlot?: React.ReactNode;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const srcAr = variant.srcW / Math.max(variant.srcH, 1);
  const draft = variant.status === "draft";

  // Scene selection is controlled by the workbench: the variant-row scene
  // cards choose which scene the crop/layout tools target.
  const sel = selScene;
  const scene = scenes[Math.min(sel, Math.max(scenes.length - 1, 0))] as Scene | undefined;

  const [bRatio, setBRatio] = useState("9x16");
  // the ratio tabs ARE the variant's export set (0019): removable to a
  // minimum of one, re-addable, stored per variant
  const [exRatios, setExRatios] = useState<string[]>(
    () => variant.exportRatios?.length ? variant.exportRatios : Object.keys(RATIOS));
  const [addRatioOpen, setAddRatioOpen] = useState(false);
  async function saveExportRatios(next: string[]) {
    const ordered = Object.keys(RATIOS).filter((r) => next.includes(r));
    if (!ordered.length) return;
    setExRatios(ordered);
    setAddRatioOpen(false);
    if (!ordered.includes(bRatio)) setBRatio(ordered[0]);
    await fetch(`/api/variants/${variant.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ export_ratios: ordered }),
    });
  }
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
  const seedStyle = (): Style => {
    const c = { ...(activePreset?.config ?? {}), ...variant.overrides } as Record<string, unknown>;
    const bg = ["none", "pill", "box"].includes(String(c.bg))
      ? (String(c.bg) as Style["bg"]) : (c.box ? "box" : "none");
    return {
      fs: Number(c.fs ?? 30), ol: Number(c.ol ?? 3), vp: Number(c.vp ?? 72),
      wpl: Number(c.wpl ?? 4), hl: String(c.hl ?? "#FFC629"),
      caps: !!c.caps, box: bg !== "none",
      color: String(c.color ?? "#FFFFFF"), bg,
      bgColor: String(c.bg_color ?? "#000000"),
      bgAlpha: Number(c.bg_alpha ?? 0.62),
      olColor: String(c.ol_color ?? "#000000"),
      font: FONTS.includes(String(c.font)) ? String(c.font) : "Plus Jakarta Sans",
      weight: Number(c.weight ?? 700),
    };
  };
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
  // which text layer the shared "Text style" panel edits
  const [textTarget, setTextTarget] = useState<string>("subs");
  const targetOv = textTarget === "subs" ? null
    : ovs.find((o) => o.id === textTarget) ?? null;
  const [stale, setStale] = useState(renderStale);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ text: string; angle: string }[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const ovSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const seededFor = useRef<string>(variant.id + ":0");
  useEffect(() => {
    const tag = `${variant.id}:${dataVersion}`;
    if (seededFor.current === tag) return;
    seededFor.current = tag;
    setOvs(overlays);
    setStale(renderStale);
    setExRatios(variant.exportRatios?.length ? variant.exportRatios : Object.keys(RATIOS));
    setAddRatioOpen(false);
    setRfMap({ ...(variant.transforms ?? {}) });
    setStaleR(variant.staleRatios ?? []);
    setPresetId(activePreset?.id ?? null);
    const o = { ...variant.overrides };
    delete o.fixes;
    setStyleOv(o);
    setFixes({ ...((variant.overrides.fixes as Record<string, string>) ?? {}) });
    setS(seedStyle());
    setSuggestFor(null);
    setSuggestions(null);
    setNote(null);
    setTextTarget("subs");
    pendingStyle.current = null;
    for (const t of Object.values(ovSaveTimers.current)) clearTimeout(t);
    ovSaveTimers.current = {};
    pendingOvPatches.current = {};
  // seeding is driven by identity + version, not by every prop identity
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.id, dataVersion]);

  const styleCfg = useCallback(
    (key: string) => overlayStyles.find((s) => s.key === key)?.config ?? {},
    [overlayStyles]);
  // background presence decides subtitle push-down (collision rule)
  const ovHasBg = useCallback(
    (o: Ov) => {
      if (o.sv) return o.sv.bg !== "none" && (o.sv.bg_alpha ?? 0.75) > 0;
      const c = styleCfg(o.style) as { box?: boolean; box_alpha?: number };
      return !!c.box && (c.box_alpha ?? 0.75) > 0;
    },
    [styleCfg]);

  /** Effective resolved values for preview — stored sv, or the legacy
   * preset mapped into the same shape. */
  const ovResolved = useCallback((o: Ov): OvSv => {
    if (o.sv) return o.sv;
    const c = styleCfg(o.style) as {
      fs?: number; weight?: number; color?: string; box?: boolean;
      box_color?: string; box_alpha?: number; uppercase?: boolean;
      radius?: number;
    };
    return {
      fs: c.fs ?? 40, ol: 0, vp: ovY(o.position, bRatio) * 100, wpl: null,
      xp: 50, w: 80, radius: c.radius ?? 8,
      color: c.color ?? "#FFFFFF", bg: c.box ? "pill" : "none",
      bg_color: c.box_color ?? "#0A0B0D", bg_alpha: c.box_alpha ?? 0.75,
      caps: !!c.uppercase, weight: c.weight ?? 800,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleCfg, bRatio]);

  /** Style edit on an overlay: local state + debounced PATCH. Any manual
   * edit marks the overlay Custom; presets set every value at once. */
  function patchSv(o: Ov, patch: Partial<OvSv>, viaPreset = false) {
    const sv: OvSv = { ...ovResolved(o), ...patch };
    const style = viaPreset ? o.style : "custom";
    patchOverlayLocal(o.id, { sv, ...(viaPreset ? {} : { style: "custom" }) });
    patchOverlayDebounced(o.id, { sv, style });
  }
  /** Placement for the ratio being previewed. */
  const placeFor = useCallback((o: Ov) => {
    const p = ovPlace(o, bRatio);
    return { xp: p.xp * 100, vp: p.vp * 100, w: p.w * 100 };
  }, [bRatio]);
  /** Edit placement for the CURRENT ratio: 9:16 is the base; any other
   * ratio gets (or updates) its own pr[ratio] override — like crops. */
  function svWithPlace(o: Ov, patch: Partial<OvPlacement>): Partial<OvSv> {
    if (bRatio === "9x16") return patch;
    const cur = placeFor(o);
    const sv = ovResolved(o);
    return { pr: { ...(sv.pr ?? {}), [bRatio]: { ...cur, ...patch } } };
  }
  function patchPlace(o: Ov, patch: Partial<OvPlacement>) {
    patchSv(o, svWithPlace(o, patch));
  }

  // ----- eyedropper: sample a pixel from the preview frame -----
  const [eyedrop, setEyedrop] = useState<((hex: string) => void) | null>(null);
  const startEyedrop = useCallback((apply: (hex: string) => void) => {
    setEyedrop(() => apply);
  }, []);
  function sampleFrame(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const apply = eyedrop;
    setEyedrop(null);
    const v = videoRef.current;
    const box = srcRef.current;
    if (!apply || !v || !box || !v.videoWidth) {
      setNote("nothing to sample — the video isn't loaded");
      return;
    }
    try {
      const r = box.getBoundingClientRect();
      const sx = Math.floor(((e.clientX - r.left) / r.width) * v.videoWidth);
      const sy = Math.floor(((e.clientY - r.top) / r.height) * v.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const g = canvas.getContext("2d")!;
      g.drawImage(v, sx, sy, 1, 1, 0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      const hex = `#${[d[0], d[1], d[2]]
        .map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      apply(hex);
    } catch {
      setNote("couldn't sample — the source blocked canvas access");
    }
  }

  // ----- drag / resize a selected overlay in the preview -----
  const [ovDrag, setOvDrag] = useState<{ id: string; snapX: boolean; snapY: boolean } | null>(null);
  function patchSvLocal(o: Ov, patch: Partial<OvSv>) {
    patchOverlayLocal(o.id, { sv: { ...ovResolved(o), ...patch }, style: "custom" });
  }
  function onOvDragDown(e: React.PointerEvent, o: Ov, mode: "move" | "e" | "w" | "nw" | "ne" | "sw" | "se") {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    setTextTarget(o.id);
    const pid = e.pointerId;
    try { (e.currentTarget as Element).setPointerCapture(pid); } catch {}
    const rect = srcRef.current!.getBoundingClientRect();
    const start = placeFor(o);           // percents for the current ratio
    const startFs = ovResolved(o).fs;
    const px0 = e.clientX, py0 = e.clientY;
    const cx0 = rect.left + (start.xp / 100) * rect.width;
    const cy0 = rect.top + (start.vp / 100) * rect.height;
    const d0 = Math.max(8, Math.hypot(px0 - cx0, py0 - cy0));
    const safe = SAFE[bRatio] ?? { t: 8, b: 8, r: 0 };
    let last: Partial<OvPlacement> & { fs?: number } = {};
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (mode === "move") {
        let xp = start.xp + ((ev.clientX - px0) / rect.width) * 100;
        let vp = start.vp + ((ev.clientY - py0) / rect.height) * 100;
        let sx = false, sy = false;
        // guides: centre lines + safe-zone edges, snap at 2%, Alt disables
        if (!ev.altKey) {
          if (Math.abs(xp - 50) < 2) { xp = 50; sx = true; }
          for (const ty of [50, safe.t, 100 - safe.b])
            if (Math.abs(vp - ty) < 2) { vp = ty; sy = true; break; }
        }
        const half = start.w / 2;
        xp = Math.max(half, Math.min(100 - half, xp));   // box stays in frame
        vp = Math.max(3, Math.min(97, vp));
        last = { xp, vp };
        setOvDrag({ id: o.id, snapX: sx, snapY: sy });
        patchSvLocal(o, svWithPlace(o, last));
      } else if (mode === "e" || mode === "w") {
        // side handles: text-box width, centre-anchored
        const halfPx = Math.abs(ev.clientX - cx0);
        let w = (2 * halfPx / rect.width) * 100;
        w = Math.max(10, Math.min(100, Math.min(w, 2 * Math.min(start.xp, 100 - start.xp))));
        last = { w };
        setOvDrag({ id: o.id, snapX: false, snapY: false });
        patchSvLocal(o, svWithPlace(o, last));
      } else {
        // corner handles: scale the font size
        const d = Math.hypot(ev.clientX - cx0, ev.clientY - cy0);
        const fs = Math.max(12, Math.min(120, Math.round(startFs * (d / d0))));
        last = { fs };
        setOvDrag({ id: o.id, snapX: false, snapY: false });
        patchSvLocal(o, { fs });
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setOvDrag(null);
      if (!Object.keys(last).length) return;
      const { fs, ...placePatch } = last;
      const sv: OvSv = {
        ...ovResolved(o),
        ...(Object.keys(placePatch).length ? svWithPlace(o, placePatch) : {}),
        ...(fs !== undefined ? { fs } : {}),
      };
      patchOverlayLocal(o.id, { sv, style: "custom" });
      void patchOverlay(o.id, { sv, style: "custom" });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function applyOvPreset(o: Ov, key: string) {
    const c = styleCfg(key) as {
      fs?: number; weight?: number; color?: string; box?: boolean;
      box_color?: string; box_alpha?: number; uppercase?: boolean;
      default_position?: string; radius?: number;
    };
    const pos = c.default_position ?? o.position;
    const sv: OvSv = {
      fs: c.fs ?? 40, ol: 0,
      vp: pos === "top" ? 20 : pos === "center" ? 50 : 76,
      xp: 50, w: 80, pr: {}, radius: c.radius ?? 8,
      wpl: null,
      color: c.color ?? "#FFFFFF", bg: c.box ? "pill" : "none",
      bg_color: c.box_color ?? "#0A0B0D", bg_alpha: c.box_alpha ?? 0.75,
      caps: !!c.uppercase, weight: c.weight ?? 800,
    };
    patchOverlayLocal(o.id, { sv, style: key, position: pos });
    patchOverlayDebounced(o.id, { sv, style: key, position: pos });
  }

  async function addOverlay() {
    if (readOnly) { setNote("source removed — this variant is read-only"); return; }
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
      sv: body.overlay.sv ?? null,
    }]);
    setTextTarget(body.overlay.id);
    setStale(true);
  }
  function patchOverlayLocal(id: string, patch: Partial<Ov>) {
    setOvs((o) => o.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  async function patchOverlay(id: string, patch: Record<string, unknown>) {
    if (readOnly) return;
    const res = await fetch(`/api/overlays/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) setStale(true);
    else setNote((await res.json().catch(() => ({}))).error ?? "overlay save failed");
  }
  function patchOverlayDebounced(id: string, patch: Record<string, unknown>) {
    pendingOvPatches.current[id] = { ...pendingOvPatches.current[id], ...patch };
    clearTimeout(ovSaveTimers.current[id]);
    ovSaveTimers.current[id] = setTimeout(() => {
      const p = pendingOvPatches.current[id];
      delete pendingOvPatches.current[id];
      if (p) void patchOverlay(id, p);
    }, 500);
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
  // Compare baseline player: follows the main player's clock so hook
  // differences are checked at the same playhead. Muted, display-only.
  const cmpVideoRef = useRef<HTMLVideoElement>(null);
  const syncCmp = useCallback((srcTime: number, playing: boolean) => {
    const c = cmpVideoRef.current;
    if (!c || !Number.isFinite(c.duration)) return;
    if (Math.abs(c.currentTime - srcTime) > 0.25) c.currentTime = srcTime;
    if (playing && c.paused) void c.play().catch(() => {});
    if (!playing && !c.paused) c.pause();
  }, []);
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
      syncCmp(OUT, false);
      return;
    }
    setT(Math.max(0, rel));
    syncCmp(v.currentTime, true);
    rafRef.current = requestAnimationFrame(tickRaf);
  }, [IN, OUT, syncCmp]);

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
    syncCmp(videoRef.current?.currentTime ?? IN, false);
  }, [syncCmp, IN]);
  const seek = useCallback((rel: number) => {
    const v = videoRef.current;
    const clamped = Math.max(0, Math.min(OUT - IN, rel));
    if (v) v.currentTime = IN + clamped;
    setT(clamped);
    syncCmp(IN + clamped, false);
  }, [IN, OUT, syncCmp]);
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

  // ----- reframe: one transform per (variant, ratio) -----
  const [fw, fh] = RATIO_SIZES[bRatio] ?? [1080, 1920];
  const srcW = variant.srcW > 20 ? variant.srcW : 1920;
  const srcH = variant.srcH > 20 ? variant.srcH : 1080;
  const [rfMap, setRfMap] = useState<Record<string, Reframe>>(
    () => ({ ...(variant.transforms ?? {}) }));
  const [staleR, setStaleR] = useState<string[]>(variant.staleRatios ?? []);
  /** Unset ratios default from 9:16's transform re-solved (clamped) for
   * the new frame — never from a blank. */
  const rfFor = useCallback((ratio: string): Reframe => {
    const [w, h] = RATIO_SIZES[ratio] ?? [1080, 1920];
    const base = rfMap[ratio] ?? rfMap["9x16"] ?? DEFAULT_TRANSFORM;
    return clampTransform({ ...DEFAULT_TRANSFORM, ...base }, srcW, srcH, w, h);
  }, [rfMap, srcW, srcH]);
  const rf = rfFor(bRatio);
  const frameAr = fw / fh;

  const srcRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // "drag to reframe" shows on the first hover only, then stays hidden
  const [hintSeen, setHintSeen] = useState(true);
  useEffect(() => {
    setHintSeen(localStorage.getItem("reframeHintSeen") === "1");
  }, []);
  const onCropLeave = () => {
    if (localStorage.getItem("reframeHintSeen") !== "1") {
      localStorage.setItem("reframeHintSeen", "1");
      setHintSeen(true);
    }
  };

  const rfTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRf = useCallback((t: Reframe, ratio: string) => {
    if (rfTimer.current) clearTimeout(rfTimer.current);
    rfTimer.current = setTimeout(() => {
      void fetch(`/api/variants/${variant.id}/reframe`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratio, ...t }),
      });
    }, 350);
  }, [variant.id]);
  /** Set the CURRENT ratio's transform: clamps, previews on the same
   * tick, marks only this variant+ratio stale, debounces the PATCH. */
  const setRf = useCallback((t: Reframe) => {
    const clamped = clampTransform(t, srcW, srcH, fw, fh);
    setRfMap((m) => ({ ...m, [bRatio]: clamped }));
    setStaleR((r) => r.includes(bRatio) ? r : [...r, bRatio]);
    commitRf(clamped, bRatio);
  }, [bRatio, srcW, srcH, fw, fh, commitRf]);

  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const rfHigh = framedHigh(srcW, srcH, fw, fh);
  const rfPreset = rf.mode === "fit" ? "fit"
    : near(rf.x, 0) && near(rf.y, 0) && near(rf.scale, 1) ? "centre"
    : near(rf.x, rfHigh.x) && near(rf.y, rfHigh.y) && near(rf.scale, rfHigh.scale) ? "high"
    : "custom";

  // drag to pan (shift constrains to one axis); wheel/pinch to scale
  // around the cursor; corner handles scale around the centre;
  // double-click resets to Centre
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  function onRfDown(e: React.PointerEvent) {
    if (readOnly || !scene || scene.layout === "card" || rf.mode === "fit") return;
    if ((e.target as Element).closest(".ovbox,.ovh,.rfh")) return;
    e.preventDefault();
    const pid = e.pointerId;
    pinchRef.current.set(pid, { x: e.clientX, y: e.clientY });
    if (pinchRef.current.size > 1) return; // second finger: pinch handles it
    try { (e.currentTarget as Element).setPointerCapture(pid); } catch {}
    const start = rf;
    const px0 = e.clientX, py0 = e.clientY;
    let pinchD0: number | null = null;
    let pinchT0 = start;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const r = srcRef.current?.getBoundingClientRect();
      if (!r) return;
      if (pinchRef.current.has(ev.pointerId))
        pinchRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinchRef.current.size >= 2) {
        const pts = [...pinchRef.current.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchD0 === null) { pinchD0 = d; pinchT0 = rfFor(bRatio); return; }
        const k = d / pinchD0;
        const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
        const ux = (mx - r.left) / r.width - 0.5, uy = (my - r.top) / r.height - 0.5;
        setRf({ ...pinchT0, scale: pinchT0.scale * k,
          x: ux - k * (ux - pinchT0.x), y: uy - k * (uy - pinchT0.y) });
        return;
      }
      if (ev.pointerId !== pid) return;
      let dx = (ev.clientX - px0) / r.width;
      let dy = (ev.clientY - py0) / r.height;
      if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      setRf({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const onUp = (ev: PointerEvent) => {
      pinchRef.current.delete(ev.pointerId);
      if (ev.pointerId !== pid && pinchRef.current.size > 0) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      pinchRef.current.clear();
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  function onRfWheel(e: React.WheelEvent) {
    if (readOnly || !scene || scene.layout === "card" || rf.mode === "fit") return;
    e.preventDefault();
    const r = srcRef.current?.getBoundingClientRect();
    if (!r) return;
    const k = Math.exp(-e.deltaY * 0.0015);
    const ux = (e.clientX - r.left) / r.width - 0.5;
    const uy = (e.clientY - r.top) / r.height - 0.5;
    setRf({ ...rf, scale: rf.scale * k,
      x: ux - k * (ux - rf.x), y: uy - k * (uy - rf.y) });
  }
  function onRfHandle(e: React.PointerEvent, cx: number, cy: number) {
    if (readOnly || rf.mode === "fit") return;
    e.preventDefault();
    e.stopPropagation();
    const pid = e.pointerId;
    try { (e.currentTarget as Element).setPointerCapture(pid); } catch {}
    const r = srcRef.current!.getBoundingClientRect();
    const centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const d0 = Math.max(20, Math.hypot(e.clientX - centre.x, e.clientY - centre.y));
    const start = rf;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const k = Math.hypot(ev.clientX - centre.x, ev.clientY - centre.y) / d0;
      setRf({ ...start, scale: start.scale * k, x: start.x * k, y: start.y * k });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  function onRfKey(e: React.KeyboardEvent) {
    if (readOnly || !scene || scene.layout === "card" || rf.mode === "fit") return;
    const step = (e.shiftKey ? 5 : 1) / 100;
    let next: Reframe | null = null;
    if (e.key === "ArrowLeft") next = { ...rf, x: rf.x - step };
    if (e.key === "ArrowRight") next = { ...rf, x: rf.x + step };
    if (e.key === "ArrowUp") next = { ...rf, y: rf.y - step };
    if (e.key === "ArrowDown") next = { ...rf, y: rf.y + step };
    if (next) { e.preventDefault(); setRf(next); }
  }

  // ----- filmstrip -----
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!workerUp || !variant.videoId) return;
    const [a, b] = ctx;
    const cacheKey = `${variant.videoId}:${a.toFixed(1)}:${b.toFixed(1)}`;
    const hit = FRAME_CACHE.get(cacheKey);
    if (hit) { setFrames(hit); return; }
    let dead = false;
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
        if (!dead) { FRAME_CACHE.set(cacheKey, grabbed); setFrames(grabbed); }
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
    if (readOnly) return;
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
        start = Math.max(0, Math.min(Math.max(clipDur - len, 0), snapT(start, ev.altKey)));
        end = start + len;
      } else if (mode === "l") {
        start = Math.max(0, Math.min(snapT(orig.start + dt, ev.altKey), orig.end - 0.3));
      } else {
        end = Math.min(clipDur, Math.max(snapT(orig.end + dt, ev.altKey), orig.start + 0.3));
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
      if (readOnly) return;
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
        }).then(() => {
          setStale(true); // shared range change stales every variant
          if (onDataChanged) onDataChanged(); else router.refresh();
        });
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

  // ----- overlay timing: scene boundaries on the output timeline -----
  const sceneBounds = useMemo(() => {
    const b = [0];
    let acc = 0;
    for (const s of scenes) { acc += sceneDur(s); b.push(acc); }
    return b;
  }, [scenes]);
  /** Snap to the nearest scene boundary within 0.2s; Alt disables. */
  const snapT = useCallback((v: number, alt?: boolean) => {
    if (alt) return v;
    let best = v;
    let bestD = 0.2;
    for (const b of sceneBounds) {
      const d = Math.abs(b - v);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }, [sceneBounds]);
  function commitOvTiming(o: Ov, field: "start" | "end", raw: string, alt: boolean) {
    let v = parseTs(raw);
    if (!Number.isFinite(v)) return false;         // revert
    v = snapT(v, alt);
    if (field === "start") {
      if (v >= o.end) return false;                // End must be after Start
      v = Math.max(0, Math.min(v, o.end - 0.1));
    } else {
      if (v <= o.start) return false;
      v = Math.min(clipDur, Math.max(v, o.start + 0.1));
    }
    const patch = field === "start" ? { start: v } : { end: v };
    patchOverlayLocal(o.id, patch);
    void patchOverlay(o.id, field === "start" ? { start_s: v } : { end_s: v });
    return true;
  }

  // ----- api helper -----
  const call = useCallback(async (url: string, method: string, body?: unknown) => {
    if (readOnly) { setNote("source removed — this variant is read-only"); return null; }
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
    if (onDataChanged) onDataChanged(); else router.refresh();
    return res.json().catch(() => ({}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, onDataChanged]);

  // ----- subtitle persistence (debounced, flushable) -----
  // Subtitles are VARIANT-level: restyling B never touches A. The pending
  // payload lives in a ref so a row switch can flush it before unloading.
  const pendingStyle = useRef<Record<string, unknown> | null>(null);
  const sendStyle = useCallback(async () => {
    const body = pendingStyle.current;
    if (!body) return;
    pendingStyle.current = null;
    await fetch(`/api/variants/${variant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, [variant.id]);
  const persistStyle = useCallback((nextOv: Record<string, unknown>, nextFixes: Record<string, string>, nextPreset: string | null) => {
    if (readOnly) return;
    pendingStyle.current = {
      subtitle_preset_id: nextPreset,
      subtitle_overrides: { ...nextOv, ...(Object.keys(nextFixes).length ? { fixes: nextFixes } : {}) },
    };
    setStale(true); // subtitles are part of the render fingerprint
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void sendStyle(), 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendStyle, readOnly]);

  // ----- flush: finish in-flight debounced saves before a row switch -----
  const pendingOvPatches = useRef<Record<string, Record<string, unknown>>>({});
  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // snapshot pending edits synchronously — nothing after this tick can
    // lose them, even though the caller no longer awaits us
    const styleBody = pendingStyle.current;
    pendingStyle.current = null;
    const ovPatches = Object.entries(pendingOvPatches.current);
    for (const [oid] of ovPatches) clearTimeout(ovSaveTimers.current[oid]);
    pendingOvPatches.current = {};
    if (!styleBody && !ovPatches.length) return;

    const vid = variant.id;
    const send = async () => {
      const reqs: Promise<Response>[] = [];
      if (styleBody)
        reqs.push(fetch(`/api/variants/${vid}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(styleBody), keepalive: true,
        }));
      for (const [oid, patch] of ovPatches)
        reqs.push(fetch(`/api/overlays/${oid}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch), keepalive: true,
        }));
      const results = await Promise.allSettled(reqs);
      const bad = results.filter(
        (r) => r.status === "rejected" || !(r as PromiseFulfilledResult<Response>).value.ok);
      if (bad.length) throw new Error(`${bad.length} save(s) failed`);
    };
    try {
      await send();
    } catch (e) {
      throw Object.assign(
        e instanceof Error ? e : new Error(String(e)), { retry: send });
    }
  }, [variant.id]);
  useEffect(() => { registerFlush?.(flush); }, [registerFlush, flush]);

  // expose the playhead (source seconds) so the workbench header's
  // "Split at playhead" can act on the loaded variant
  const tRef = useRef(0);
  useEffect(() => { tRef.current = IN + t; });
  useEffect(() => {
    registerApi?.({ getPlayheadS: () => tRef.current });
  }, [registerApi]);

  // approval transitions live in the player bar now
  const [moving, setMoving] = useState(false);
  async function moveStatus(to: string) {
    setMoving(true);
    const res = await fetch("/api/variants/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [variant.id], to }),
    });
    const body = await res.json().catch(() => ({}));
    setMoving(false);
    if (!res.ok || !body.moved) { setNote(body.error ?? "not a legal transition"); return; }
    if (onDataChanged) onDataChanged(); else router.refresh();
  }


  function setStyle(patch: Partial<Style>) {
    const next = { ...S, ...patch };
    setS(next);
    const ov = { ...styleOv };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "box") continue;              // superseded by bg
      const key = k === "bgColor" ? "bg_color"
        : k === "bgAlpha" ? "bg_alpha"
        : k === "olColor" ? "ol_color" : k;
      ov[key] = v;
    }
    setStyleOv(ov);
    persistStyle(ov, fixes, presetId);
  }
  function applyPreset(p: Preset) {
    const c = p.config as Record<string, unknown>;
    setPresetId(p.id);
    setStyleOv({});
    const bg = ["none", "pill", "box"].includes(String(c.bg))
      ? (String(c.bg) as Style["bg"]) : (c.box ? "box" : "none");
    setS({
      fs: Number(c.fs ?? 30), ol: Number(c.ol ?? 3), vp: Number(c.vp ?? 72),
      wpl: Number(c.wpl ?? 4), hl: String(c.hl ?? "#FFC629"),
      caps: !!c.caps, box: bg !== "none",
      color: String(c.color ?? "#FFFFFF"), bg,
      bgColor: String(c.bg_color ?? "#000000"),
      bgAlpha: Number(c.bg_alpha ?? 0.62),
      olColor: String(c.ol_color ?? "#000000"),
      font: FONTS.includes(String(c.font)) ? String(c.font) : "Plus Jakarta Sans",
      weight: Number(c.weight ?? 700),
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
        {/* one 40px bar replaces the old title block */}
        <div className="vbar">
          <button className="vbar-name" title="Click to rename in the row"
            onClick={() => onJumpToRename?.()}>
            {variant.name}
          </button>
          <span className="tag mk-pill">{variant.label}</span>
          <span className="tag">{variant.status.replace("_", " ")}</span>
          {variant.status === "draft" && !readOnly && (
            <button className="btn ghost sm" disabled={moving}
              onClick={() => void moveStatus("in_review")}>Submit</button>
          )}
          {variant.status === "in_review" && !readOnly && (
            <button className="btn ghost sm" disabled={moving}
              onClick={() => void moveStatus("approved")}>Approve</button>
          )}
          {variant.renderStatus && (
            <span className={variant.renderStatus === "done" ? "tag ok"
              : variant.renderStatus === "failed" ? "tag flag" : "tag"}
              title={variant.renderError ?? undefined}>
              {variant.renderStatus === "done" ? "rendered" : variant.renderStatus}
            </span>
          )}
          {(variant.ratios?.length ?? 0) > 0 && (
            <span className="vbar-dl" title="Finished renders — download the burned MP4 (SRT sidecar in the menu)">
              {variant.ratios!.map((rt) => (
                <a key={rt} className="exchip"
                  href={`/api/exports/${variant.id}/${rt}.mp4?dl=${encodeURIComponent(
                    exportFilename({ videoSource: variant.videoSource ?? "longform",
                      name: variant.name, label: variant.label }, rt, "mp4"))}`}>
                  ↓ {RATIOS[rt]?.label ?? rt}
                </a>
              ))}
              <a className="exchip" title="Subtitle sidecar — same remapped words as the burn"
                href={`/api/exports/${variant.id}/${variant.ratios![0]}.srt?dl=${encodeURIComponent(
                  exportFilename({ videoSource: variant.videoSource ?? "longform",
                    name: variant.name, label: variant.label }, variant.ratios![0], "srt"))}`}>
                ↓ SRT
              </a>
            </span>
          )}
          {(stale || staleR.includes(bRatio)) && (
            <span className="tag flag"
              title={stale ? "Changed since the last render"
                : `Reframe changed for ${RATIOS[bRatio].label} since its last render`}>
              stale
            </span>
          )}
          {readOnly && <span className="tag flag">source removed</span>}
          {compare && !readOnly && (
            <button className="chip" data-on={compareOn ? "1" : undefined}
              title={`Side-by-side against ${compare.label} at the same playhead`}
              onClick={() => onCompareToggle?.()}>
              Compare
            </button>
          )}
          <i className="chipsep" />
          <div className="seg rset">
            {exRatios.map((r) => (
              <span key={r} className="rtab">
                <button data-on={bRatio === r ? "1" : undefined}
                  title={`${RATIOS[r].use} · ${RATIOS[r].px}`}
                  onClick={() => setBRatio(r)}>
                  {RATIOS[r].label}
                  {rfMap[r] ? " ●" : ""}
                </button>
                {exRatios.length > 1 && !readOnly && (
                  <button className="rx" aria-label={`Remove ${RATIOS[r].label} from the export set`}
                    title="Remove from this variant's export set — it won't render or export"
                    onClick={() => void saveExportRatios(exRatios.filter((x) => x !== r))}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {exRatios.length < Object.keys(RATIOS).length && !readOnly && (
              <span className="rtab radd">
                <button aria-label="Add a ratio to the export set"
                  data-on={addRatioOpen ? "1" : undefined}
                  onClick={() => setAddRatioOpen((o) => !o)}>+</button>
                {addRatioOpen && (
                  <div className="addmenu on" style={{ minWidth: 130 }}>
                    {Object.keys(RATIOS).filter((r) => !exRatios.includes(r)).map((r) => (
                      <button key={r}
                        onClick={() => void saveExportRatios([...exRatios, r])}>
                        {RATIOS[r].label} <span style={{ color: "var(--faint)" }}>{RATIOS[r].use}</span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            )}
          </div>
          <label className="zone-tog">
            <input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} />
            {" "}Safe zones
          </label>
          {!readOnly && (
            <div className="seg rfseg" title="Reframe presets for this ratio">
              <button data-on={rfPreset === "centre" ? "1" : undefined}
                onClick={() => setRf({ ...DEFAULT_TRANSFORM, fit_color: rf.fit_color })}>
                Centre
              </button>
              <button data-on={rfPreset === "high" ? "1" : undefined}
                title="Window at the top of the source — the old default"
                onClick={() => setRf({ ...rfHigh, fit_color: rf.fit_color })}>
                High
              </button>
              <button data-on={rfPreset === "fit" ? "1" : undefined}
                title="Letterbox the whole source — colour from the brand swatches"
                onClick={() => setRf({ ...rf, mode: "fit" })}>
                Fit
              </button>
              {rfPreset === "custom" && (
                <button data-on="1" style={{ cursor: "default" }}>Custom</button>
              )}
            </div>
          )}
          {rf.mode === "fit" && !readOnly && (
            <span className="swatches rf-fit" title="Letterbox colour (stored per ratio)">
              {["#0A0B0D", "#FFFFFF", "#FFC629", "#14403C"].map((c) => (
                <button key={c} className="sw" style={{ background: c }}
                  data-on={rf.fit_color.toUpperCase() === c ? "1" : undefined}
                  aria-label={`Letterbox ${c}`}
                  onClick={() => setRf({ ...rf, fit_color: c })} />
              ))}
            </span>
          )}
          <span className="tag" title="Scene template shape">
            {shape === "custom" ? "Custom"
              : { plain: "Plain", product: "Product split", hookfirst: "Hook first + card" }[shape]}
          </span>
          <span style={{ flex: 1 }} />
          <a className="vbar-link" href={`/videos/${variant.videoId}`}>Back to transcript</a>
          <a className="vbar-link" href={`/variants/${variant.id}/preview`}>Preview</a>
        </div>

        {compareOn && compare && (
          <div className="cmp-note mono">
            Comparing against {compare.label} · {compare.name} — same playhead,
            each side shows its own overlays.
          </div>
        )}
        <div className={`stage${compareOn && compare ? " cmp" : ""}`}>
          {compareOn && compare && (
            <div className="src cmp-src" style={(() => {
              const ct = clampTransform(
                { ...DEFAULT_TRANSFORM,
                  ...(compare.transforms?.[bRatio] ?? compare.transforms?.["9x16"] ?? {}) },
                srcW, srcH, fw, fh);
              return {
                aspectRatio: `${frameAr}`,
                background: ct.mode === "fit" ? ct.fit_color : "#000",
                width: `min(48%, ${Math.round(420 * frameAr)}px)`,
              };
            })()}>
              {workerUp && (() => {
                const ct = clampTransform(
                  { ...DEFAULT_TRANSFORM,
                    ...(compare.transforms?.[bRatio] ?? compare.transforms?.["9x16"] ?? {}) },
                  srcW, srcH, fw, fh);
                return (
                  <video ref={cmpVideoRef} src={`/api/media/${variant.videoId}`}
                    preload="metadata" muted playsInline
                    style={{
                      position: "absolute",
                      width: ct.mode === "fit"
                        ? `${Math.min(1, srcAr / frameAr) * 100}%`
                        : `${ct.scale * Math.max(1, srcAr / frameAr) * 100}%`,
                      height: "auto", maxWidth: "none",
                      left: ct.mode === "fit" ? "50%" : `${50 + ct.x * 100}%`,
                      top: ct.mode === "fit" ? "50%" : `${50 + ct.y * 100}%`,
                      transform: "translate(-50%,-50%)",
                    }}
                    onLoadedMetadata={(e) => { e.currentTarget.currentTime = IN + t; }} />
                );
              })()}
              {compare.overlays.filter((o) => t >= o.start && t < o.end).map((o) => {
                const cfg = ovResolved(o);
                const cpl = ovPlace(o, bRatio);
                return (
                  <div key={o.id} style={{
                    position: "absolute", left: `${cpl.xp * 100}%`,
                    top: `${cpl.vp * 100}%`,
                    transform: "translate(-50%,-50%)", zIndex: 6,
                    width: `${cpl.w * 100}%`, textAlign: "center",
                    fontFamily: `'${cfg.font ?? "Plus Jakarta Sans"}',sans-serif`,
                    fontWeight: cfg.weight,
                    fontSize: cfg.fs * 0.4,
                    lineHeight: 1.15, whiteSpace: "pre-wrap",
                    color: cfg.color,
                    ...(cfg.bg !== "none" ? {
                      background: `${cfg.bg_color}${Math.round(cfg.bg_alpha * 255).toString(16).padStart(2, "0")}`,
                      padding: "3px 8px",
                      borderRadius: (cfg.radius ?? 8) * 0.4,
                    } : {}),
                  }}>
                    {wrapWpl(cfg.caps ? o.text.toUpperCase() : o.text, cfg.wpl)}
                  </div>
                );
              })}
              <span className="cmp-tag mono">{compare.label} · baseline</span>
            </div>
          )}
          {/* The .src box IS the displayed frame: sized to fit the stage on
              both axes at the source's aspect, so crop percentages measure
              the displayed frame exactly. With the header gone the player
              scales into the freed height; the cap still keeps the
              filmstrip + scenes strip on a 1080p screen. */}
          <div className="src" ref={srcRef} style={{
            aspectRatio: `${frameAr}`,
            background: rf.mode === "fit" ? rf.fit_color : "#000",
            width: compareOn && compare
              ? `min(48%, ${Math.round(420 * frameAr)}px)`
              : `min(100%, 540px, ${Math.round(420 * frameAr)}px)`,
          }}>
            {workerUp && !videoErr ? (
              <video
                ref={videoRef}
                src={`/api/media/${variant.videoId}`}
                crossOrigin="anonymous"
                preload="metadata"
                playsInline
                style={{
                  position: "absolute",
                  width: rf.mode === "fit"
                    ? `${Math.min(1, srcAr / frameAr) * 100}%`
                    : `${rf.scale * Math.max(1, srcAr / frameAr) * 100}%`,
                  height: "auto", maxWidth: "none",
                  left: rf.mode === "fit" ? "50%" : `${50 + rf.x * 100}%`,
                  top: rf.mode === "fit" ? "50%" : `${50 + rf.y * 100}%`,
                  transform: "translate(-50%,-50%)",
                }}
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
              <div className="cap" role="button" tabIndex={0}
                onClick={() => setTextTarget("subs")}
                style={{
                fontFamily: `'${S.font}',sans-serif`, fontWeight: S.weight,
                lineHeight: 1.22, fontSize: capFont, color: S.color,
                letterSpacing: "-.01em", cursor: "pointer",
                outline: textTarget === "subs" ? "1px dashed rgba(255,255,255,.45)" : "none",
                outlineOffset: 3,
                top: `${subVpWithOverlays(t, t + 0.4, ovs, bRatio, S.vp / 100, ovHasBg) * 100}%`,
                transform: "translateY(-50%)",
                textShadow: S.ol
                  ? `0 0 ${S.ol}px ${S.olColor},0 0 ${S.ol}px ${S.olColor},0 ${S.ol / 2}px ${S.ol}px rgba(0,0,0,.6)`
                  : "none",
                ...(S.bg !== "none"
                  ? { background: `${S.bgColor}${Math.round(Math.max(0, Math.min(1, S.bgAlpha)) * 255).toString(16).padStart(2, "0")}`,
                      padding: "5px 9px",
                      borderRadius: S.bg === "pill" ? 999 : 3 }
                  : {}),
              }}>
                <div>
                  {line.map((w, i) => (
                    <b key={i} style={{ color: tSrc >= w.s && tSrc < w.e ? S.hl : S.color }}>
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
              const cfg = ovResolved(o);
              const pl = ovPlace(o, bRatio);
              const isSel = textTarget === o.id;
              const text = wrapWpl(cfg.caps ? o.text.toUpperCase() : o.text, cfg.wpl);
              return (
                <div key={o.id} role="button" tabIndex={0}
                  className={`ovbox${isSel ? " sel" : ""}`}
                  title={isSel ? "Drag to move · handles resize" : "Click to edit this overlay"}
                  onClick={(e) => { e.stopPropagation(); setTextTarget(o.id); }}
                  onPointerDown={(e) => {
                    if (!isSel) return;
                    if ((e.target as Element).closest(".ovh")) return;
                    onOvDragDown(e, o, "move");
                  }}
                  style={{
                    position: "absolute",
                    left: `${pl.xp * 100}%`,
                    top: `${pl.vp * 100}%`,
                    width: `${pl.w * 100}%`,
                    transform: "translate(-50%,-50%)", zIndex: 6,
                    textAlign: "center",
                    cursor: isSel ? "move" : "pointer",
                  }}>
                  <span style={{
                    display: "inline-block", maxWidth: "100%",
                    fontFamily: `'${cfg.font ?? "Plus Jakarta Sans"}',sans-serif`,
                    fontWeight: cfg.weight,
                    fontSize: cfg.fs * 0.48,
                    lineHeight: 1.15, whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    color: cfg.color,
                    textShadow: cfg.bg === "none" && cfg.ol
                      ? `0 0 ${cfg.ol}px ${cfg.ol_color ?? "#000"},0 0 ${cfg.ol}px ${cfg.ol_color ?? "#000"}` : undefined,
                    ...(cfg.bg !== "none" ? {
                      background: `${cfg.bg_color}${Math.round(cfg.bg_alpha * 255).toString(16).padStart(2, "0")}`,
                      padding: "4px 10px",
                      borderRadius: (cfg.radius ?? 8) * 0.48,
                    } : {}),
                  }}>
                    {text}
                  </span>
                  {isSel && !readOnly && (
                    <>
                      <i className="ovh side w" onPointerDown={(e) => onOvDragDown(e, o, "w")} />
                      <i className="ovh side e" onPointerDown={(e) => onOvDragDown(e, o, "e")} />
                      <i className="ovh corner nw" onPointerDown={(e) => onOvDragDown(e, o, "nw")} />
                      <i className="ovh corner ne" onPointerDown={(e) => onOvDragDown(e, o, "ne")} />
                      <i className="ovh corner sw" onPointerDown={(e) => onOvDragDown(e, o, "sw")} />
                      <i className="ovh corner se" onPointerDown={(e) => onOvDragDown(e, o, "se")} />
                    </>
                  )}
                </div>
              );
            })}
            {eyedrop && (
              <div className="eyedrop-layer" title="Click to sample this pixel"
                onPointerDown={sampleFrame} />
            )}
            {/* drag guides: centre lines + the ratio's safe-zone edges */}
            {ovDrag && (
              <>
                <i className={`ovguide v${ovDrag.snapX ? " on" : ""}`} style={{ left: "50%" }} />
                <i className={`ovguide h${ovDrag.snapY ? " on" : ""}`} style={{ top: "50%" }} />
                <i className="ovguide h zone" style={{ top: `${sz.t}%` }} />
                <i className="ovguide h zone" style={{ top: `${100 - sz.b}%` }} />
              </>
            )}

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
              >
                {!scene.asset && (
                  <div className="card-ph">
                    <b>End card</b>
                    <span>
                      No brand asset selected — it renders as this dark card.
                      Pick one in the Scene panel, or upload stills under{" "}
                      <a href="/assets">Setup → Brand assets</a>.
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* reframe layer: drag pans, wheel/pinch scales around the
                cursor, corner handles scale around the centre, double-click
                resets, arrows nudge 1% (shift 5%) */}
            {scene && scene.layout !== "card" && (
              <div
                className={`rf-layer${dragging ? " drag" : ""}${zones ? " zones" : ""}`}
                tabIndex={0}
                role="application"
                aria-label="Reframe — drag to pan, scroll to scale"
                onPointerDown={onRfDown}
                onWheel={onRfWheel}
                onDoubleClick={() => setRf({ ...DEFAULT_TRANSFORM })}
                onPointerLeave={onCropLeave}
                onKeyDown={onRfKey}
              >
                <div className="zone t" style={{ height: `${sz.t}%` }}><span>TOP</span></div>
                <div className="zone b" style={{ height: `${sz.b}%` }}><span>BOTTOM</span></div>
                {!readOnly && rf.mode !== "fit" && (
                  <>
                    <b className="rfh tl" onPointerDown={(e) => onRfHandle(e, -1, -1)} />
                    <b className="rfh tr" onPointerDown={(e) => onRfHandle(e, 1, -1)} />
                    <b className="rfh bl" onPointerDown={(e) => onRfHandle(e, -1, 1)} />
                    <b className="rfh br2" onPointerDown={(e) => onRfHandle(e, 1, 1)} />
                  </>
                )}
                {!hintSeen && (
                  <div className="crop-hint">
                    drag to pan · scroll to scale · double-click resets
                  </div>
                )}
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

        {/* transport */}
        <div className="transport">
          <span className="trim-blk mono">
            <span className="fld">In <input type="text" className="mono" readOnly value={fmt(IN)} /></span>
            <span className="fld">Out <input type="text" className="mono" readOnly value={fmt(OUT)} /></span>
            <b>{clipDur.toFixed(1)}s</b>
          </span>
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

        {scenesSlot}
        {note && <p className="hint">{note}</p>}
      </div>

      {/* ---------- sidebar ---------- */}
      <div className="card pad">
        <Acc title="Template" sum={shape === "custom" ? "Custom" : { plain: "Plain", product: "Product split", hookfirst: "Hook first + card" }[shape]}>
          <div className="presets" style={{ marginBottom: 2 }}>
            {([["plain", "Plain"], ["product", "Product split"], ["hookfirst", "Hook first + card"]] as const).map(([k, lbl]) => (
              <button key={k} className="chip" data-on={shape === k ? "1" : undefined}
                disabled={busy}
                onClick={() => void call(`/api/variants/${variant.id}/template`, "POST", { key: k }).then(() => onSelectScene(0))}>
                {lbl}
              </button>
            ))}
            {shape === "custom" && <span className="chip" data-on="1" style={{ cursor: "default" }}>Custom</span>}
          </div>
        </Acc>

        <Acc title="Assets" sum={`${assets.length} in library`}>
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
              No brand assets yet — upload product stills and end cards under{" "}
              <a href="/assets">Setup → Brand assets</a>. They appear here,
              in splits, and on end cards.
            </p>
          )}
          {assets.length > 0 && (
            <p style={{ fontSize: 10.5, color: "var(--muted)", margin: "4px 0 0" }}>
              Click to drop into the selected scene.
            </p>
          )}
        </Acc>

        {/* Layout itself moved onto the scene card (glyph popover); this
            section keeps the per-scene extras: asset slot, split ratio,
            lift, audio. */}
        <Acc title="Scene"
          sum={scene ? [LY_NAME[scene.layout],
            scene.layout.startsWith("split")
              ? `${Math.round(scene.splitRatio * 100)}/${Math.round((1 - scene.splitRatio) * 100)}`
              : null].filter(Boolean).join(" · ") : ""}>
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

        <Acc title="Overlays" sum={ovs.length ? `${ovs.length} on variant` : "none"} defaultOpen>
          {stale && (
            <div className="ov-stale">
              Changed since the last render — the export is stale.
              <button className="btn sm" disabled={busy}
                onClick={() => void call(`/api/variants/${variant.id}/render`, "POST", { ratio: bRatio })
                  .then(() => { setStale(false); setNote(`re-render queued (${RATIOS[bRatio].label})`); })}>
                Re-render
              </button>
            </div>
          )}
          {ovs.map((o, oi) => (
            <div key={o.id}
              className={`ovrow${textTarget === o.id ? " sel" : ""}`}
              onClick={() => setTextTarget(o.id)}>
              <textarea rows={2} value={o.text}
                onFocus={() => setTextTarget(o.id)}
                onChange={(e) => {
                  patchOverlayLocal(o.id, { text: e.target.value });
                  patchOverlayDebounced(o.id, { text: e.target.value });
                }} />
              <div className="ovmeta">
                <span className="mono ovlbl">Overlay {oi + 1}</span>
                <TimingField label="Start" value={o.start}
                  onFocusSeek={() => seek(o.start)}
                  onCommit={(raw, alt) => commitOvTiming(o, "start", raw, alt)} />
                <span className="mono ovdash">–</span>
                <TimingField label="End" value={o.end}
                  onFocusSeek={() => seek(o.end)}
                  onCommit={(raw, alt) => commitOvTiming(o, "end", raw, alt)} />
                <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
                  {(o.end - o.start).toFixed(1)}s
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn ghost sm" disabled={suggesting}
                  title="Three hook options from Claude — accepting one replaces the TEXT only; your style and timing stay put"
                  onClick={() => void suggestHook(o)}>
                  {suggesting && suggestFor === o.id ? "…" : "Suggest hook"}
                </button>
                <button className="btn ghost sm" aria-label="Delete overlay"
                  onClick={() => {
                    if (textTarget === o.id) setTextTarget("subs");
                    void delOverlay(o.id);
                  }}>✕</button>
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
          <button className="btn sm" style={{ width: "100%" }}
            onClick={() => void addOverlay()}>
            + Overlay
          </button>
        </Acc>

        <Acc title={`Text style — ${targetOv ? `Overlay ${ovs.findIndex((o) => o.id === targetOv.id) + 1}` : "Subtitles"}`}
          sum={targetOv
            ? `${targetOv.style === "custom" ? "Custom" : (overlayStyles.find((x) => x.key === targetOv.style)?.name ?? targetOv.style)} · ${ovResolved(targetOv).fs}px`
            : `${activePresetName} · ${S.fs}px`}
          defaultOpen>
          {targetOv ? (() => {
            const tv = ovResolved(targetOv);
            const pv = placeFor(targetOv);
            return (
              <>
                <div className="presets">
                  {overlayStyles.map((p) => (
                    <button key={p.key} className="chip"
                      data-on={targetOv.style === p.key ? "1" : undefined}
                      onClick={() => applyOvPreset(targetOv, p.key)}>
                      {p.name}
                    </button>
                  ))}
                  {targetOv.style === "custom" && (
                    <span className="chip" data-on="1" style={{ cursor: "default" }}>Custom</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className="chip" title="Edit the subtitle track's style instead"
                    onClick={() => setTextTarget("subs")}>
                    ← Subtitles
                  </button>
                </div>
                <div className="ctrl">
                  <label htmlFor="ovfont">Font</label>
                  <select id="ovfont" value={tv.font ?? "Plus Jakarta Sans"}
                    onChange={(e) => patchSv(targetOv, { font: e.target.value })}>
                    {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="ctrl">
                  <label>Weight</label>
                  <div className="presets" style={{ margin: 0 }}>
                    {WEIGHT_OPTS.map(([w, lbl]) => (
                      <button key={w} className="chip"
                        data-on={(tv.weight >= 600 ? 700 : tv.weight) === w ? "1" : undefined}
                        onClick={() => patchSv(targetOv, { weight: w })}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ctrl">
                  <label>Position quick-set ({RATIOS[bRatio].label})</label>
                  <select value=""
                    onChange={(e) => {
                      const m: Record<string, [number, number]> = {
                        tl: [22, 20], t: [50, 20], tr: [78, 20],
                        c: [50, 50], lt: [50, 76], bl: [22, 88], br: [78, 88],
                      };
                      const hit = m[e.target.value];
                      if (hit) patchPlace(targetOv, { xp: hit[0], vp: hit[1] });
                      e.target.value = "";
                    }}>
                    <option value="">Position…</option>
                    <option value="tl">Top-left</option>
                    <option value="t">Top</option>
                    <option value="tr">Top-right</option>
                    <option value="c">Centre</option>
                    <option value="lt">Lower third</option>
                    <option value="bl">Bottom-left</option>
                    <option value="br">Bottom-right</option>
                  </select>
                </div>
                <div className="ctrl">
                  <label htmlFor="ovfs">Size <b>{Math.round(tv.fs)}px</b></label>
                  <input id="ovfs" type="range" min={20} max={90} value={tv.fs}
                    onChange={(e) => patchSv(targetOv, { fs: +e.target.value })} />
                </div>
                <div className="ctrl">
                  <label htmlFor="ovol">Outline <b>{tv.ol}px</b></label>
                  <input id="ovol" type="range" min={0} max={8} value={tv.ol}
                    onChange={(e) => patchSv(targetOv, { ol: +e.target.value })} />
                </div>
                <div className="ctrl">
                  <label htmlFor="ovvp">Vertical position <b>{Math.round(pv.vp)}%</b></label>
                  <input id="ovvp" type="range" min={3} max={97} value={Math.round(pv.vp)}
                    onChange={(e) => patchPlace(targetOv, { vp: +e.target.value })} />
                </div>
                <div className="ctrl">
                  <label htmlFor="ovxp">Horizontal position <b>{Math.round(pv.xp)}%</b></label>
                  <input id="ovxp" type="range" min={5} max={95} value={Math.round(pv.xp)}
                    onChange={(e) => patchPlace(targetOv, { xp: +e.target.value })} />
                </div>
                <div className="ctrl">
                  <label htmlFor="ovw">Width <b>{Math.round(pv.w)}%</b></label>
                  <input id="ovw" type="range" min={10} max={100} value={Math.round(pv.w)}
                    onChange={(e) => patchPlace(targetOv, { w: +e.target.value })} />
                </div>
                <div className="ctrl">
                  <label htmlFor="ovwpl">Words per line <b>{tv.wpl ?? "manual"}</b></label>
                  <input id="ovwpl" type="range" min={0} max={8} value={tv.wpl ?? 0}
                    title="0 keeps your manual line breaks"
                    onChange={(e) => patchSv(targetOv, { wpl: +e.target.value || null })} />
                </div>
                <div className="ctrl">
                  <label>Background</label>
                  <div className="presets" style={{ margin: 0 }}>
                    {(["none", "pill", "box"] as const).map((bgv) => (
                      <button key={bgv} className="chip" data-on={tv.bg === bgv ? "1" : undefined}
                        onClick={() => patchSv(targetOv, { bg: bgv })}>
                        {bgv}
                      </button>
                    ))}
                  </div>
                </div>
                <ColorControl label="Text colour" value={tv.color}
                  swatches={TEXT_COLORS} onEyedrop={startEyedrop}
                  onPick={(h) => patchSv(targetOv, { color: h })} />
                {tv.bg === "none" && (
                  <ColorControl label="Outline colour" value={tv.ol_color ?? "#000000"}
                    swatches={OUTLINE_COLORS} onEyedrop={startEyedrop}
                    onPick={(h) => patchSv(targetOv, { ol_color: h })} />
                )}
                {tv.bg !== "none" && (
                  <>
                    <ColorControl label="Background colour" value={tv.bg_color}
                      swatches={BG_COLORS} onEyedrop={startEyedrop}
                      onPick={(h) => patchSv(targetOv, { bg_color: h })}
                      extra={
                        <button className="sw transparent"
                          data-on={tv.bg_alpha === 0 ? "1" : undefined}
                          title="Transparent — keeps the box geometry, so subtitle push-down turns off without losing the layout"
                          aria-label="Background transparent"
                          onClick={() => patchSv(targetOv, { bg_alpha: 0 })} />
                      } />
                    <div className="ctrl">
                      <label htmlFor="ovba">Opacity <b>{Math.round(tv.bg_alpha * 100)}%</b></label>
                      <input id="ovba" type="range" min={0} max={100}
                        value={Math.round(tv.bg_alpha * 100)}
                        title="Background only — the text keeps full opacity"
                        onChange={(e) => patchSv(targetOv, { bg_alpha: +e.target.value / 100 })} />
                    </div>
                    <div className="ctrl">
                      <label htmlFor="ovrad">Radius <b>{Math.round(tv.radius ?? 8)}px</b></label>
                      <input id="ovrad" type="range" min={0} max={40}
                        value={Math.round(tv.radius ?? 8)}
                        title="Background corner radius at 1080 output width"
                        onChange={(e) => patchSv(targetOv, { radius: +e.target.value })} />
                    </div>
                  </>
                )}
                <label className="toggle">
                  <input type="checkbox" checked={tv.caps}
                    onChange={(e) => patchSv(targetOv, { caps: e.target.checked })} />
                  All caps
                </label>
              </>
            );
          })() : (
            <>
              <div className="presets">
                {presets.map((p) => (
                  <button key={p.id} className="chip"
                    data-on={presetId === p.id && !Object.keys(styleOv).length ? "1" : undefined}
                    onClick={() => applyPreset(p)}>
                    {p.name}
                  </button>
                ))}
                {Object.keys(styleOv).length > 0 && (
                  <span className="chip" data-on="1" style={{ cursor: "default" }}>Custom</span>
                )}
              </div>
              <div className="ctrl">
                <label htmlFor="subfont">Font</label>
                <select id="subfont" value={S.font}
                  onChange={(e) => setStyle({ font: e.target.value })}>
                  {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="ctrl">
                <label>Weight</label>
                <div className="presets" style={{ margin: 0 }}>
                  {WEIGHT_OPTS.map(([w, lbl]) => (
                    <button key={w} className="chip"
                      data-on={S.weight === w ? "1" : undefined}
                      onClick={() => setStyle({ weight: w })}>
                      {lbl}
                    </button>
                  ))}
                </div>
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
                <label>Background</label>
                <div className="presets" style={{ margin: 0 }}>
                  {(["none", "pill", "box"] as const).map((bgv) => (
                    <button key={bgv} className="chip" data-on={S.bg === bgv ? "1" : undefined}
                      onClick={() => setStyle({ bg: bgv, box: bgv !== "none" })}>
                      {bgv}
                    </button>
                  ))}
                </div>
              </div>
              <ColorControl label="Text colour" value={S.color}
                swatches={TEXT_COLORS} onEyedrop={startEyedrop}
                onPick={(h) => setStyle({ color: h })} />
              {S.bg === "none" && (
                <ColorControl label="Outline colour" value={S.olColor}
                  swatches={OUTLINE_COLORS} onEyedrop={startEyedrop}
                  onPick={(h) => setStyle({ olColor: h })} />
              )}
              {S.bg !== "none" && (
                <>
                  <ColorControl label="Background colour" value={S.bgColor}
                    swatches={BG_COLORS} onEyedrop={startEyedrop}
                    onPick={(h) => setStyle({ bgColor: h })}
                    extra={
                      <button className="sw transparent"
                        data-on={S.bgAlpha === 0 ? "1" : undefined}
                        title="Transparent background"
                        aria-label="Background transparent"
                        onClick={() => setStyle({ bgAlpha: 0 })} />
                    } />
                  <div className="ctrl">
                    <label htmlFor="subba">Opacity <b>{Math.round(S.bgAlpha * 100)}%</b></label>
                    <input id="subba" type="range" min={0} max={100}
                      value={Math.round(S.bgAlpha * 100)}
                      onChange={(e) => setStyle({ bgAlpha: +e.target.value / 100 })} />
                  </div>
                </>
              )}
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
            </>
          )}
        </Acc>

        <Acc title="Transcript fix">
          <FixEditor fixes={fixes} onAdd={addFix} onDrop={dropFix} />
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 5 }}>
            Corrections apply to this clip only. The source transcript is untouched.
          </p>
        </Acc>

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

const OUTLINE_COLORS = ["#000000", "#FFFFFF", "#FFC629", "#14403C"];

/** One colour control: brand swatches, then a rainbow toggle that opens
 * the full picker (SB square, hue, hex, eyedropper, recent colours). */
function ColorControl({ label, value, swatches, extra, onPick, onEyedrop }: {
  label: string; value: string; swatches: string[];
  extra?: React.ReactNode;
  onPick: (hex: string) => void;
  onEyedrop?: (apply: (hex: string) => void) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ctrl">
      <label>{label}</label>
      <div className="swatches">
        {swatches.map((c) => (
          <button key={c} className="sw" style={{ background: c }}
            data-on={value.toUpperCase() === c.toUpperCase() ? "1" : undefined}
            aria-label={`${label} ${c}`}
            onClick={() => onPick(c.toUpperCase())} />
        ))}
        {extra}
        <button className="sw rainbow" data-on={open ? "1" : undefined}
          title="Custom colour…" aria-label={`${label} custom`}
          onClick={() => setOpen((o) => !o)} />
      </div>
      {open && <ColorPicker value={value} onPick={onPick} onEyedrop={onEyedrop} />}
    </div>
  );
}

/** Editable timecode field (same format as the clip's In/Out). Enter or
 * blur commits; Esc reverts; Alt+Enter commits without scene-boundary
 * snapping. Focusing scrubs the player so you see what the text lands on. */
function TimingField({ label, value, onFocusSeek, onCommit }: {
  label: string; value: number;
  onFocusSeek?: () => void;
  onCommit: (raw: string, alt: boolean) => boolean;
}) {
  const [txt, setTxt] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  const [bad, setBad] = useState(false);
  const skipBlur = useRef(false);
  useEffect(() => {
    if (!focused) { setTxt(fmt(value)); setBad(false); }
  }, [value, focused]);
  return (
    <input className={`mono ovtime${bad ? " bad" : ""}`} type="text"
      value={txt} aria-label={label} spellCheck={false}
      title={`${label} — edges snap to scene boundaries within 0.2s; hold Alt to disable`}
      onFocus={() => { setFocused(true); onFocusSeek?.(); }}
      onChange={(e) => { setTxt(e.target.value); setBad(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const ok = onCommit(txt, e.altKey);
          setBad(!ok);
          if (ok) { skipBlur.current = true; (e.target as HTMLInputElement).blur(); }
        }
        if (e.key === "Escape") {
          setTxt(fmt(value)); setBad(false);
          skipBlur.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={() => {
        setFocused(false);
        if (skipBlur.current) { skipBlur.current = false; setBad(false); return; }
        const parsed = parseTs(txt);
        if (Number.isFinite(parsed) && Math.abs(parsed - value) < 0.0005) {
          setTxt(fmt(value)); setBad(false); return;
        }
        if (txt !== fmt(value)) {
          const ok = onCommit(txt, false);
          setBad(!ok);
          if (!ok) setTxt(fmt(value));
        }
      }} />
  );
}

function Acc({ title, sum, children }: {
  title: string; sum?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  // All sections load closed; a section the user opens stays open for the
  // session (per user, sessionStorage), keyed by the section name.
  const key = `acc:${title.split(" — ")[0]}`;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { if (sessionStorage.getItem(key) === "1") setOpen(true); } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = () => {
    setOpen((o) => {
      try { sessionStorage.setItem(key, o ? "0" : "1"); } catch {}
      return !o;
    });
  };
  return (
    <div className="acc" data-open={open ? "1" : "0"}>
      <button className="acc-h" aria-expanded={open} onClick={toggle}>
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
