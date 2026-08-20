import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { markStaleVariant } from "@/lib/variants";

export const dynamic = "force-dynamic";

type SceneSpec = {
  layout: string;
  in?: number;
  out?: number;
  dur?: number;
  ratio: number;
};

/** The prototype's templates, built from the clip's trim bounds. Applying
 * one replaces the variant's scene list (destructive, like the prototype —
 * per-scene crops on replaced scenes go with them). */
const TPL: Record<string, (s: number, e: number) => SceneSpec[]> = {
  plain: (s, e) => [{ layout: "full", in: s, out: e, ratio: 0.5 }],
  product: (s, e) => {
    const mid = s + (e - s) * 0.6;
    return [
      { layout: "full", in: s, out: mid, ratio: 0.5 },
      { layout: "split_product", in: mid, out: e, ratio: 0.6 },
    ];
  },
  hookfirst: (s, e) => {
    const hookEnd = s + Math.min(4, (e - s) * 0.25);
    return [
      { layout: "full", in: s, out: hookEnd, ratio: 0.5 },
      { layout: "split_product", in: hookEnd, out: e, ratio: 0.6 },
      { layout: "card", dur: 2.5, ratio: 0.5 },
    ];
  },
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const build = TPL[String(body.key)];
  if (!build)
    return NextResponse.json(
      { error: "key must be plain|product|hookfirst" },
      { status: 400 },
    );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const clip = await client.query(
      `SELECT c.source_in_s, c.source_out_s FROM clips c
       JOIN clip_variants cv ON cv.clip_id = c.id WHERE cv.id = $1`,
      [id],
    );
    if (!clip.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "variant not found" }, { status: 404 });
    }
    const s = parseFloat(clip.rows[0].source_in_s);
    const e = parseFloat(clip.rows[0].source_out_s);

    // First end-card asset, if the library has one, for card/split slots.
    const card = await client.query(
      "SELECT id FROM assets WHERE kind::text = 'end_card' ORDER BY created_at LIMIT 1",
    );
    const still = await client.query(
      "SELECT id FROM assets WHERE kind::text <> 'end_card' ORDER BY created_at LIMIT 1",
    );

    await client.query("DELETE FROM variant_scenes WHERE variant_id = $1", [id]);
    const specs = build(s, e);
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      const asset =
        sp.layout === "card" ? card.rows[0]?.id ?? null
        : sp.layout === "split_product" ? still.rows[0]?.id ?? null
        : null;
      await client.query(
        `INSERT INTO variant_scenes (variant_id, idx, layout, source_in_s, source_out_s,
                                     lifted, duration_s, slot_a_asset, split_ratio)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
        [id, i, sp.layout, sp.in ?? null, sp.out ?? null, sp.dur ?? null,
         asset, sp.ratio],
      );
    }
    await markStaleVariant(id, client);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, scenes: specs.length });
  } catch (e2) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { error: e2 instanceof Error ? e2.message : String(e2) },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
