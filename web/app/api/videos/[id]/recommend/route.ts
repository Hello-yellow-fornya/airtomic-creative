import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Enqueue content-based candidate scoring for a video that's already
 * through the pipeline (new ingests get it automatically as the final
 * stage). Guards: video must be ready with a transcript, and only one
 * recommend job may be pending at a time. */
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
      "SELECT status::text FROM videos WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!v.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (v.rows[0].status !== "ready") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "video is not ready — scoring runs after the pipeline" },
        { status: 409 },
      );
    }
    const words = await client.query(
      `SELECT 1 FROM transcript_words w JOIN transcripts t ON t.id = w.transcript_id
       WHERE t.video_id = $1 LIMIT 1`,
      [id],
    );
    if (!words.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "no transcript — nothing to score" },
        { status: 409 },
      );
    }
    const pending = await client.query(
      `SELECT 1 FROM jobs WHERE type = 'recommend'
       AND payload->>'video_id' = $1 AND status IN ('queued','running') LIMIT 1`,
      [id],
    );
    if (pending.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ ok: true, already: true });
    }
    await client.query(
      `INSERT INTO jobs (type, payload)
       VALUES ('recommend', jsonb_build_object('video_id', $1::text))`,
      [id],
    );
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
