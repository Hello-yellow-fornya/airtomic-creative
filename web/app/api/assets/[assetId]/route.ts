import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Delete a brand asset. Scenes referencing it fall back to empty slots
 * (slot FKs are ON DELETE SET NULL). The R2 object goes via the worker's
 * cleanup job when the asset lives under assets/{id}/ — dashboard-uploaded
 * assets at arbitrary keys keep their file (reported in the response). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  if (!UUID_RE.test(assetId))
    return NextResponse.json({ error: "bad id" }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "DELETE FROM assets WHERE id = $1 RETURNING storage_uri",
      [assetId],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const uri: string = cur.rows[0].storage_uri ?? "";
    const managed = new RegExp(`^r2://[^/]+/assets/${assetId}/`).test(uri);
    if (managed) {
      await client.query(
        `INSERT INTO jobs (type, payload)
         VALUES ('cleanup', jsonb_build_object('r2_prefixes',
                 jsonb_build_array($1::text)))`,
        [`assets/${assetId}/`],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, r2_cleanup: managed });
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
