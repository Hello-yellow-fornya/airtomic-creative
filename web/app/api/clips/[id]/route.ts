import { NextResponse } from "next/server";
import { pool, q } from "@/lib/db";
import { markStaleForClip } from "@/lib/variants";

export const dynamic = "force-dynamic";

/** Clip-level settings — since 0015 that is ONLY the shared source range.
 * Names and subtitle settings live on the variant (PATCH /api/variants).
 * Trimming stretches the first/last source scene of EVERY variant of the
 * clip to the new bounds (the prototype's handle-drag behaviour), all in
 * one transaction, and marks every variant's render stale. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT * FROM clips WHERE id = $1", [id]);
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "clip not found" }, { status: 404 });
    }
    const clip = cur.rows[0];

    const sets: string[] = [];
    const vals: unknown[] = [];
    let n = 1;

    const oldIn = parseFloat(clip.source_in_s);
    const oldOut = parseFloat(clip.source_out_s);
    const newIn = body.source_in_s !== undefined ? Number(body.source_in_s) : oldIn;
    const newOut = body.source_out_s !== undefined ? Number(body.source_out_s) : oldOut;
    if (!Number.isFinite(newIn) || !Number.isFinite(newOut) || newOut - newIn < 1) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "bad trim bounds" }, { status: 400 });
    }
    if (newIn !== oldIn || newOut !== oldOut) {
      sets.push(`source_in_s = $${n++}`);
      vals.push(newIn);
      sets.push(`source_out_s = $${n++}`);
      vals.push(newOut);
      // Stretch first/last source scene of each variant to the new bounds.
      await client.query(
        `UPDATE variant_scenes vs SET source_in_s = $2
         FROM (SELECT DISTINCT ON (variant_id) id FROM variant_scenes
               WHERE variant_id IN (SELECT id FROM clip_variants WHERE clip_id = $1)
                 AND layout <> 'card'
               ORDER BY variant_id, idx ASC) first
         WHERE vs.id = first.id AND vs.source_out_s > $2`,
        [id, newIn],
      );
      await client.query(
        `UPDATE variant_scenes vs SET source_out_s = $2
         FROM (SELECT DISTINCT ON (variant_id) id FROM variant_scenes
               WHERE variant_id IN (SELECT id FROM clip_variants WHERE clip_id = $1)
                 AND layout <> 'card'
               ORDER BY variant_id, idx DESC) last
         WHERE vs.id = last.id AND vs.source_in_s < $2`,
        [id, newOut],
      );
    }

    if (sets.length) {
      vals.push(id);
      await client.query(`UPDATE clips SET ${sets.join(", ")} WHERE id = $${n}`, vals);
      await markStaleForClip(id, client);
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await q("DELETE FROM clips WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
}
