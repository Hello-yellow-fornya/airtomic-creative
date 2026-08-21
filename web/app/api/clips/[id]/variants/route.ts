import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { defaultVariantName, nameTaken, sanitizeName } from "@/lib/variants";

export const dynamic = "force-dynamic";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

/** Add a variant to a clip: next free label (A, B, C…). The FULL
 * variant-level set is copied from `copy_from` (or the clip's first
 * variant): scenes with order and trims, per-ratio crops, overlays, and
 * subtitle settings — nothing clip-level. Default name follows
 * "<source short> · <in>s–<out>s · <label>". */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id, label FROM clip_variants WHERE clip_id = $1 ORDER BY label",
      [id],
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "clip not found" }, { status: 404 });
    }
    // Next label = successor of the HIGHEST label ever used, never a
    // freed one: exported names like KLR_…_B are the join key back to
    // Meta performance, so a deleted variant's label must not be reborn
    // as a different creative.
    const top = existing.rows.reduce(
      (a, r) => Math.max(a, r.label.charCodeAt(0)), 64);
    if (top >= 90) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "26 variants is plenty" }, { status: 400 });
    }
    const label = String.fromCharCode(top + 1);
    const clip = await client.query(
      `SELECT c.video_id::text, c.source_in_s, c.source_out_s, v.title
       FROM clips c JOIN videos v ON v.id = c.video_id WHERE c.id = $1`,
      [id],
    );
    let name = body.name
      ? sanitizeName(String(body.name))
      : defaultVariantName(
          clip.rows[0].title,
          parseFloat(clip.rows[0].source_in_s),
          parseFloat(clip.rows[0].source_out_s),
          label,
        );
    if (await nameTaken(client, clip.rows[0].video_id, name)) {
      if (body.name) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `“${name}” is already used on this source` }, { status: 409 });
      }
      name = `${name} (2)`;
    }
    const slug = `${label.toLowerCase()}-${slugify(name) || "variant"}`;

    const srcVariant =
      body.copy_from && existing.rows.some((r) => r.id === body.copy_from)
        ? body.copy_from
        : existing.rows[0].id;

    const ins = await client.query(
      `INSERT INTO clip_variants (clip_id, label, name, slug,
                                  subtitle_preset_id, subtitle_overrides, export_ratios)
       SELECT $1, $2, $3, $4, src.subtitle_preset_id, src.subtitle_overrides, src.export_ratios
       FROM clip_variants src WHERE src.id = $5 RETURNING id`,
      [id, label, name, slug, srcVariant],
    );
    const newId = ins.rows[0].id;

    // overlays are variant-level: the duplicate inherits them as a start
    await client.query(
      `INSERT INTO clip_overlays (variant_id, idx, text, start_s, end_s, position, style, sv)
       SELECT $1, idx, text, start_s, end_s, position, style, sv
       FROM clip_overlays WHERE variant_id = $2`,
      [newId, srcVariant],
    );

    const scenes = await client.query(
      "SELECT * FROM variant_scenes WHERE variant_id = $1 ORDER BY idx",
      [srcVariant],
    );
    for (const s of scenes.rows) {
      const copy = await client.query(
        `INSERT INTO variant_scenes (variant_id, idx, layout, source_in_s, source_out_s,
                                     lifted, duration_s, slot_a_asset, slot_b_asset,
                                     split_ratio, audio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [newId, s.idx, s.layout, s.source_in_s, s.source_out_s, s.lifted,
         s.duration_s, s.slot_a_asset, s.slot_b_asset, s.split_ratio, s.audio],
      );
      await client.query(
        `INSERT INTO scene_crops (scene_id, ratio, crop_x, crop_y, crop_w, crop_h)
         SELECT $1, ratio, crop_x, crop_y, crop_w, crop_h
         FROM scene_crops WHERE scene_id = $2`,
        [copy.rows[0].id, s.id],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ variant_id: newId, label });
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
