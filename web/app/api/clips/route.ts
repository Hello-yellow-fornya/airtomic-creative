import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { slugify } from "@/lib/adname";
import { defaultVariantName, nameTaken, sanitizeName } from "@/lib/variants";

export const dynamic = "force-dynamic";

/** Minimum viable path from transcript to MP4: create a clip, its first
 * variant (A / Control), one full-layout scene spanning the selection
 * (lifted by default, per the prototype), and enqueue a 9x16 render job.
 * All in one transaction so a failure leaves nothing half-created. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const videoId = body?.video_id as string | undefined;
  const startS = Number(body?.start_s);
  const endS = Number(body?.end_s);
  const name = (body?.name as string | null) ?? null;
  const candidateId = (body?.candidate_id as string | null) ?? null;

  if (!videoId || !Number.isFinite(startS) || !Number.isFinite(endS)) {
    return NextResponse.json(
      { error: "video_id, start_s, end_s are required" },
      { status: 400 },
    );
  }
  if (endS - startS < 0.5) {
    return NextResponse.json(
      { error: "selection must be at least 0.5s" },
      { status: 400 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const preset = await client.query(
      "SELECT id FROM subtitle_presets WHERE is_default ORDER BY created_at LIMIT 1",
    );
    // The clip carries only the shared source range; the NAME lives on
    // variant A. Default: "<source short name> · <start>s–<end>s · A".
    const src = await client.query(
      "SELECT title FROM videos WHERE id = $1", [videoId]);
    let variantName = name
      ? sanitizeName(name)
      : defaultVariantName(src.rows[0]?.title ?? null, startS, endS, "A");
    if (await nameTaken(client, videoId, variantName))
      variantName = `${variantName} (2)`;
    const clip = await client.query(
      `INSERT INTO clips (video_id, source_in_s, source_out_s,
                          candidate_id, created_by)
       VALUES ($1, $2, $3, $4, 'web') RETURNING id`,
      [videoId, startS, endS, candidateId],
    );
    if (candidateId) {
      await client.query(
        "UPDATE clip_candidates SET status = 'used' WHERE id = $1",
        [candidateId],
      );
    }
    const clipId = clip.rows[0].id;

    const variant = await client.query(
      `INSERT INTO clip_variants (clip_id, label, name, slug, subtitle_preset_id)
       VALUES ($1, 'A', $2, $3, $4) RETURNING id`,
      [clipId, variantName,
       `a-${slugify(variantName) || "variant"}`, preset.rows[0]?.id ?? null],
    );
    const variantId = variant.rows[0].id;

    // Default template: one full-layout scene over the whole selection,
    // lifted from its original position (the prototype's default).
    await client.query(
      `INSERT INTO variant_scenes (variant_id, idx, layout, source_in_s, source_out_s, lifted)
       VALUES ($1, 0, 'full', $2, $3, true)`,
      [variantId, startS, endS],
    );

    await client.query(
      `INSERT INTO jobs (type, payload)
       VALUES ('render', jsonb_build_object('variant_id', $1::text, 'ratio', '9x16'))`,
      [variantId],
    );

    await client.query("COMMIT");
    return NextResponse.json({ clip_id: clipId, variant_id: variantId });
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
