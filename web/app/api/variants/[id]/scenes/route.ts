import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Append a scene to a variant. Cards need duration + asset; source-backed
 * layouts split the last source scene in half (the prototype's addScene). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const layout = body.layout as string;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scenes = await client.query(
      "SELECT * FROM variant_scenes WHERE variant_id = $1 ORDER BY idx",
      [id],
    );
    const nextIdx = scenes.rowCount
      ? scenes.rows[scenes.rowCount - 1].idx + 1
      : 0;

    if (layout === "card") {
      await client.query(
        `INSERT INTO variant_scenes (variant_id, idx, layout, duration_s, slot_a_asset)
         VALUES ($1, $2, 'card', $3, $4)`,
        [id, nextIdx, Number(body.duration_s) || 2.5, body.slot_a_asset ?? null],
      );
    } else if (["full", "split_product", "split_speakers"].includes(layout)) {
      const lastSrc = [...scenes.rows].reverse().find((s) => s.layout !== "card");
      if (!lastSrc) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "no source scene to split" },
          { status: 400 },
        );
      }
      const sIn = parseFloat(lastSrc.source_in_s);
      const sOut = parseFloat(lastSrc.source_out_s);
      const mid = (sIn + sOut) / 2;
      await client.query(
        "UPDATE variant_scenes SET source_out_s = $1 WHERE id = $2",
        [mid, lastSrc.id],
      );
      await client.query(
        `INSERT INTO variant_scenes (variant_id, idx, layout, source_in_s, source_out_s,
                                     lifted, slot_a_asset, split_ratio)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
        [id, nextIdx, layout, mid, sOut, body.slot_a_asset ?? null,
         layout === "split_product" ? 0.6 : 0.5],
      );
    } else {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "bad layout" }, { status: 400 });
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
