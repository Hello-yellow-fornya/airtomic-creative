import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

const RATIOS = ["9x16", "4x5", "1x1", "1.91x1"];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const ratio = body.ratio ?? "9x16";
  if (!RATIOS.includes(ratio))
    return NextResponse.json({ error: "bad ratio" }, { status: 400 });

  await q(
    `INSERT INTO jobs (type, payload)
     VALUES ('render', jsonb_build_object('variant_id', $1::text, 'ratio', $2::text))`,
    [id, ratio],
  );
  // a fresh render is what "Re-render" asked for — clear the stale flag
  await q("UPDATE clip_variants SET render_stale = false WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
}
