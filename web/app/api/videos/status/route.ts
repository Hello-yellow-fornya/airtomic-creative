import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Live processing state for the library's queue — polled by the client.
 * Stage comes from real status/status_detail; no invented percentages. */
export async function GET() {
  const rows = await q<{
    id: string; title: string | null; status: string; status_detail: string | null;
    ingested_at: string;
  }>(
    `SELECT id::text, title, status::text, status_detail, ingested_at::text
     FROM videos
     WHERE status NOT IN ('ready', 'failed')
        OR (status = 'failed' AND ingested_at > now() - interval '1 day')
     ORDER BY ingested_at DESC LIMIT 20`,
  );
  return NextResponse.json({ items: rows });
}
