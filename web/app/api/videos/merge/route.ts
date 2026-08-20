import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Merge duplicate sources: keep one video, repoint every foreign link
 * from the others to it, delete the rest, and clean their R2 objects.
 *
 * Repointed: clips.video_id (clip times refer to identical content) and
 * video_meta_links.video_id (so ad_performance keeps resolving to the
 * survivor). Transcripts / scenes / tags / candidates of the duplicates
 * die with the row cascade — the survivor already has its own.
 *
 * The keeper is chosen by the CALLER (the UI keeps the oldest); this
 * route only refuses obvious mistakes. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const keep = String(body.keep_id ?? "");
  const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!UUID_RE.test(keep) || !ids.length || !ids.every((i) => UUID_RE.test(i)))
    return NextResponse.json({ error: "keep_id and ids[] required" }, { status: 400 });
  if (ids.includes(keep))
    return NextResponse.json({ error: "keep_id cannot be in ids" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const keeper = await client.query(
      "SELECT id FROM videos WHERE id = $1 FOR UPDATE", [keep]);
    if (!keeper.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "keep_id not found" }, { status: 404 });
    }
    const dups = await client.query(
      "SELECT id::text FROM videos WHERE id = ANY($1::uuid[]) FOR UPDATE", [ids]);
    if (dups.rowCount !== ids.length) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "some ids not found" }, { status: 404 });
    }

    const clips = await client.query(
      "UPDATE clips SET video_id = $1 WHERE video_id = ANY($2::uuid[]) RETURNING id",
      [keep, ids]);
    const links = await client.query(
      "UPDATE video_meta_links SET video_id = $1 WHERE video_id = ANY($2::uuid[]) RETURNING meta_video_id",
      [keep, ids]);
    await client.query("DELETE FROM videos WHERE id = ANY($1::uuid[])", [ids]);
    for (const id of ids) {
      await client.query(
        `INSERT INTO jobs (type, payload)
         VALUES ('cleanup', jsonb_build_object('r2_prefixes', jsonb_build_array(
           $1::text, $2::text, $3::text)))`,
        [`sources/${id}/`, `keyframes/${id}/`, `audio/${id}.wav`]);
    }
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true, merged: ids.length,
      clips_repointed: clips.rowCount, meta_links_repointed: links.rowCount,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    client.release();
  }
}
