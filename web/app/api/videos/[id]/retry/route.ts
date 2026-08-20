import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Retry a failed source: reset the video to queued and requeue its ingest
 * job (or create one if none survives). Only failed videos are retryable —
 * everything else is either fine or already moving. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const v = await client.query(
      "SELECT status::text FROM videos WHERE id = $1 FOR UPDATE", [id]);
    if (!v.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (v.rows[0].status !== "failed") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "only failed sources can be retried" }, { status: 409 });
    }
    const j = await client.query(
      `UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, locked_at = NULL
       WHERE id = (SELECT id FROM jobs WHERE type = 'ingest'
                   AND payload->>'video_id' = $1 ORDER BY id DESC LIMIT 1)
       RETURNING id`, [id]);
    if (!j.rowCount) {
      await client.query(
        `INSERT INTO jobs (type, payload)
         VALUES ('ingest', jsonb_build_object('video_id', $1::text))`, [id]);
    }
    await client.query(
      "UPDATE videos SET status = 'queued', status_detail = 'retry requested' WHERE id = $1",
      [id]);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    client.release();
  }
}
