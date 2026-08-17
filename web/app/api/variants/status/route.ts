import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Approval-flow transitions, single or bulk. Legal moves only — the flow
 * is draft → in_review → approved → sent (CLAUDE.md). `sent` is set by the
 * push path, never here. submitted_by / approved_by are recorded separately
 * because the person cutting clips isn't necessarily cleared to approve. */
const MOVES: Record<string, { from: string[]; set: string }> = {
  in_review: {
    from: ["draft", "approved"],
    set: "status = 'in_review', submitted_by = COALESCE(submitted_by, 'web'), submitted_at = COALESCE(submitted_at, now())",
  },
  approved: {
    from: ["in_review"],
    set: "status = 'approved', approved_by = 'web', approved_at = now()",
  },
  draft: {
    from: ["in_review"],
    set: "status = 'draft', submitted_by = NULL, submitted_at = NULL",
  },
};

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const to = String(body.to ?? "");
  const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const move = MOVES[to];
  if (!move || !ids.length)
    return NextResponse.json(
      { error: "ids[] and to (in_review|approved|draft) required" },
      { status: 400 },
    );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `UPDATE clip_variants SET ${move.set}
       WHERE id = ANY($1::uuid[]) AND status::text = ANY($2)
       RETURNING id`,
      [ids, move.from],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      moved: res.rowCount,
      skipped: ids.length - (res.rowCount ?? 0),
    });
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
