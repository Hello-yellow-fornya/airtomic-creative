import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { markStaleForScene } from "@/lib/variants";

export const dynamic = "force-dynamic";

const RATIOS = ["9x16", "4x5", "1x1", "1.91x1"];

/** Upsert one crop for one (scene, ratio). Crops are stored per scene per
 * ratio — a 9:16 crop does not transfer to 1:1, and 1.91:1 crops height. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { ratio } = body;
  const x = Number(body.x), y = Number(body.y);
  const w = Number(body.w), h = Number(body.h);

  if (!RATIOS.includes(ratio))
    return NextResponse.json({ error: "bad ratio" }, { status: 400 });
  for (const v of [x, y, w, h])
    if (!Number.isFinite(v) || v < 0 || v > 1)
      return NextResponse.json(
        { error: "crop values are normalised 0-1" },
        { status: 400 },
      );

  await q(
    `INSERT INTO scene_crops (scene_id, ratio, crop_x, crop_y, crop_w, crop_h)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scene_id, ratio)
     DO UPDATE SET crop_x = $3, crop_y = $4, crop_w = $5, crop_h = $6`,
    [id, ratio, x, y, w, h],
  );
  await markStaleForScene(id);
  return NextResponse.json({ ok: true });
}
