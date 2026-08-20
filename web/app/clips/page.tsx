import { q } from "@/lib/db";
import { Topbar } from "../ui";
import Workbench from "./Workbench";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
  const rows = await q<{
    clip_id: string;
    video_id: string;
    video_title: string | null;
    video_source: string;
    source_in_s: string;
    source_out_s: string;
    variant_id: string;
    label: string;
    variant_name: string;
    slug: string;
    status: string;
    render_stale: boolean;
    render_status: string | null;
    render_error: string | null;
    rendered_ratios: string[] | null;
    kf_scene: string | null;
    n_overlays: string;
  }>(`
    SELECT c.id::text AS clip_id,
           v.id::text AS video_id, v.title AS video_title,
           v.source::text AS video_source,
           c.source_in_s::text, c.source_out_s::text,
           cv.id::text AS variant_id, cv.label, cv.name AS variant_name,
           cv.slug, cv.status::text, cv.render_stale,
           j.status::text AS render_status, j.error AS render_error,
           rr.ratios AS rendered_ratios,
           kf.id::text AS kf_scene,
           (SELECT count(*) FROM clip_overlays co WHERE co.variant_id = cv.id)::text AS n_overlays
    FROM clips c
    JOIN videos v ON v.id = c.video_id
    JOIN clip_variants cv ON cv.clip_id = c.id
    LEFT JOIN LATERAL (
      SELECT status, error FROM jobs
      WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
      ORDER BY id DESC LIMIT 1
    ) j ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(ratio) AS ratios FROM (
        SELECT DISTINCT ON (payload->>'ratio')
               payload->>'ratio' AS ratio, status
        FROM jobs
        WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
        ORDER BY payload->>'ratio', id DESC
      ) latest WHERE latest.status = 'done'
    ) rr ON true
    LEFT JOIN LATERAL (
      -- first-frame thumbnail: the detected scene containing the clip's start
      SELECT s.id FROM scenes s
      WHERE s.video_id = v.id AND s.keyframe_uri IS NOT NULL
        AND s.start_s <= c.source_in_s AND s.end_s > c.source_in_s
      LIMIT 1
    ) kf ON true
    ORDER BY c.created_at DESC, cv.label`);

  const workerUp = !!(process.env.WORKER_URL && process.env.INGEST_TOKEN);

  return (
    <>
      <Topbar
        title="Clip builder"
        sub="Every row is one ad. Click a row to load it in the editor below; ↑↓ move, Enter renames, Space plays."
      />
      <section className="screen">
        <Workbench
          rows={rows.map((r) => ({
            clipId: r.clip_id,
            videoId: r.video_id,
            videoTitle: r.video_title,
            videoSource: r.video_source,
            inS: parseFloat(r.source_in_s),
            outS: parseFloat(r.source_out_s),
            variantId: r.variant_id,
            label: r.label,
            name: r.variant_name,
            slug: r.slug,
            status: r.status,
            renderStale: r.render_stale,
            renderStatus: r.render_status,
            renderError: r.render_error,
            ratios: r.rendered_ratios ?? [],
            kfScene: r.kf_scene,
            nOverlays: parseInt(r.n_overlays, 10),
          }))}
          workerUp={workerUp}
        />
      </section>
    </>
  );
}
