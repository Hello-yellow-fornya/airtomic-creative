import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (body.title === undefined)
    return NextResponse.json({ error: "title required" }, { status: 400 });
  const title = body.title === null ? null : String(body.title).slice(0, 200);
  const res = await pool.query(
    "UPDATE videos SET title = $1 WHERE id = $2 RETURNING id",
    [title, id],
  );
  if (!res.rowCount)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Delete a source: remove the video row (transcripts / scenes / tags /
 * candidates cascade) and clean its source, keyframes and audio out of R2
 * via the worker's cleanup job. Clips that reference it survive as
 * ORPHANS (video_id -> NULL, 0016): their variants stay listed in the
 * builder read-only, exports remain downloadable, and they can still be
 * deleted. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT status::text, storage_uri FROM videos WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const orphans = await client.query(
      "SELECT count(*)::int AS n FROM clips WHERE video_id = $1", [id]);
    await client.query("DELETE FROM videos WHERE id = $1", [id]);
    await client.query(
      `INSERT INTO jobs (type, payload)
       VALUES ('cleanup', jsonb_build_object('r2_prefixes',
               jsonb_build_array($1::text, $2::text, $3::text)))`,
      [`sources/${id}/`, `keyframes/${id}/`, `audio/${id}.wav`],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, orphaned_clips: orphans.rows[0].n });
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
