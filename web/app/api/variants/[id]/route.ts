import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { markStaleVariant, nameTaken, sanitizeName } from "@/lib/variants";

export const dynamic = "force-dynamic";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18);

/** Variant-level settings: name (unique within the source video — it
 * feeds the export filename and ad-name parsing) and subtitle preset +
 * overrides. Subtitle edits are part of the render fingerprint, so they
 * mark this variant — and only this variant — stale. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT cv.id, c.video_id::text FROM clip_variants cv
       JOIN clips c ON c.id = cv.clip_id WHERE cv.id = $1 FOR UPDATE OF cv`,
      [id],
    );
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    let subtitlesTouched = false;
    if (body.name !== undefined) {
      const name = sanitizeName(String(body.name ?? ""));
      if (!name) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
      if (await nameTaken(client, cur.rows[0].video_id, name, id)) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: `“${name}” is already used on this source` },
          { status: 409 },
        );
      }
      await client.query(
        "UPDATE clip_variants SET name = $1, slug = lower(label) || '-' || $2 WHERE id = $3",
        [name, slugify(name) || "variant", id],
      );
    }
    if (body.subtitle_preset_id !== undefined) {
      await client.query(
        "UPDATE clip_variants SET subtitle_preset_id = $1 WHERE id = $2",
        [body.subtitle_preset_id || null, id],
      );
      subtitlesTouched = true;
    }
    if (body.subtitle_overrides !== undefined) {
      await client.query(
        "UPDATE clip_variants SET subtitle_overrides = $1 WHERE id = $2",
        [body.subtitle_overrides === null
          ? null : JSON.stringify(body.subtitle_overrides), id],
      );
      subtitlesTouched = true;
    }
    if (subtitlesTouched) await markStaleVariant(id, client);
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
