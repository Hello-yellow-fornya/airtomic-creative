import { pool } from "@/lib/db";

/** Library browsing: one query powering both the page and /api/library —
 * search (name, creative-tag values, transcript tsvector), filter chips,
 * sortable columns, and offset pagination with a window-total.
 *
 * Search is server-side: transcript matching uses the tsv column on
 * transcript_segments (websearch_to_tsquery), so "layering" finds the
 * video where the word is SAID. Each row carries its match reason.
 *
 * Performance joins go through video_meta_links (not videos.meta_video_id)
 * so merged duplicates keep their spend attached. */

export type LibraryParams = {
  q?: string;
  status?: "ready" | "processing" | "failed";
  rendition?: string;         // 9x16 | 1x1 | 4x5 …
  dateFrom?: string;          // YYYY-MM-DD, first ad use
  dateTo?: string;
  dupes?: boolean;            // the "Find duplicates" action, not a chip
  source?: "longform" | "ad_creative";  // tabs above the grid
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;              // 1-based
  per?: number;
};

export type LibraryRow = {
  id: string; title: string | null; source: string; status: string;
  status_detail: string | null; has_audio: boolean | null;
  duration_s: string | null; ingested_at: string;
  n_words: string; n_scenes: string; n_cuts: string;
  kf_scene: string | null;
  spend: string | null; first_use: string | null;
  renditions: string[] | null; stages: string[] | null;
  hash_copies: string; name_copies: string;
  content_hash: string | null; name_key: string | null;
  match_reason: string | null;
  error_detail: string | null;
};

/** Duplicate-name key: strip a trailing file extension, then a " (N)" copy
 * suffix, so "Hook A.mp4", "Hook A (1).mp4" and "Hook A (2)" all group. */
const NAME_KEY = `regexp_replace(
  regexp_replace(coalesce(v2.title, v2.id::text), '\\.[A-Za-z0-9]{2,5}$', ''),
  '\\s*\\(\\d+\\)$', '')`;

const SORTS: Record<string, string> = {
  ingested: "v.ingested_at",
  name: "coalesce(v.title, '')",
  duration: "v.duration_s",
  words: "coalesce(w.n_words, 0)",
  scenes: "coalesce(sc.n_scenes, 0)",
  spend: "coalesce(pf.spend, 0)",
  status: "v.status::text",
  first_use: "pf.first_use",
};

export async function runLibrary(p: LibraryParams): Promise<{
  rows: LibraryRow[]; total: number; page: number; per: number;
}> {
  const per = Math.min(Math.max(p.per ?? 48, 1), 100);
  const page = Math.max(p.page ?? 1, 1);
  const args: unknown[] = [];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };

  const where: string[] = [];
  let matchReason = "NULL::text";

  if (p.q?.trim()) {
    const like = arg(`%${p.q.trim()}%`);
    const tsq = arg(p.q.trim());
    const nameM = `(v.title ILIKE ${like})`;
    const tagM = `EXISTS (SELECT 1 FROM creative_tags ct WHERE ct.video_id = v.id
                   AND (ct.universal::text ILIKE ${like} OR ct.brand::text ILIKE ${like}))`;
    const txM = `EXISTS (SELECT 1 FROM transcripts t
                   JOIN transcript_segments s ON s.transcript_id = t.id
                   WHERE t.video_id = v.id
                   AND s.tsv @@ websearch_to_tsquery('english', ${tsq}))`;
    const adM = `EXISTS (SELECT 1 FROM video_meta_links l2
                   JOIN ad_performance ap2 ON ap2.meta_video_id = l2.meta_video_id
                   WHERE l2.video_id = v.id
                   AND (ap2.ad_name ILIKE ${like} OR ap2.name_parts::text ILIKE ${like}))`;
    where.push(`(${nameM} OR ${tagM} OR ${txM} OR ${adM})`);
    matchReason = `CASE WHEN ${nameM} THEN 'name'
                        WHEN ${tagM} THEN 'tags'
                        WHEN ${txM} THEN 'transcript'
                        WHEN ${adM} THEN 'ad name' END`;
  }

  if (p.status === "ready") where.push("v.status = 'ready'");
  else if (p.status === "failed") where.push("v.status = 'failed'");
  else if (p.status === "processing")
    where.push("v.status IN ('queued','transcribing','detecting','tagging')");

  if (p.rendition) where.push(`${arg(p.rendition)} = ANY(pf.renditions)`);
  if (p.dateFrom) where.push(`pf.first_use >= ${arg(p.dateFrom)}::date`);
  if (p.dateTo) where.push(`pf.first_use <= ${arg(p.dateTo)}::date`);
  if (p.source) where.push(`v.source = ${arg(p.source)}::video_source`);
  if (p.dupes) where.push("(d.hash_copies > 1 OR d.name_copies > 1)");

  const sortCol = SORTS[p.sort ?? "ingested"] ?? SORTS.ingested;
  const dir = p.dir === "asc" ? "ASC" : "DESC";
  const off = (page - 1) * per;

  const sql = `
    WITH pf AS (
      SELECT l.video_id,
             sum(ap.spend) AS spend,
             min((ap.name_parts->'ad'->>'date_start')::date) AS first_use,
             array_remove(array_agg(DISTINCT ap.name_parts->'video'->>'rendition'), NULL) AS renditions,
             array_remove(array_agg(DISTINCT ap.name_parts->'ad'->>'funnel_stage'), NULL) AS stages
      FROM video_meta_links l
      JOIN ad_performance ap ON ap.meta_video_id = l.meta_video_id
      GROUP BY l.video_id
    ),
    w AS (
      SELECT t.video_id, count(tw.id) AS n_words
      FROM transcripts t JOIN transcript_words tw ON tw.transcript_id = t.id
      GROUP BY t.video_id
    ),
    sc AS (
      SELECT video_id, count(*) AS n_scenes,
             (array_agg(id ORDER BY idx) FILTER (WHERE keyframe_uri IS NOT NULL))[1] AS kf_scene
      FROM scenes GROUP BY video_id
    ),
    d AS (
      SELECT v2.id,
             CASE WHEN v2.content_hash IS NULL THEN 1
                  ELSE count(*) OVER (PARTITION BY v2.content_hash) END AS hash_copies,
             ${NAME_KEY} AS name_key,
             count(*) OVER (PARTITION BY ${NAME_KEY}) AS name_copies
      FROM videos v2
    )
    SELECT v.id::text, v.title, v.source::text, v.status::text, v.status_detail,
           v.has_audio, v.duration_s::text, v.ingested_at::text,
           v.content_hash,
           coalesce(w.n_words, 0)::text AS n_words,
           coalesce(sc.n_scenes, 0)::text AS n_scenes,
           (SELECT count(*) FROM clip_candidates c
            WHERE c.video_id = v.id AND c.status = 'suggested')::text AS n_cuts,
           sc.kf_scene::text,
           pf.spend::text, pf.first_use::text, pf.renditions, pf.stages,
           d.hash_copies::text,
           d.name_copies::text, d.name_key,
           ${matchReason} AS match_reason,
           CASE WHEN v.status = 'failed' THEN v.status_detail END AS error_detail,
           count(*) OVER () AS _total
    FROM videos v
    LEFT JOIN pf ON pf.video_id = v.id
    LEFT JOIN w ON w.video_id = v.id
    LEFT JOIN sc ON sc.video_id = v.id
    JOIN d ON d.id = v.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${sortCol} ${dir} NULLS LAST, v.id
    LIMIT ${per} OFFSET ${off}`;

  const res = await pool.query(sql, args);
  const total = res.rows.length
    ? parseInt(res.rows[0]._total, 10)
    : await countOnly(where, args);
  return { rows: res.rows as LibraryRow[], total, page, per };
}

/** When the page is past the end, the window total is unavailable —
 * rerun as a bare count with the same filters. */
async function countOnly(where: string[], args: unknown[]): Promise<number> {
  const sql = `
    WITH pf AS (
      SELECT l.video_id, sum(ap.spend) AS spend,
             min((ap.name_parts->'ad'->>'date_start')::date) AS first_use,
             array_remove(array_agg(DISTINCT ap.name_parts->'video'->>'rendition'), NULL) AS renditions,
             array_remove(array_agg(DISTINCT ap.name_parts->'ad'->>'funnel_stage'), NULL) AS stages
      FROM video_meta_links l
      JOIN ad_performance ap ON ap.meta_video_id = l.meta_video_id
      GROUP BY l.video_id
    ),
    d AS (
      SELECT v2.id,
             CASE WHEN v2.content_hash IS NULL THEN 1
                  ELSE count(*) OVER (PARTITION BY v2.content_hash) END AS hash_copies,
             count(*) OVER (PARTITION BY ${NAME_KEY}) AS name_copies
      FROM videos v2
    )
    SELECT count(*)::int AS n FROM videos v
    LEFT JOIN pf ON pf.video_id = v.id
    JOIN d ON d.id = v.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
  const res = await pool.query(sql, args);
  return res.rows[0]?.n ?? 0;
}

export function parseLibraryParams(sp: Record<string, string | string[] | undefined>): LibraryParams {
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const statuses = ["ready", "processing", "failed"] as const;
  const status = statuses.find((x) => x === s("status"));
  return {
    q: s("q"),
    status,
    rendition: s("rendition"),
    dateFrom: s("from"),
    dateTo: s("to"),
    dupes: s("dupes") === "1",
    source: s("source") === "longform" ? "longform"
      : s("source") === "ad_creative" ? "ad_creative" : undefined,
    sort: s("sort"),
    dir: s("dir") === "asc" ? "asc" : "desc",
    page: s("page") ? parseInt(s("page")!, 10) : 1,
    per: s("view") === "list" ? 50 : 48,
  };
}
