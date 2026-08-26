import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

const KEYS = ["fs", "ol", "vp", "wpl", "hl", "caps", "box", "font", "weight", "bg", "bg_color", "bg_alpha", "ol_color"];

/** Update a subtitle preset's config. Only known keys are merged — the
 * renderer reads this verbatim, so no free-form fields. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const config = body.config ?? {};
  const clean: Record<string, unknown> = {};
  for (const k of KEYS) if (config[k] !== undefined) clean[k] = config[k];
  if (!Object.keys(clean).length)
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const rows = await q(
    `UPDATE subtitle_presets SET config = config || $1::jsonb, updated_at = now()
     WHERE id = $2 RETURNING id`,
    [JSON.stringify(clean), id],
  );
  if (!rows.length)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
