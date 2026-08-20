import { q } from "@/lib/db";
import { Topbar } from "../ui";
import ClipsTable from "./ClipsTable";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
  const rows = await q<{
    clip_id: string;
    clip_name: string | null;
    video_title: string | null;
    video_source: string;
    source_in_s: string;
    source_out_s: string;
    variant_id: string;
    label: string;
    variant_name: string;
    slug: string;
    status: string;
    export_uri: string | null;
    render_status: string | null;
    render_error: string | null;
    rendered_ratios: string[] | null;
  }>(`
    SELECT c.id::text AS clip_id, c.name AS clip_name, v.title AS video_title,
           v.source::text AS video_source,
           c.source_in_s::text, c.source_out_s::text,
           cv.id::text AS variant_id, cv.label, cv.name AS variant_name,
           cv.slug, cv.status::text, cv.export_uri,
           j.status::text AS render_status, j.error AS render_error,
           rr.ratios AS rendered_ratios
    FROM clips c
    JOIN videos v ON v.id = c.video_id
    JOIN clip_variants cv ON cv.clip_id = c.id
    LEFT JOIN LATERAL (
      SELECT status, error FROM jobs
      WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
      ORDER BY id DESC LIMIT 1
    ) j ON true
    LEFT JOIN LATERAL (
      -- ratios whose LATEST render job finished — these files exist in R2
      SELECT array_agg(ratio) AS ratios FROM (
        SELECT DISTINCT ON (payload->>'ratio')
               payload->>'ratio' AS ratio, status
        FROM jobs
        WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
        ORDER BY payload->>'ratio', id DESC
      ) latest WHERE latest.status = 'done'
    ) rr ON true
    ORDER BY c.created_at DESC, cv.label`);

  return (
    <>
      <Topbar
        title="Clip builder"
        sub="Each variant is one ad. Finished renders play here and download under their ad name, with an .srt sidecar."
      />
      <section className="screen">
        <h2 className="sec">Clips</h2>
        <ClipsTable
          rows={rows.map((r) => ({
            clipId: r.clip_id,
            clipName: r.clip_name,
            videoTitle: r.video_title,
            videoSource: r.video_source,
            inS: parseFloat(r.source_in_s),
            outS: parseFloat(r.source_out_s),
            variantId: r.variant_id,
            label: r.label,
            variantName: r.variant_name,
            slug: r.slug,
            status: r.status,
            renderStatus: r.render_status,
            renderError: r.render_error,
            ratios: r.rendered_ratios ?? [],
          }))}
        />
      </section>
    </>
  );
}
