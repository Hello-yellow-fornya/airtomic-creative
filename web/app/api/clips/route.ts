import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

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
    // Default name: "<source short name> · <start>s–<end>s" — never
    // "untitled clip". Long source names middle-truncate to stay readable.
    let clipName = name;
    if (!clipName) {
      const src = await client.query(
        "SELECT title FROM videos WHERE id = $1", [videoId]);
      const t: string = src.rows[0]?.title ?? "untitled source";
      const short = t.length > 24 ? `${t.slice(0, 14)}…${t.slice(-6)}` : t;
      clipName = `${short} · ${startS.toFixed(0)}s–${endS.toFixed(0)}s`;
    }
    const clip = await client.query(
      `INSERT INTO clips (video_id, name, source_in_s, source_out_s, subtitle_preset_id,
                          candidate_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'web') RETURNING id`,
      [videoId, clipName, startS, endS, preset.rows[0]?.id ?? null, candidateId],
    );
    if (candidateId) {
      await client.query(
        "UPDATE clip_candidates SET status = 'used' WHERE id = $1",
        [candidateId],
      );
    }
    const clipId = clip.rows[0].id;

    const variant = await client.query(
      `INSERT INTO clip_variants (clip_id, label, name, slug)
       VALUES ($1, 'A', 'Control', 'a-control') RETURNING id`,
      [clipId],
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
