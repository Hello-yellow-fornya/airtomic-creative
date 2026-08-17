import { NextResponse } from "next/server";
import { pool, q } from "@/lib/db";

export const dynamic = "force-dynamic";

const LAYOUTS = ["full", "split_product", "split_speakers", "card"];
// Split ratios are presets, not free resize (CLAUDE.md composition model).
const SPLIT_PRESETS = [0.5, 0.6, 0.4];

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;

  if (body.layout !== undefined) {
    if (!LAYOUTS.includes(body.layout))
      return NextResponse.json({ error: "bad layout" }, { status: 400 });
    sets.push(`layout = $${n++}`);
    vals.push(body.layout);
  }
  if (body.split_ratio !== undefined) {
    const r = Number(body.split_ratio);
    if (!SPLIT_PRESETS.includes(r))
      return NextResponse.json(
        { error: `split_ratio must be one of ${SPLIT_PRESETS.join(", ")}` },
        { status: 400 },
      );
    sets.push(`split_ratio = $${n++}`);
    vals.push(r);
  }
  if (body.slot_a_asset !== undefined) {
    sets.push(`slot_a_asset = $${n++}`);
    vals.push(body.slot_a_asset || null);
  }
  if (body.audio !== undefined) {
    if (!["source", "mute"].includes(body.audio))
      return NextResponse.json({ error: "bad audio" }, { status: 400 });
    sets.push(`audio = $${n++}`);
    vals.push(body.audio);
  }
  if (body.duration_s !== undefined) {
    sets.push(`duration_s = $${n++}`);
    vals.push(Number(body.duration_s));
  }
  if (!sets.length)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  vals.push(id);
  await q(`UPDATE variant_scenes SET ${sets.join(", ")} WHERE id = $${n}`, vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      "DELETE FROM variant_scenes WHERE id = $1 RETURNING variant_id",
      [id],
    );
    if (res.rowCount) {
      // Re-pack idx so ordering stays dense (unique constraint is deferred).
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `UPDATE variant_scenes vs SET idx = ranked.new_idx - 1
         FROM (SELECT id, row_number() OVER (ORDER BY idx) AS new_idx
               FROM variant_scenes WHERE variant_id = $1) ranked
         WHERE vs.id = ranked.id`,
        [res.rows[0].variant_id],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
}
