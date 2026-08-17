import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Dismiss a FAILED ingest: delete the video row (nothing downstream
 * exists for a failed pipeline) and clean its archived source + extracted
 * audio out of R2 via the worker's cleanup job. Refuses any other status —
 * healthy videos are deleted through their clips, or not at all. */
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
      "SELECT status::text, storage_uri FROM videos WHERE id = $1",
      [id],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (cur.rows[0].status !== "failed") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "only failed ingests can be dismissed" },
        { status: 409 },
      );
    }
    await client.query("DELETE FROM videos WHERE id = $1", [id]);
    await client.query(
      `INSERT INTO jobs (type, payload)
       VALUES ('cleanup', jsonb_build_object('r2_prefixes',
               jsonb_build_array($1::text, $2::text)))`,
      [`sources/${id}/`, `audio/${id}.wav`],
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
