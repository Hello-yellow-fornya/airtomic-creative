import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";
import { markStale, svFromPreset } from "@/lib/overlays";

export const dynamic = "force-dynamic";

const POSITIONS = new Set(["top", "center", "lower_third"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));

  const text = String(body.text ?? "New overlay").slice(0, 400);
  const start = Number.isFinite(+body.start_s) ? Math.max(0, +body.start_s) : 0;
  const end = Number.isFinite(+body.end_s) ? +body.end_s : start + 3; // hooks live at the top
  const position = POSITIONS.has(body.position) ? body.position : "top";
  const style = typeof body.style === "string" ? body.style.slice(0, 40) : "hook";
  if (end <= start)
    return NextResponse.json({ error: "end must be after start" }, { status: 400 });

  const presetRow = await pool.query(
    "SELECT config, config->>'default_position' AS dp FROM overlay_style_presets WHERE key = $1",
    [style]);
  if (!presetRow.rowCount)
    return NextResponse.json({ error: `unknown style '${style}'` }, { status: 400 });

  // resolved values are stored on the overlay — the preset is only a seed
  const pos = POSITIONS.has(body.position)
    ? body.position : (presetRow.rows[0].dp ?? position);
  const sv = svFromPreset(presetRow.rows[0].config, pos);

  const res = await pool.query(
    `INSERT INTO clip_overlays (variant_id, idx, text, start_s, end_s, position, style, sv)
     SELECT $1::uuid, coalesce(max(idx) + 1, 0), $2::text,
            $3::numeric, $4::numeric, $5::text, $6::text, $7::jsonb
     FROM clip_overlays WHERE variant_id = $1::uuid
     RETURNING id::text, idx, text, start_s::text, end_s::text, position, style, sv`,
    [id, text, start, end, pos, style, JSON.stringify(sv)],
  );
  if (!res.rowCount)
    return NextResponse.json({ error: "variant not found" }, { status: 404 });
  await markStale(id);
  return NextResponse.json({ overlay: res.rows[0] });
}
