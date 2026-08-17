import { NextResponse } from "next/server";
import { pool, q } from "@/lib/db";

export const dynamic = "force-dynamic";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name)
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  const rows = await q<{ label: string }>(
    "UPDATE clip_variants SET name = $1, slug = lower(label) || '-' || $2 WHERE id = $3 RETURNING label",
    [name.slice(0, 80), slugify(name) || "variant", id],
  );
  if (!rows.length)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Deleting the last variant of a clip is refused — delete the clip
 * instead. Sent variants are immutable history. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT clip_id, status::text FROM clip_variants WHERE id = $1",
      [id],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (cur.rows[0].status === "sent") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "sent variants are history — they can't be deleted" },
        { status: 409 },
      );
    }
    const siblings = await client.query(
      "SELECT count(*)::int AS n FROM clip_variants WHERE clip_id = $1",
      [cur.rows[0].clip_id],
    );
    if (siblings.rows[0].n < 2) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "last variant — delete the clip instead" },
        { status: 409 },
      );
    }
    await client.query("DELETE FROM clip_variants WHERE id = $1", [id]);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, clip_id: cur.rows[0].clip_id });
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
