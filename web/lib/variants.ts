import type { PoolClient } from "pg";
import { pool } from "@/lib/db";

/** Variant naming + render-staleness helpers for the variant-first model.
 * Names feed export filenames and ad-name parsing when a variant is
 * pushed to Meta, so they are kept parse-friendly: no slashes, trimmed,
 * bounded. Uniqueness is enforced within the SOURCE video (not just the
 * clip) because exports from sibling clips land in the same folder. */

export const sanitizeName = (raw: string) =>
  raw.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);

export const shortTitle = (t: string | null) => {
  const s = t ?? "untitled source";
  return s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s;
};

export const defaultVariantName = (
  title: string | null, inS: number, outS: number, label: string,
) => `${shortTitle(title)} · ${inS.toFixed(0)}s–${outS.toFixed(0)}s · ${label}`;

/** True when another variant on the same source video already uses the
 * name. Runs inside the caller's transaction when given a client. */
export async function nameTaken(
  db: PoolClient, videoId: string, name: string, excludeVariantId?: string,
): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM clip_variants cv
     JOIN clips c ON c.id = cv.clip_id
     WHERE c.video_id = $1 AND cv.name = $2
       AND ($3::uuid IS NULL OR cv.id <> $3::uuid)
     LIMIT 1`,
    [videoId, name, excludeVariantId ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

const STALE_SQL = `UPDATE clip_variants SET render_stale = EXISTS(
   SELECT 1 FROM jobs WHERE type = 'render'
   AND payload->>'variant_id' = clip_variants.id::text AND status = 'done')`;

/** Everything variant-level is part of the render fingerprint — overlays,
 * scene order, trims, reframe, subtitles. Editing any of it marks ONLY
 * that variant stale. */
export async function markStaleVariant(variantId: string, db?: PoolClient) {
  await (db ?? pool).query(`${STALE_SQL} WHERE id = $1::uuid`, [variantId]);
}

/** A scene edit stales the variant that owns the scene. */
export async function markStaleForScene(sceneId: string, db?: PoolClient) {
  await (db ?? pool).query(
    `${STALE_SQL} WHERE id = (SELECT variant_id FROM variant_scenes WHERE id = $1::uuid)`,
    [sceneId],
  );
}

/** The shared source range is clip-level: trimming it stales every
 * variant of the clip. */
export async function markStaleForClip(clipId: string, db?: PoolClient) {
  await (db ?? pool).query(`${STALE_SQL} WHERE clip_id = $1::uuid`, [clipId]);
}
