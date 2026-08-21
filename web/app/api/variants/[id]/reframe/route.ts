import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

const RATIOS = ["9x16", "4x5", "1x1", "1.91x1"];
const HEX = /^#[0-9A-Fa-f]{6}$/;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Upsert the reframe transform for one (variant, ratio) and mark ONLY
 * that variant and that ratio stale. Values are stored resolved —
 * presets and manual edits write the same shape. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  const b = await req.json().catch(() => ({}));
  const ratio = String(b.ratio ?? "");
  if (!RATIOS.includes(ratio))
    return NextResponse.json({ error: "unknown ratio" }, { status: 400 });
  const mode = b.mode === "fit" ? "fit" : "cover";
  const x = clamp(Number(b.x) || 0, -8, 8);
  const y = clamp(Number(b.y) || 0, -8, 8);
  const scale = clamp(Number(b.scale) || 1, 0.05, 8);
  const fitColor = HEX.test(String(b.fit_color)) ? String(b.fit_color).toUpperCase() : "#0A0B0D";

  const res = await pool.query(
    `WITH up AS (
       INSERT INTO variant_transforms (variant_id, ratio, tx, ty, scale, mode, fit_color, updated_at)
       VALUES ($1, $2::output_ratio, $3, $4, $5, $6, $7, now())
       ON CONFLICT (variant_id, ratio) DO UPDATE
         SET tx = $3, ty = $4, scale = $5, mode = $6, fit_color = $7, updated_at = now()
       RETURNING variant_id
     )
     UPDATE clip_variants cv
       SET stale_ratios = (SELECT array_agg(DISTINCT r)
                           FROM unnest(cv.stale_ratios || $2::text) AS r)
     FROM up WHERE cv.id = up.variant_id
     RETURNING cv.id`,
    [id, ratio, x, y, scale, mode, fitColor],
  );
  if (!res.rowCount)
    return NextResponse.json({ error: "variant not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
