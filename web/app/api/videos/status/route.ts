import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Live processing state for the library's queue — polled by the client.
 * Includes videos that recently reached `ready` (with their word count) so
 * the panel can show the landing, not just the climb: the client displays
 * a ready row briefly for videos it watched process, then clears it.
 * Stages are real video statuses; no invented percentages. */
export async function GET() {
  const rows = await q<{
    id: string; title: string | null; status: string; status_detail: string | null;
    ingested_at: string; n_words: string | null;
  }>(
    `SELECT v.id::text, v.title, v.status::text, v.status_detail, v.ingested_at::text,
            CASE WHEN v.status = 'ready' THEN
              (SELECT count(*)::text FROM transcript_words w
               JOIN transcripts t ON t.id = w.transcript_id
               WHERE t.video_id = v.id)
            END AS n_words
     FROM videos v
     WHERE v.status::text NOT IN ('ready', 'failed')
        OR (v.status::text = 'failed' AND v.ingested_at > now() - interval '1 day')
        OR (v.status::text = 'ready' AND v.ingested_at > now() - interval '1 day')
     ORDER BY (v.status::text = 'ready') ASC, v.ingested_at DESC LIMIT 20`,
  );
  return NextResponse.json({ items: rows });
}
