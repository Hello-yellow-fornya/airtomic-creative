import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { UUID_RE } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Suggested cuts as a timecoded marker list against the FULL source —
 * CSV the editor can keep open next to Premiere/AE, so the good moments
 * are flagged without changing how she works. Honesty carries over: the
 * evidence column states the scoring basis; nothing invents an n=. */

const tc = (s: number) => {
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return `${h}:${m}:${sec}`;
};
const csvCell = (v: string | null) =>
  v === null ? "" : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id))
    return NextResponse.json({ error: "bad id" }, { status: 400 });

  const [video] = await q<{ title: string | null }>(
    "SELECT title FROM videos WHERE id = $1", [id]);
  if (!video)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const cands = await q<{
    start_s: string; end_s: string; score: string | null;
    rationale: string | null; status: string;
    matched_tags: Record<string, unknown> | null;
  }>(
    `SELECT start_s::text, end_s::text, score::text, rationale, status::text,
            matched_tags
     FROM clip_candidates
     WHERE video_id = $1 AND status <> 'rejected'
     ORDER BY score DESC NULLS LAST`,
    [id],
  );

  const rows = cands.map((c, i) => {
    const tags = (c.matched_tags ?? {}) as {
      evidence?: string; n?: number; flag?: boolean; flag_reason?: string;
    };
    const start = parseFloat(c.start_s);
    const end = parseFloat(c.end_s);
    return [
      String(i + 1),
      tc(start), tc(end),
      start.toFixed(3), end.toFixed(3), (end - start).toFixed(1),
      c.score ? parseFloat(c.score).toFixed(2) : "",
      c.status,
      tags.flag ? csvCell(`COMPLIANCE: ${tags.flag_reason ?? "treatment claim"}`) : "",
      csvCell(
        typeof tags.n === "number"
          ? `n=${tags.n}`
          : tags.evidence ?? "evidence not recorded",
      ),
      csvCell(c.rationale),
    ].join(",");
  });

  const csv = [
    "rank,start_tc,end_tc,start_s,end_s,duration_s,score,status,compliance,evidence,rationale",
    ...rows,
  ].join("\r\n") + "\r\n";

  const slug = (video.title ?? "video")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-cut-markers.csv"`,
    },
  });
}
