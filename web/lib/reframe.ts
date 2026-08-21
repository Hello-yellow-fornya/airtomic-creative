/** Reframe math — PORT of worker/reframe.py. Change BOTH or neither;
 * tests/fixtures/reframe.json pins the two to identical output, so the
 * CSS preview and the ffmpeg burn resolve from one function. */

export type Reframe = {
  x: number; y: number; scale: number;
  mode: "cover" | "fit"; fit_color: string;
};

export type Win = { x: number; y: number; w: number; h: number };

export const DEFAULT_TRANSFORM: Reframe = {
  x: 0, y: 0, scale: 1, mode: "cover", fit_color: "#0A0B0D",
};

export const RATIO_SIZES: Record<string, [number, number]> = {
  "9x16": [1080, 1920],
  "4x5": [1080, 1350],
  "1x1": [1080, 1080],
  "1.91x1": [1200, 628],
};

export function transformToWindow(
  t: Reframe, srcW: number, srcH: number, frameW: number, frameH: number,
): Win {
  if (t.mode === "fit") return { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.max(0.05, t.scale);
  const fill = Math.max(frameW / srcW, frameH / srcH);
  const s = scale * fill;
  const winW = frameW / s / srcW;
  const winH = frameH / s / srcH;
  const cx = 0.5 - (t.x * frameW) / s / srcW;
  const cy = 0.5 - (t.y * frameH) / s / srcH;
  return { x: cx - winW / 2, y: cy - winH / 2, w: winW, h: winH };
}

export function windowToTransform(
  win: Win, srcW: number, srcH: number, frameW: number, frameH: number,
): { x: number; y: number; scale: number } {
  const fill = Math.max(frameW / srcW, frameH / srcH);
  const s = frameW / (win.w * srcW);
  const cx = win.x + win.w / 2;
  const cy = win.y + win.h / 2;
  return {
    x: ((0.5 - cx) * srcW * s) / frameW,
    y: ((0.5 - cy) * srcH * s) / frameH,
    scale: s / fill,
  };
}

export function clampTransform(
  t: Reframe, srcW: number, srcH: number, frameW: number, frameH: number,
): Reframe {
  if (t.mode === "fit") return t;
  const scale = Math.max(1, t.scale);
  const fill = Math.max(frameW / srcW, frameH / srcH);
  const s = scale * fill;
  const overX = Math.max(0, (s * srcW / frameW - 1) / 2);
  const overY = Math.max(0, (s * srcH / frameH - 1) / 2);
  return {
    ...t,
    scale,
    x: Math.max(-overX, Math.min(overX, t.x)),
    y: Math.max(-overY, Math.min(overY, t.y)),
  };
}

export function framedHigh(
  srcW: number, srcH: number, frameW: number, frameH: number,
): Reframe {
  const win = transformToWindow(DEFAULT_TRANSFORM, srcW, srcH, frameW, frameH);
  if (win.h >= 0.999) return { ...DEFAULT_TRANSFORM };
  const t = windowToTransform(
    { x: win.x, y: 0, w: win.w, h: win.h }, srcW, srcH, frameW, frameH);
  return { ...DEFAULT_TRANSFORM, ...t };
}
