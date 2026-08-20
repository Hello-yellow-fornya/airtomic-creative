import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { markStaleVariant } from "@/lib/variants";

export const dynamic = "force-dynamic";

/** Split a source-backed scene at an absolute source time. The right half
 * is inserted immediately after; later scenes shift down one idx. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const at = Number(body.at_s);
  if (!Number.isFinite(at))
    return NextResponse.json({ error: "at_s is required" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT * FROM variant_scenes WHERE id = $1",
      [id],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "scene not found" }, { status: 404 });
    }
    const s = cur.rows[0];
    if (s.layout === "card") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "cannot split a card" }, { status: 400 });
    }
    const sIn = parseFloat(s.source_in_s);
    const sOut = parseFloat(s.source_out_s);
    if (at <= sIn + 0.5 || at >= sOut - 0.5) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "split point too close to a scene edge" },
        { status: 400 },
      );
    }
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      "UPDATE variant_scenes SET idx = idx + 1 WHERE variant_id = $1 AND idx > $2",
      [s.variant_id, s.idx],
    );
    await client.query(
      "UPDATE variant_scenes SET source_out_s = $1 WHERE id = $2",
      [at, id],
    );
    const ins = await client.query(
      `INSERT INTO variant_scenes (variant_id, idx, layout, source_in_s, source_out_s,
                                   lifted, slot_a_asset, split_ratio, audio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [s.variant_id, s.idx + 1, s.layout, at, sOut, s.lifted,
       s.slot_a_asset, s.split_ratio, s.audio],
    );
    await markStaleVariant(s.variant_id, client);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, new_scene_id: ins.rows[0].id });
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
