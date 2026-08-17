import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Swap a scene with its neighbour. The (variant_id, idx) unique constraint
 * is DEFERRABLE INITIALLY DEFERRED, so the swap works inside a transaction. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { dir } = await req.json().catch(() => ({}));
  if (dir !== "up" && dir !== "down")
    return NextResponse.json({ error: "dir must be up|down" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT id, variant_id, idx FROM variant_scenes WHERE id = $1",
      [id],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "scene not found" }, { status: 404 });
    }
    const { variant_id, idx } = cur.rows[0];
    const other = await client.query(
      `SELECT id, idx FROM variant_scenes
       WHERE variant_id = $1 AND idx ${dir === "up" ? "<" : ">"} $2
       ORDER BY idx ${dir === "up" ? "DESC" : "ASC"} LIMIT 1`,
      [variant_id, idx],
    );
    if (other.rowCount) {
      await client.query("UPDATE variant_scenes SET idx = $1 WHERE id = $2", [
        other.rows[0].idx, id,
      ]);
      await client.query("UPDATE variant_scenes SET idx = $1 WHERE id = $2", [
        idx, other.rows[0].id,
      ]);
    }
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
