import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";
import { markStale } from "@/lib/overlays";

export const dynamic = "force-dynamic";

const POSITIONS = new Set(["top", "center", "lower_third"]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));

  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  };
  if (typeof body.text === "string") set("text", body.text.slice(0, 400));
  if (Number.isFinite(+body.start_s) && body.start_s !== undefined)
    set("start_s", Math.max(0, +body.start_s));
  if (Number.isFinite(+body.end_s) && body.end_s !== undefined)
    set("end_s", +body.end_s);
  if (POSITIONS.has(body.position)) set("position", body.position);
  if (typeof body.style === "string") {
    const ok = await pool.query(
      "SELECT 1 FROM overlay_style_presets WHERE key = $1", [body.style]);
    if (!ok.rowCount)
      return NextResponse.json({ error: `unknown style '${body.style}'` }, { status: 400 });
    set("style", body.style);
  }
  if (!sets.length)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  sets.push("updated_at = now()");
  args.push(id);

  let res;
  try {
    res = await pool.query(
      `UPDATE clip_overlays SET ${sets.join(", ")}
       WHERE id = $${args.length} RETURNING variant_id::text`,
      args,
    );
  } catch (e) {
    // 23514 = check violation: the CHECK (end_s > start_s) constraint
    if ((e as { code?: string }).code === "23514")
      return NextResponse.json({ error: "end must be after start" }, { status: 400 });
    throw e;
  }
  if (!res.rowCount)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  await markStale(res.rows[0].variant_id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  const res = await pool.query(
    "DELETE FROM clip_overlays WHERE id = $1 RETURNING variant_id::text", [id]);
  if (!res.rowCount)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  await markStale(res.rows[0].variant_id);
  return NextResponse.json({ ok: true });
}
