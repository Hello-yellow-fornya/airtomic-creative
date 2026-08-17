import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Bulk clip delete. Removes the clips rows (cascading through
 * clip_variants → variant_scenes → scene_crops), cancels queued/running
 * render jobs for those variants, and enqueues a worker `cleanup` job to
 * delete the rendered exports from R2 — all in one transaction, so the
 * cleanup can't be lost if the delete commits.
 *
 * The source video, transcript, scenes and tags are untouched — they
 * belong to the video, not the clip.
 *
 * Guard: clips with a variant in `sent`/`sending` are refused outright —
 * deleting them locally would orphan a live ad in the Meta account. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const clipIds: string[] = Array.isArray(body.clip_ids)
    ? body.clip_ids.filter((s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/.test(s))
    : [];
  if (!clipIds.length)
    return NextResponse.json({ error: "clip_ids[] required" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sent = await client.query(
      `SELECT DISTINCT c.id, c.name FROM clips c
       JOIN clip_variants cv ON cv.clip_id = c.id
       WHERE c.id = ANY($1::uuid[]) AND cv.status::text IN ('sent', 'sending')`,
      [clipIds],
    );
    if (sent.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error: `${sent.rowCount} clip${sent.rowCount > 1 ? "s have" : " has"} a variant already sent to Meta — deleting locally would orphan the ad. Remove the ad in Ads Manager first.`,
          blocked: sent.rows.map((r) => r.id),
        },
        { status: 409 },
      );
    }

    const variants = await client.query(
      "SELECT id::text FROM clip_variants WHERE clip_id = ANY($1::uuid[])",
      [clipIds],
    );
    const variantIds: string[] = variants.rows.map((r) => r.id);

    // Cancel renders that haven't run (and drop rows for running ones —
    // the worker's completion writes become no-ops on missing rows).
    if (variantIds.length) {
      await client.query(
        `DELETE FROM jobs WHERE type = 'render'
         AND status IN ('queued', 'running')
         AND payload->>'variant_id' = ANY($1)`,
        [variantIds],
      );
      await client.query(
        `INSERT INTO jobs (type, payload)
         VALUES ('cleanup', jsonb_build_object('r2_prefixes', $1::jsonb))`,
        [JSON.stringify(variantIds.map((v) => `exports/${v}/`))],
      );
    }

    const del = await client.query(
      "DELETE FROM clips WHERE id = ANY($1::uuid[]) RETURNING id",
      [clipIds],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      deleted_clips: del.rowCount,
      deleted_variants: variantIds.length,
      cleanup_queued: variantIds.length > 0,
    });
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
