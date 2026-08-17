import { q } from "@/lib/db";
import { Topbar } from "../ui";
import ClipsTable from "./ClipsTable";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
  const rows = await q<{
    clip_id: string;
    clip_name: string | null;
    video_title: string | null;
    source_in_s: string;
    source_out_s: string;
    variant_id: string;
    label: string;
    variant_name: string;
    status: string;
    export_uri: string | null;
    render_status: string | null;
    render_error: string | null;
  }>(`
    SELECT c.id::text AS clip_id, c.name AS clip_name, v.title AS video_title,
           c.source_in_s::text, c.source_out_s::text,
           cv.id::text AS variant_id, cv.label, cv.name AS variant_name,
           cv.status::text, cv.export_uri,
           j.status::text AS render_status, j.error AS render_error
    FROM clips c
    JOIN videos v ON v.id = c.video_id
    JOIN clip_variants cv ON cv.clip_id = c.id
    LEFT JOIN LATERAL (
      SELECT status, error FROM jobs
      WHERE type = 'render' AND payload->>'variant_id' = cv.id::text
      ORDER BY id DESC LIMIT 1
    ) j ON true
    ORDER BY c.created_at DESC, cv.label`);

  return (
    <>
      <Topbar
        title="Clip builder"
        sub="Each variant is one ad. Renders land in R2 as exports/<variant>/<ratio>.mp4."
      />
      <section className="screen">
        <h2 className="sec">Clips</h2>
        <ClipsTable
          rows={rows.map((r) => ({
            clipId: r.clip_id,
            clipName: r.clip_name,
            videoTitle: r.video_title,
            inS: parseFloat(r.source_in_s),
            outS: parseFloat(r.source_out_s),
            variantId: r.variant_id,
            label: r.label,
            variantName: r.variant_name,
            status: r.status,
            exportUri: r.export_uri,
            renderStatus: r.render_status,
            renderError: r.render_error,
          }))}
        />
      </section>
    </>
  );
}
