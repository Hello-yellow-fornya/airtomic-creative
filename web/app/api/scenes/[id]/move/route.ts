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
  const body = await req.json().catch(() => ({}));
  const dir = body.dir as string | undefined;
  const to = body.to as number | undefined;
  if (dir !== "up" && dir !== "down" && !Number.isInteger(to))
    return NextResponse.json(
      { error: "dir must be up|down, or pass a target idx as to" },
      { status: 400 },
    );

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

    if (Number.isInteger(to)) {
      // Drag-reorder to an arbitrary position: lift out, re-pack around it.
      const all = await client.query(
        "SELECT id FROM variant_scenes WHERE variant_id = $1 ORDER BY idx",
        [variant_id],
      );
      const ids: string[] = all.rows.map((r) => r.id);
      const from = ids.indexOf(id);
      const target = Math.max(0, Math.min(ids.length - 1, to as number));
      ids.splice(from, 1);
      ids.splice(target, 0, id);
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      for (let i = 0; i < ids.length; i++) {
        await client.query("UPDATE variant_scenes SET idx = $1 WHERE id = $2", [
          i, ids[i],
        ]);
      }
    } else {
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
