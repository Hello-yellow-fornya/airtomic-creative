import { pool } from "@/lib/db";

/** Mark the variant stale when it already has a finished render — the UI
 * then offers "Re-render" instead of silently re-queueing. Cleared when a
 * render is requested. */
export async function markStale(variantId: string) {
  await pool.query(
    `UPDATE clip_variants SET render_stale = EXISTS(
       SELECT 1 FROM jobs WHERE type = 'render'
       AND payload->>'variant_id' = $1::text AND status = 'done')
     WHERE id = $1::uuid`,
    [variantId],
  );
}

/** Position quick-set -> vertical position %, at the 9:16 reference. */
export const POSITION_VP: Record<string, number> = {
  top: 20, center: 50, lower_third: 76,
};

export type Placement = { xp: number; vp: number; w: number };
export type Sv = {
  fs: number; ol: number; vp: number; wpl: number | null;
  xp: number; w: number;
  /** per-ratio placement overrides, like crops; 9x16 lives in the base
   * xp/vp/w fields and other ratios default from it when unset */
  pr?: Record<string, Placement>;
  color: string; bg: "none" | "pill" | "box"; bg_color: string;
  bg_alpha: number; caps: boolean; weight: number;
};

const RATIO_KEYS = ["9x16", "4x5", "1x1", "1.91x1"];

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Validate + clamp a client-supplied sv object. Returns null when the
 * shape is unusable. */
export function sanitizeSv(raw: unknown): Sv | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const bg = ["none", "pill", "box"].includes(String(r.bg))
    ? (String(r.bg) as Sv["bg"]) : "none";
  let pr: Record<string, Placement> | undefined;
  if (r.pr && typeof r.pr === "object") {
    pr = {};
    for (const [k, v] of Object.entries(r.pr as Record<string, unknown>)) {
      if (!RATIO_KEYS.includes(k) || !v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      pr[k] = {
        xp: clamp(Number(o.xp) || 50, 0, 100),
        vp: clamp(Number(o.vp) || 50, 0, 100),
        w: clamp(Number(o.w) || 80, 10, 100),
      };
    }
    if (!Object.keys(pr).length) pr = undefined;
  }
  return {
    fs: clamp(Number(r.fs) || 40, 10, 120),
    ol: clamp(Number(r.ol) || 0, 0, 12),
    vp: clamp(Number(r.vp) || 50, 0, 100),
    xp: clamp(Number(r.xp ?? 50) || 50, 0, 100),
    w: clamp(Number(r.w ?? 80) || 80, 10, 100),
    ...(pr ? { pr } : {}),
    wpl: r.wpl == null ? null : clamp(Math.round(Number(r.wpl)) || 3, 1, 8),
    color: HEX.test(String(r.color)) ? String(r.color) : "#FFFFFF",
    bg,
    bg_color: HEX.test(String(r.bg_color)) ? String(r.bg_color) : "#0A0B0D",
    bg_alpha: clamp(Number(r.bg_alpha ?? 0.75), 0, 1),
    caps: !!r.caps,
    weight: clamp(Math.round(Number(r.weight) || 800), 400, 900),
  };
}

/** Resolve a preset row's config into stored values — the preset is only
 * a seed; retuning it later never restyles existing overlays. */
export function svFromPreset(
  config: Record<string, unknown>, position: string,
): Sv {
  return {
    fs: Number(config.fs ?? 40),
    ol: 0,
    vp: POSITION_VP[position] ?? 50,
    xp: 50,
    w: 80,
    wpl: null,
    color: String(config.color ?? "#FFFFFF"),
    bg: config.box ? "pill" : "none",
    bg_color: String(config.box_color ?? "#0A0B0D"),
    bg_alpha: Number(config.box_alpha ?? 0.75),
    caps: !!config.uppercase,
    weight: Number(config.weight ?? 800),
  };
}
